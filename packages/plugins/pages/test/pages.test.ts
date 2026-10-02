import { GetRepoHistoryResponse, KernelCapabilityDeniedEvent, RepoConflictResponse, WritePageResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type Bot, type RepoWorld } from '../../repo-git/test/world.ts';

// pages.write (PLAN P4-07, criterion 3 and 5): create, replace and append make one commit each with the caller as author and a linear history; the four
// guarded paths are 403 for everybody (audited for a bot); only text under pages/; conflicts carry the current content.

const { omar, nadia, priya, sameera, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const write = (who: Parameters<RepoWorld['call']>[0], body: Record<string, unknown>, slug = 'engineering') => w.call(who, 'POST', `/api/teams/${slug}/pages/write`, body);
const page = (path: string, mode: string, content: string, extra: Record<string, unknown> = {}) => ({ mode, path, content, ...extra });
const read = async (who: typeof omar, path: string, ref = 'main') => w.call<{ content: string; blobSha: string }>(who, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=${ref}`);
const log = async (path = '') => GetRepoHistoryResponse.parse((await w.call(omar, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}&limit=100`)).body).commits;
const ok = <T>(res: { status: number; body: unknown }, status = 201): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};

describe('create, replace, append', () => {
  const P = 'pages/reports/week-37.md';
  let created = '';

  it('create writes one commit with the caller as author; creating it again is a 409 carrying the current content', async () => {
    const res = WritePageResponse.parse(ok(await write(nadia, page(P, 'create', '# Week 37\n'))));
    expect(res).toMatchObject({ path: P, mode: 'create', noop: false, authorId: nadia.actorId, size: 10 });
    created = res.sha;
    const entries = await log(P);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sha: created, subject: `Create page ${P}`, authorId: nadia.actorId, authorName: 'Nadia' });
    expect((await read(omar, P)).body.content).toBe('# Week 37\n');

    const again = await write(priya, page(P, 'create', 'other'));
    expect(again.status).toBe(409);
    const conflict = RepoConflictResponse.parse(again.body);
    expect(conflict.conflicts[0]).toMatchObject({ path: P, reason: 'exists', currentContent: '# Week 37\n' });
    expect((await read(omar, P)).body.content).toBe('# Week 37\n');
  });

  it('replace swaps the whole page; with a base it is refused (409, current content) when the page moved on', async () => {
    const blob = (await read(omar, P)).body.blobSha;
    const first = WritePageResponse.parse(ok(await write(priya, page(P, 'replace', '# Week 37\n\nall green\n', { baseBlobSha: blob, message: 'Fill in the report' }))));
    expect(first.authorId).toBe(priya.actorId);
    const stale = await write(nadia, page(P, 'replace', 'lost update', { baseBlobSha: blob }));
    expect(stale.status).toBe(409);
    expect(RepoConflictResponse.parse(stale.body).conflicts[0]).toMatchObject({ reason: 'changed', currentContent: '# Week 37\n\nall green\n' });
    expect((await read(omar, P)).body.content).toBe('# Week 37\n\nall green\n');
    expect((await log(P))[0]).toMatchObject({ subject: 'Fill in the report', authorId: priya.actorId });
  });

  it('replace without a base creates a missing page; replacing with the same text is a no-op (200, no commit)', async () => {
    const fresh = 'pages/replaced.md';
    expect(WritePageResponse.parse(ok(await write(nadia, page(fresh, 'replace', 'a\n')))).noop).toBe(false);
    const before = (await log()).length;
    const same = WritePageResponse.parse(ok(await write(nadia, page(fresh, 'replace', 'a\n')), 200));
    expect(same).toMatchObject({ noop: true, blobSha: null });
    expect((await log()).length).toBe(before);
  });

  it('append adds to the end (creating the page), and concurrent appends lose nothing', async () => {
    const A = 'pages/journal.md';
    ok(await write(nadia, page(A, 'append', 'one\n')));
    ok(await write(priya, page(A, 'append', 'two\n')));
    expect((await read(omar, A)).body.content).toBe('one\ntwo\n');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => write(i % 2 ? nadia : priya, page(A, 'append', `line ${i}\n`))));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const text = (await read(omar, A)).body.content;
    expect(text.startsWith('one\ntwo\n')).toBe(true);
    for (let i = 0; i < 8; i += 1) expect(text).toContain(`line ${i}\n`);
  });

  it('every write is one commit and the history is linear (each commit has the previous head as its only parent)', async () => {
    const all = await log();
    expect(all.length).toBeGreaterThan(8);
    for (let i = 0; i < all.length - 1; i += 1) expect(all[i]!.parentSha, all[i]!.subject).toBe(all[i + 1]!.sha);
    expect(all[all.length - 1]!.parentSha).toBeNull();
  });
});

