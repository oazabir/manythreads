import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConcept } from '@manythreads/shared';
import { createGitLayer } from '../src/git/index.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from './world.ts';

// PLAN P5-25: the repo writer is the OKF bundle's one writer. It validates every `memory/**` concept, stamps a person's edit with `generated` and a
// `verified` entry (a bot's gets `process:platform` only when it carries no `generated`), and regenerates the bundle's `index.md` files and `log.md`
// deterministically in the same commit. `inbox/` and `channels/` are refused. The frontmatter index (`memory_concepts`) is filled by the memory
// plugin's subscriber, tested in packages/plugins/memory.

const { omar, nadia } = personas;
const eng = TEAM_IDS.Engineering;
const git = createGitLayer();
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const put = (path: string, content: string) => ({ op: 'put' as const, path, content });
const head = async (): Promise<string | null> => git.resolve(w.gitDir(eng), 'main');
const blob = (path: string) => w.call(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=main`);
const blobText = async (path: string): Promise<string> => {
  const res = await blob(path);
  return res.status === 200 ? (res.body as { content: string }).content : '';
};
const parsed = async (path: string) => parseConcept(await blobText(path));

const ONBOARDING = '---\ntype: Fact\ntitle: Onboarding\ndescription: How we onboard a new teammate.\ntags: [people]\n---\n\nAsk for a buddy.\n';

describe('the writer stamps a person’s concept and regenerates the bundle (P5-25)', () => {
  it('stamps generated + verified and writes the index and log in the same commit', async () => {
    const res = await w.commit(nadia, 'engineering', [put('memory/facts/onboarding.md', ONBOARDING)], 'File a fact');
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const stored = await parsed('memory/facts/onboarding.md');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.frontmatter.generated).toEqual({ by: `human:${nadia.actorId}`, at: stored.frontmatter.generated?.at });
    expect(stored.frontmatter.verified).toEqual([{ by: `human:${nadia.actorId}`, at: stored.frontmatter.generated?.at }]);
    expect(stored.frontmatter.generated?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await blobText('memory/index.md')).toContain('okf_version: "0.2"');
    expect(await blobText('memory/facts/index.md')).toContain('* [Onboarding](onboarding.md) - How we onboard a new teammate.');
    expect(await blobText('memory/log.md')).toContain('Update: [Onboarding](/facts/onboarding.md)');

    // the commit event / response names the concept and the regenerated files
    const paths = (res.body as unknown as { paths: { path: string; op: string }[] }).paths.map((p) => p.path).sort();
    expect(paths).toEqual(['memory/facts/index.md', 'memory/facts/onboarding.md', 'memory/index.md', 'memory/log.md']);
  });

  it('the platform owns index.md and log.md: a write to one is thrown away by the regeneration', async () => {
    const res = await w.commit(nadia, 'engineering', [put('memory/index.md', '---\nokf_version: "0.2"\n---\n\nhacked\n')], 'hack the index');
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const root = await blobText('memory/index.md');
    expect(root).not.toContain('hacked');
    expect(root).toContain('# Team memory');
    // the writer re-rendered the same bytes that were already committed, so there is nothing to write
    expect((res.body as unknown as { paths: unknown[] }).paths).toEqual([]);
  });

  it('a bot’s concept gets process:platform only when it carries none, and never overwrites a producer’s', async () => {
    const bot = await w.makeBot(eng);
    const svc = w.replica({ now: () => new Date('2026-10-14T09:00:00Z') });
    await w.as(bot, (tx) => svc.write(tx, eng, { id: bot.actorId, kind: 'bot' }, [put('memory/facts/bot-note.md', '---\ntype: Fact\ntitle: Bot note\n---\nbody\n')], 'bot note'));
    const stamped = await parsed('memory/facts/bot-note.md');
    expect(stamped.ok && stamped.frontmatter.generated).toEqual({ by: 'process:platform', at: '2026-10-14T09:00:00.000Z' });

    const withProducer = '---\ntype: Fact\ntitle: Bot note\ngenerated:\n  by: archivist/v1\n  at: 2026-01-01T00:00:00Z\n---\nbody\n';
    await w.as(bot, (tx) => svc.write(tx, eng, { id: bot.actorId, kind: 'bot' }, [put('memory/facts/bot-note.md', withProducer)], 'again'));
    const kept = await parsed('memory/facts/bot-note.md');
    expect(kept.ok && kept.frontmatter.generated).toEqual({ by: 'archivist/v1', at: '2026-01-01T00:00:00Z' });
  });

  it('deleting the last concept of a directory deletes its index; the root and log stay', async () => {
    expect((await w.commit(nadia, 'engineering', [put('memory/knowledge/rate-limits.md', '---\ntype: Fact\ntitle: Rate limits\n---\nbody\n')], 'add')).status).toBe(201);
    expect((await blob('memory/knowledge/index.md')).status).toBe(200);
    expect((await w.commit(nadia, 'engineering', [{ op: 'delete', path: 'memory/knowledge/rate-limits.md' }], 'remove')).status).toBe(201);
    expect((await blob('memory/knowledge/index.md')).status).toBe(404);
    expect((await blob('memory/index.md')).status).toBe(200);
    expect((await blob('memory/log.md')).status).toBe(200);
  });

  it('regeneration is a pure function of the tree: the same concepts render the same index and log bytes', async () => {
    const indexA = await blobText('memory/facts/index.md');
    const logA = await blobText('memory/log.md');
    // a no-op commit for the memory tree (an unrelated page) leaves both untouched
    expect((await w.commit(nadia, 'engineering', [put('pages/unrelated.md', '# Unrelated\n')], 'a page')).status).toBe(201);
    expect(await blobText('memory/facts/index.md')).toBe(indexA);
    expect(await blobText('memory/log.md')).toBe(logA);
  });
});

describe('the writer refuses what is not a concept (P5-25)', () => {
  it('a memory file without valid OKF frontmatter is okf_invalid, naming the file, and nothing is committed', async () => {
    const before = await head();
    const res = await w.commit(nadia, 'engineering', [put('memory/facts/bad.md', '---\ntitle: no type here\n---\nbody\n')], 'bad concept');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'okf_invalid' } });
    expect((res.body as unknown as { error: { message: string } }).error.message).toContain('memory/facts/bad.md');
    expect(await head()).toBe(before);
    expect((await blob('memory/facts/bad.md')).status).toBe(404);
  });

  it('inbox/ is Files storage, never a repository folder', async () => {
    const res = await w.commit(nadia, 'engineering', [put('inbox/drop.md', 'x\n')], 'inbox');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
  });
});
