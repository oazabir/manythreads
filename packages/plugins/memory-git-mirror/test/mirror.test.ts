import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConcept, splitConcept } from '@manythreads/shared';
import { startFakeHindsight, type FakeHindsight, type FakeHindsightFact } from '../../../../tools/fake-hindsight/src/server.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// The whole mirror, through the real server: a commit through the repo API, the outbox consumer, the job worker, the real memory-hindsight
// provider and tools/fake-hindsight as the engine. The table of decisions is test/decide.test.ts and test/drain.test.ts; this file proves the wiring:
// a commit under memory/ reaches the bank, the bundle root is written once on first use, and the daily journal is a file of counts and links.

const { nadia, omar } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let fake: FakeHindsight;
let BANK = '';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      const said = w.server.logs.filter((l) => /memory|mirror|"level":(40|50)/.test(l)).slice(-12).map((l) => l.slice(0, 400));
      throw new Error(`timed out waiting for ${what}\n${said.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const facts = (): FakeHindsightFact[] => fake.state.banks.get(BANK) ?? [];
const factWith = (text: string): FakeHindsightFact | undefined => facts().find((f) => f.text.includes(text));
const pendingCount = () => w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_mirror_pending')).rows[0]!.n);
const idle = () => until(async () => ((await pendingCount()) === 0 ? true : null), 'the mirror work list to empty');
const logOf = (path: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ outcome: string; reason: string; document_id: string | null }>(
          "SELECT outcome, reason, document_id FROM app.memory_retain_log WHERE source_kind = 'concept' AND source_id = $1 ORDER BY id",
          [`${ENG}/${path}`],
        )
      ).rows,
  );
const commitsOf = () =>
  w.system(async (tx) => (await tx.query<{ message: string; author_id: string | null }>('SELECT message, author_id FROM app.repo_commits WHERE team_id = $1 ORDER BY committed_at, seq', [ENG])).rows);
const blob = async (path: string): Promise<string | null> => {
  const res = await w.call(nadia, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}&ref=main`);
  return res.status === 200 ? (res.body as { content: string }).content : null;
};
const put = async (path: string, content: string, message: string): Promise<void> => {
  const res = await w.commit(nadia, 'engineering', [{ op: 'put', path, content }], message);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
};
async function enqueue(queue: string, payload: Record<string, unknown> = {}): Promise<void> {
  await w.system(async (tx) => {
    const job = (await tx.query<{ id: string }>('SELECT (app.enqueue_job($1, $2::jsonb, now() + interval \'1 hour\', NULL)).id AS id', [queue, JSON.stringify(payload)])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
    await tx.query("SELECT pg_notify('manythreads_jobs', $1)", [queue]);
  });
}

const concept = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n\n${body}`;

beforeAll(async () => {
  fake = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
  process.env['MANYTHREADS_MIRROR_DEBOUNCE_MS'] = '0';
  process.env['MANYTHREADS_MIRROR_DEFER_MS'] = '300';
  process.env['MANYTHREADS_MIRROR_BACKOFF_MS'] = '300';
  // the feed of messages and pages is not what this file is about: its debounce is the default, so it stays out of the way of the assertions
  w = await createRepoWorld();
  const slug = await w.system(async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.workspaces LIMIT 1')).rows[0]!.slug);
  BANK = `team:${slug}:engineering`;
}, 240_000);

afterAll(async () => {
  for (const name of ['MANYTHREADS_HINDSIGHT_URL', 'MANYTHREADS_MIRROR_DEBOUNCE_MS', 'MANYTHREADS_MIRROR_DEFER_MS', 'MANYTHREADS_MIRROR_BACKOFF_MS']) delete process.env[name];
  await w?.close();
  await fake?.close();
});

describe('a commit under memory/', () => {
  const path = 'memory/decisions/use-postgres.md';
  let documentId = '';

  it('reaches the team’s bank with type, trust tier, origin and tags, and nothing names another bank', async () => {
    await put(path, concept('type: Decision\ntitle: Use Postgres\ntags: [db]\norigin: person', 'We chose Postgres for the Basilisk service because of row level security.\n'), 'Record the database decision');
    const fact = await until(async () => factWith('Basilisk'), 'the concept to be retained');
    expect(fact.metadata).toMatchObject({ source: 'platform', team: 'engineering', feed_kind: 'concept', concept_path: path, concept_type: 'Decision', trust_tier: 'unverified', origin: 'person', actor: nadia.actorId });
    expect(fact.tags).toEqual(['okf', 'kind:concept', 'type:decision', 'trust:unverified', 'status:stable', 'origin:person', 'tag:db']);
    documentId = fact.documentId;
    expect(documentId).toMatch(/^okf:[0-9a-f]{24}:[0-9a-f]{16}$/);
    expect(fake.banksTouched()).toEqual([BANK]);
    await idle();
    expect(await logOf(path)).toMatchObject([{ outcome: 'retained', document_id: documentId }]);
  });

  it('wrote the bundle root once, through the one writer, as the system', async () => {
    const index = await until(async () => blob('memory/index.md'), 'memory/index.md');
    // the bundle root is not a concept (no `type`): its frontmatter is `okf_version` and nothing else
    const split = splitConcept(index);
    expect(split).toMatchObject({ ok: true, frontmatter: 'okf_version: "0.2"\n' });
    expect(await blob('memory/log.md')).toContain('## ');
    // git has the commit a moment before the index row is committed
    await until(async () => ((await commitsOf()).some((c) => c.message === 'Create the team memory bundle') ? true : null), 'the bundle commit in the index');
    const commits = await commitsOf();
    expect(commits.filter((c) => c.message === 'Create the team memory bundle')).toEqual([{ message: 'Create the team memory bundle', author_id: null }]);
    // neither file is a concept: they are not in the bank
    expect(facts().some((f) => f.metadata['concept_path'] === 'memory/index.md' || f.metadata['concept_path'] === 'memory/log.md')).toBe(false);
    // and a second commit under memory/ does not write them again
    await put('memory/facts/second.md', concept('type: Fact', 'The Kestrel keys rotate monthly.\n'), 'Add a fact');
    await until(async () => factWith('Kestrel'), 'the second concept');
    expect((await commitsOf()).filter((c) => c.message === 'Create the team memory bundle')).toHaveLength(1);
  });

  it('an edit replaces it: the old text is gone and the new one is there, under a new document', async () => {
    await put(path, concept('type: Decision\ntitle: Use Postgres\ntags: [db]\norigin: person', 'We chose Postgres for the Basilisk service, and Hindsight sits beside it.\n'), 'Extend the decision');
    await until(async () => factWith('Hindsight sits beside'), 'the edited concept');
    await idle();
    expect(factWith('because of row level security')).toBeUndefined();
    const lines = await logOf(path);
    expect(lines.map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'replaced'], ['retained', '']]);
    expect(lines[0]!.document_id).toBe(documentId);
    expect(facts().filter((f) => f.metadata['concept_path'] === path)).toHaveLength(1);
  });

  it('`status: deprecated` forgets it; deleting the file forgets the other', async () => {
    await put(path, concept('type: Decision\ntitle: Use Postgres\nstatus: deprecated', 'We chose Postgres for the Basilisk service, and Hindsight sits beside it.\n'), 'Deprecate the decision');
    await until(async () => (factWith('Hindsight sits beside') ? null : true), 'the deprecated concept to be forgotten');
    await idle();
    expect((await logOf(path)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deprecated' });

    const res = await w.commit(nadia, 'engineering', [{ op: 'delete', path: 'memory/facts/second.md' }], 'Remove the fact');
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => (factWith('Kestrel') ? null : true), 'the deleted concept to be forgotten');
    await idle();
    expect((await logOf('memory/facts/second.md')).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });

  it('a file that is not a concept is withheld with its reason and never retained', async () => {
    await put('memory/facts/notes.md', '# Just notes, no frontmatter\n\nThe Peregrine deadline is Monday.\n', 'Add loose notes');
    await until(async () => ((await logOf('memory/facts/notes.md')).length > 0 ? true : null), 'the withheld line');
    await idle();
    expect(await logOf('memory/facts/notes.md')).toMatchObject([{ outcome: 'withheld', reason: expect.stringContaining('okf_invalid') }]);
    expect(factWith('Peregrine')).toBeUndefined();
  });
});

describe('the daily journal', () => {
  const YESTERDAY = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
  const SOURCE_TEXT = 'The Goshawk budget is confidential until Friday.';

  it('is a file of counts and source links for the day, written once, and itself mirrored into the bank', async () => {
    // what the day's feed did, as the log has it (yesterday): two messages retained, one run retained, one withheld; a retained message later forgotten
    await w.system(async (tx) => {
      const base = (kind: string, id: string, outcome: string, link: string, reason = '') =>
        tx.query(
          `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason, link, created_at, document_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
          [omar.workspaceId, ENG, BANK, kind, id, outcome, reason, link, `${YESTERDAY}T10:00:00Z`, outcome === 'retained' || outcome === 'forgotten' ? `feed:${kind}:${id}:abc` : null],
        );
      await base('message', 'm1', 'retained', '/t/engineering/c/dev?message=m1');
      await base('message', 'm2', 'retained', '/t/engineering/c/dev?message=m2');
      await base('message', 'm2', 'forgotten', '/t/engineering/c/dev?message=m2', 'deleted');
      await base('run', 'r1', 'retained', '/t/engineering/bots/coder');
      await base('run', 'r2', 'withheld', '/t/engineering/bots/secret-bot', 'person_source');
    });

    await enqueue('memory-git-mirror.journal'); // the cron's job: finds the teams, queues one journal each
    const journal = await until(async () => blob(`memory/journal/${YESTERDAY}.md`), 'the journal file', 60_000);
    const parsed = parseConcept(journal);
    expect(parsed).toMatchObject({
      ok: true,
      frontmatter: { type: 'Journal', title: `Journal ${YESTERDAY}`, origin: 'journal', generated: { by: 'process:journal' } },
    });
    expect(journal).toContain('| message | 2 | 1 | 0 |');
    expect(journal).toContain('| bot run | 1 | 0 | 1 |');
    expect(journal).toContain('/t/engineering/c/dev?message=m1');
    expect(journal).toContain('/t/engineering/bots/coder');
    // a forgotten source has no link; a withheld source is counted and never linked, with no reason
    expect(journal).not.toContain('message=m2');
    expect(journal).not.toContain('secret-bot');
    expect(journal).not.toContain('person_source');
    expect(journal).not.toContain(SOURCE_TEXT);

    await until(async () => ((await commitsOf()).some((c) => c.message === `Journal ${YESTERDAY}`) ? true : null), 'the journal commit in the index');
    const author = (await commitsOf()).filter((c) => c.message === `Journal ${YESTERDAY}`);
    expect(author).toEqual([{ message: `Journal ${YESTERDAY}`, author_id: null }]);

    // the journal is a commit under memory/ like any other: the mirror retains it as type Journal
    const fact = await until(async () => facts().find((f) => f.metadata['concept_path'] === `memory/journal/${YESTERDAY}.md`), 'the journal in the bank');
    expect(fact.metadata).toMatchObject({ concept_type: 'Journal', origin: 'journal' });
    expect(fact.tags).toContain('type:journal');
    await idle();

    // run again: the file exists, nothing is written
    await enqueue('memory-git-mirror.journal');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await commitsOf()).filter((c) => c.message === `Journal ${YESTERDAY}`)).toHaveLength(1);
  });

  it('writes nothing for a day that left nothing in the log', async () => {
    await enqueue('memory-git-mirror.journal-team', { workspaceId: omar.workspaceId, teamId: ENG, date: '2001-01-01' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await blob('memory/journal/2001-01-01.md')).toBeNull();
  });

  it('refuses a day that is not over or not a day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const date of [today, '2026-13-45', '../x']) {
      await enqueue('memory-git-mirror.journal-team', { workspaceId: omar.workspaceId, teamId: ENG, date });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await blob(`memory/journal/${today}.md`)).toBeNull();
  });
});