describe('where and what', () => {
  it('writes only under pages/: knowledge/, channels/ and the root are 400', async () => {
    for (const path of ['knowledge/base/notes.md', 'README.md', 'channels/dev/x.md', 'memory/facts/f.md']) {
      const res = await write(nadia, page(path, 'create', 'x'));
      expect(res.status, path).toBe(400);
    }
  });

  it('refuses paths that are not paths, bodies that are not exact, and text that is not text', async () => {
    expect((await write(nadia, page('pages/../TEAM.md', 'replace', 'x'))).status).toBe(400);
    expect((await write(nadia, page('/pages/x.md', 'replace', 'x'))).status).toBe(400);
    expect((await write(nadia, page('pages/x.md', 'merge', 'x'))).status).toBe(400);
    expect((await write(nadia, { ...page('pages/x.md', 'create', 'x'), teamId: TEAM_IDS.Marketing })).status).toBe(400);
    const binary = await write(nadia, page('pages/bin.md', 'create', 'a\u0000b'));
    expect(binary.status).toBe(422);
    expect(JSON.stringify(binary.body)).toMatch(/attachment_not_in_repo/);
    // over 1 MB: the HTTP body limit (413) answers before the writer's rule (422); either way nothing is written
    expect([413, 422]).toContain((await write(nadia, page('pages/big.md', 'create', 'x'.repeat(1_048_577)))).status);
    expect((await read(omar, 'pages/big.md')).status).toBe(404);
    expect((await read(omar, 'pages/bin.md')).status).toBe(404);
  });

  it('the four guarded paths are 403 for everyone, pages.write is not the way to change them (Priya: by pull request; Omar too)', async () => {
    for (const path of ['bots/coder/BOT.md', 'TEAM.md', 'skills/triage/SKILL.md', 'routines/nightly.yaml']) {
      for (const who of [priya, omar, nadia]) {
        const res = await write(who, page(path, 'replace', 'x'));
        expect(res.status, `${who.name} ${path}`).toBe(403);
        expect((res.body as { error: { message: string } }).error.message).toMatch(/pull request/i);
      }
    }
    expect((await read(omar, 'bots/coder/BOT.md')).status).toBe(404);
  });

  it('team access: Sameera (another team) and Lena (guest) 403, nobody 401; Priya writes in Marketing, where she is a member', async () => {
    expect((await write(sameera, page('pages/x.md', 'create', 'x'))).status).toBe(403);
    expect((await write(lena, page('pages/x.md', 'create', 'x'))).status).toBe(403);
    expect((await write(null, page('pages/x.md', 'create', 'x'))).status).toBe(401);
    expect((await write(nadia, page('pages/x.md', 'create', 'x'), 'marketing')).status).toBe(403);
    expect(WritePageResponse.parse(ok(await write(priya, page('pages/launch.md', 'create', '# Launch\n'), 'marketing'))).authorId).toBe(priya.actorId);
    expect((await write(omar, page('pages/x.md', 'create', 'x'), 'no-such-team')).status).toBe(404);
  });
});

describe('a bot', () => {
  let bot: Bot;
  let onlyFiles: Bot;
  beforeAll(async () => {
    bot = await w.makeBot(TEAM_IDS.Engineering, ['pages.write']);
    onlyFiles = await w.makeBot(TEAM_IDS.Engineering, ['files.write']);
  });
  const denials = async (b: Bot) =>
    (
      await w.system(async (tx) =>
        (await tx.query<{ payload: Record<string, unknown>; workspace_id: string }>(
          "SELECT payload, workspace_id FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 ORDER BY id",
          [b.actorId],
        )).rows,
      )
    ).map((r) => KernelCapabilityDeniedEvent.parse({ ...r.payload, type: 'kernel.capability.denied', schemaVersion: 1, workspaceId: r.workspace_id }));

  it('with only pages.write it writes pages/x.md as the bot (no files.write needed)', async () => {
    const res = WritePageResponse.parse(ok(await write(bot, page('pages/answers/q1.md', 'create', 'The answer.\n', { message: 'Save answer' }))));
    expect(res.authorId).toBe(bot.actorId);
    expect((await log('pages/answers/q1.md'))[0]).toMatchObject({ authorId: bot.actorId, subject: 'Save answer' });
  });

  it('the four guarded paths are 403, each denial is audited as kernel.capability.denied for pages.write', async () => {
    const guarded = ['bots/coder/BOT.md', 'TEAM.md', 'skills/triage/SKILL.md', 'routines/nightly.yaml'];
    for (const path of guarded) expect((await write(bot, page(path, 'replace', 'x'))).status, path).toBe(403);
    const seen = await denials(bot);
    expect(seen.map((d) => d.path)).toEqual(guarded);
    expect(new Set(seen.map((d) => d.capability))).toEqual(new Set(['pages.write']));
    expect(seen.every((d) => d.actorKind === 'bot')).toBe(true);
    for (const path of guarded) expect((await read(omar, path)).status === 404 || path === 'TEAM.md').toBe(true);
    // TEAM.md is still the template's
    expect((await read(omar, 'TEAM.md')).body.content).not.toBe('x');
  });

  it('a bot with files.write but no pages.write grant is denied (and audited)', async () => {
    const res = await write(onlyFiles, page('pages/y.md', 'create', 'y'));
    expect(res.status).toBe(403);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/no grant for "pages\.write"/);
    expect((await denials(onlyFiles)).map((d) => d.path)).toEqual(['pages/y.md']);
    expect((await read(omar, 'pages/y.md')).status).toBe(404);
  });
});
