import { createSystemPool, withActor, withSystem, createAppPool, type Tx } from '@manythreads/kernel';
import type { InboxDistillResult, InboxDistiller, JobInfo, PluginContext } from '@manythreads/sdk';
import type { OkfProposal } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryInboxMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inboxRead } from '../src/capability.ts';
import { commitStep, referenceConcept, validateProposals } from '../src/commit.ts';
import { DEFAULT_INBOX_CONFIG, readInboxConfig } from '../src/config.ts';
import { keepOriginals, sweep } from '../src/jobs.ts';
import { distilStep, holdVerdict, referencePathOf } from '../src/pipeline.ts';
import { claim } from '../src/states.ts';
import type { ItemRow } from '../src/rows.ts';

// P8-16/P8-17 without a server and without a model: each pipeline step is run by hand against a real database with a stand-in for the platform context, so
// the Archivist's seam (`inbox.distiller`), the validation of what it proposes, the two-at-once rule, idempotency, the sweep and the keeper can be tested
// one at a time.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let sysPool: pg.Pool;
let appPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
let counter = 5000;

// ---- a stand-in context --------------------------------------------------------------------------------------------------------------

interface Enqueued {
  queue: string;
  payload: Record<string, unknown>;
  runAt: Date | undefined;
  dedupeKey: string | undefined;
}
interface Written {
  changes: Array<{ path: string; op: string; content?: string; baseBlobSha?: string | null }>;
  message: string;
  actorKind: string;
  coAuthors: unknown;
}
const enqueued: Enqueued[] = [];
const audits: Array<Record<string, unknown>> = [];
const pushes: Array<{ personId: string; type: string; payload: unknown }> = [];
const written: Written[] = [];
const repoFiles = new Map<string, string>();
let repoWriteStatus: number | null = null;
let distiller: InboxDistiller | undefined;
const deletedBlobs: string[] = [];
let egress: { hooks: number; outcome: string; text: string } = { hooks: 0, outcome: 'allow', text: '' };
const NOW = new Date('2026-11-02T10:00:00Z');

const repo = {
  id: 'repo',
  async blob(_tx: unknown, _team: string, path: string): Promise<{ content: Uint8Array }> {
    const text = repoFiles.get(path);
    if (text === undefined) throw Object.assign(new Error('not found'), { status: 404 });
    return { content: new TextEncoder().encode(text) };
  },
  async write(_tx: unknown, _team: string, actor: { kind: string }, changes: Written['changes'], message: string, coAuthors: unknown): Promise<{ sha: string }> {
    if (repoWriteStatus !== null) throw Object.assign(new Error('refused'), { status: repoWriteStatus });
    written.push({ changes, message, actorKind: actor.kind, coAuthors });
    for (const c of changes) if (c.op === 'put' && c.content !== undefined) repoFiles.set(c.path, c.content);
    return { sha: 'a'.repeat(40) };
  },
};
const storage = {
  id: 'storage',
  async delete(key: string): Promise<boolean> {
    deletedBlobs.push(key);
    return true;
  },
};

const ctx = {
  providers: {
    get: (kind: string): unknown => (kind === 'repo' ? repo : kind === 'storage' ? storage : kind === 'inbox.distiller' ? distiller : undefined),
  },
  jobs: {
    async enqueue(_tx: unknown, queue: string, payload: Record<string, unknown>, opts?: { runAt?: Date; dedupeKey?: string }): Promise<void> {
      enqueued.push({ queue, payload, runAt: opts?.runAt, dedupeKey: opts?.dedupeKey });
    },
  },
  audit: {
    async emit(_tx: unknown, event: Record<string, unknown>): Promise<void> {
      audits.push(event);
    },
  },
  realtime: {
    async pushToPerson(_tx: unknown, personId: string, type: string, payload: unknown): Promise<void> {
      pushes.push({ personId, type, payload });
    },
  },
  hooks: {
    async runPreEgress(): Promise<{ hooks: number; outcome: string; text: string }> {
      return egress;
    },
  },
  runtime: { now: () => NOW },
} as unknown as PluginContext;

const job = {
  transaction: <T>(fn: (tx: never) => Promise<T>): Promise<T> => sys(fn as never),
  log: { warn: () => undefined, info: () => undefined, error: () => undefined },
} as unknown as JobInfo;

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, memoryInboxMigrationSource],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 3);
  appPool = createAppPool(db.appUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  // every test starts with an empty inbox: the two-at-once rule counts what the team's other items are doing
  await sys((tx) => tx.query('DELETE FROM app.memory_inbox_items'));
  enqueued.length = 0;
  audits.length = 0;
  pushes.length = 0;
  written.length = 0;
  repoFiles.clear();
  repoWriteStatus = null;
  distiller = undefined;
  deletedBlobs.length = 0;
  egress = { hooks: 0, outcome: 'allow', text: '' };
});

interface Seed {
  state?: string;
  stage?: string;
  name?: string;
  kind?: string;
  text?: string | null;
  proposals?: OkfProposal[] | null;
  producer?: string | null;
  teamOnly?: boolean;
  team?: string;
  attempts?: number;
  failedStage?: string | null;
  updatedMinutesAgo?: number;
  waitHours?: number;
  blob?: string | null;
  filedDaysAgo?: number;
  filedPaths?: string[];
}
/** An item as it stands when a step starts. The text row exists unless `text: null`. */
async function seed(o: Seed = {}): Promise<ItemRow> {
  counter += 1;
  return sys(async (tx) => {
    const filed = o.filedDaysAgo !== undefined;
    const row = (
      await tx.query<ItemRow>(
        `INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, team_only, attempts, failed_stage, filed_paths, filed_at, updated_at, not_before, commit_sha, hold_reason)
         VALUES ($1, $2, 'person', $3, $4, $5, $6, 40, $7, $8, $9, 'Nadia', $10, $11, $12, $13::text[], CASE WHEN $14::int IS NULL THEN NULL ELSE now() - make_interval(days => $14::int) END,
                 now() - make_interval(mins => $15::int), CASE WHEN $16::int IS NULL THEN NULL ELSE now() + make_interval(hours => $16::int) END,
                 CASE WHEN $3 = 'filed' THEN repeat('b', 40) END, CASE WHEN $3 = 'held' THEN 'review_all' END)
         RETURNING *`,
        [
          omar.workspaceId,
          o.team ?? ENG,
          o.state ?? 'filing',
          o.stage ?? 'distil',
          o.kind ?? 'markdown',
          o.name ?? 'Notes.md',
          counter.toString(16).padStart(64, '0'),
          o.blob === undefined ? `blob-${counter}` : o.blob,
          nadia.actorId,
          o.teamOnly ?? false,
          o.attempts ?? 1,
          o.failedStage ?? null,
          o.filedPaths ?? [],
          filed ? o.filedDaysAgo : null,
          o.updatedMinutesAgo ?? 0,
          o.waitHours ?? null,
        ],
      )
    ).rows[0]!;
    if (o.text !== null) {
      await tx.query(`INSERT INTO app.memory_inbox_extracts (item_id, team_id, text, title, proposals, producer) VALUES ($1, $2, $3, NULL, $4::jsonb, $5)`, [
        row.id,
        row.team_id,
        o.text ?? 'The deploy window is Tuesday after standup.',
        o.proposals ? JSON.stringify(o.proposals) : null,
        o.producer ?? null,
      ]);
    }
    return row;
  });
}
const reload = (id: string): Promise<ItemRow> => sys(async (tx) => (await tx.query<ItemRow>('SELECT * FROM app.memory_inbox_items WHERE id = $1', [id])).rows[0]!);
const answer = (result: InboxDistillResult | Error): InboxDistiller => ({
  id: 'inbox.distiller',
  async distil(): Promise<InboxDistillResult> {
    if (result instanceof Error) throw result;
    return result;
  },
});
const concept = (path: string, extra: Partial<OkfProposal> = {}): OkfProposal => ({ path, type: 'Fact', title: 'A fact', body: 'The deploy window is Tuesday.', ...extra });

// ---- the hold rules ------------------------------------------------------------------------------------------------------------------

describe('hold rules', () => {
  const facts = (over: Record<string, unknown> = {}) => ({ kind: 'markdown', size: 100, origin: 'person', sender: null, sender_check: null, ...over }) as never;
  const config = (over: Partial<typeof DEFAULT_INBOX_CONFIG> = {}) => ({ ...DEFAULT_INBOX_CONFIG, ...over });

  it('lets an ordinary drop from a member through under the default setting', () => {
    expect(holdVerdict(facts(), config(), false)).toBeNull();
  });
  it('holds a foreign bundle and an oversize item whatever the review setting says', () => {
    for (const review of ['none', 'external', 'all'] as const) {
      expect(holdVerdict(facts({ kind: 'bundle' }), config({ review }), false)?.reason).toBe(review === 'all' ? 'foreign_bundle' : 'foreign_bundle');
      expect(holdVerdict(facts({ size: 5000 }), config({ review, maxBytes: 1000 }), false)?.reason).toBe('oversize');
    }
  });
  it('holds everything when the team reviews all', () => {
    expect(holdVerdict(facts(), config({ review: 'all' }), false)?.reason).toBe('review_all');
  });
  it('holds an email whose sender check failed, and one from a stranger unless the team reviews nothing', () => {
    const email = { origin: 'email', sender: 'stranger@elsewhere.example' };
    expect(holdVerdict(facts({ ...email, sender_check: 'fail' }), config({ review: 'none' }), false)?.reason).toBe('failed_sender_check');
    expect(holdVerdict(facts(email), config(), false)?.reason).toBe('unknown_sender');
    expect(holdVerdict(facts(email), config({ review: 'none' }), false)).toBeNull();
    expect(holdVerdict(facts({ ...email, sender_check: 'pass' }), config(), false)).toBeNull();
  });
  it('lets a named sender or a named domain through', () => {
    const email = (sender: string) => facts({ origin: 'email', sender });
    const cfg = config({ allowEmailFrom: ['ceo@partner.example', '@kahf.example'] });
    expect(holdVerdict(email('CEO@partner.example'), cfg, false)).toBeNull();
    expect(holdVerdict(email('nadia@kahf.example'), cfg, false)).toBeNull();
    expect(holdVerdict(email('x@evilkahf.example'), cfg, false)?.reason).toBe('unknown_sender');
    expect(holdVerdict(email('nadia@kahf.example.evil.test'), cfg, false)?.reason).toBe('unknown_sender');
  });
  it('a lead’s release ends the check', () => {
    expect(holdVerdict(facts({ kind: 'bundle' }), config({ review: 'all' }), true)).toBeNull();
  });
});

describe('the team’s settings', () => {
  const md = (block: string) => `---\nname: Engineering\n${block}---\n\n# Engineering\n`;
  it('reads the block, with defaults for what it does not say', () => {
    expect(readInboxConfig(null)).toMatchObject({ review: 'external', keepOriginals: 'forever', allowEmailFrom: [], unreadable: false });
    expect(readInboxConfig(md('memory:\n  inbox:\n    review: none\n    keepOriginals: 30\n    allowEmailFrom: [a@b.example]\n    maxBytes: 2048\n'))).toMatchObject({
      review: 'none',
      keepOriginals: 30,
      allowEmailFrom: ['a@b.example'],
      maxBytes: 2048,
      unreadable: false,
    });
  });
  it('never lets the team raise the size above what the server allows', () => {
    expect(readInboxConfig(md('memory:\n  inbox:\n    maxBytes: 999999999\n'), 5000).maxBytes).toBe(5000);
  });
  it('reads a block it cannot understand as the strictest answer', () => {
    for (const text of [md('memory:\n  inbox:\n    review: sometimes\n'), md('memory:\n  inbox: nonsense\n'), '---\n[unreadable\n---\n', md('memory:\n  inbox:\n    keepOriginals: -3\n')]) {
      expect(readInboxConfig(text)).toMatchObject({ review: 'all', unreadable: true });
    }
  });
});

// ---- distil --------------------------------------------------------------------------------------------------------------------------

describe('distil step: the Archivist’s seam', () => {
  it('with no Archivist registered, goes on to the commit with nothing proposed', async () => {
    const row = await seed();
    await distilStep(ctx, job, row.id);
    expect(await reload(row.id)).toMatchObject({ state: 'filing', stage: 'commit' });
    expect(enqueued.map((e) => e.queue)).toEqual(['memory-inbox.commit']);
  });

  it('hands the distiller the item as data, with the Reference path it may link to', async () => {
    const row = await seed({ teamOnly: true, name: 'Runbook.md' });
    let seen: Record<string, unknown> = {};
    distiller = {
      id: 'inbox.distiller',
      async distil(_db, input): Promise<InboxDistillResult> {
        seen = { ...input };
        return { outcome: 'none' };
      },
    };
    await distilStep(ctx, job, row.id);
    expect(seen).toMatchObject({ teamId: ENG, itemId: row.id, origin: 'person', kind: 'markdown', name: 'Runbook.md', teamOnly: true, droppedBy: nadia.actorId });
    expect(seen['text']).toBe('The deploy window is Tuesday after standup.');
    expect(seen['referencePath']).toBe(referencePathOf(row, null));
    expect(String(seen['referencePath'])).toMatch(/^memory\/references\/runbook-[0-9a-f]{8}\.md$/);
  });

  it('keeps what a distiller proposes, and who made it, for the commit', async () => {
    const row = await seed();
    distiller = answer({ outcome: 'distilled', producer: 'archivist/engineering', proposals: [concept('memory/facts/deploy-window.md')] });
    await distilStep(ctx, job, row.id);
    expect(await reload(row.id)).toMatchObject({ state: 'filing', stage: 'commit' });
    const stored = await sys(async (tx) => (await tx.query<{ proposals: OkfProposal[]; producer: string }>('SELECT proposals, producer FROM app.memory_inbox_extracts WHERE item_id = $1', [row.id])).rows[0]!);
    expect(stored.producer).toBe('archivist/engineering');
    expect(stored.proposals.map((p) => p.path)).toEqual(['memory/facts/deploy-window.md']);
    expect(enqueued.map((e) => e.queue)).toEqual(['memory-inbox.commit']);
  });

  it('refuses an answer that does not say who it is, and drops proposals that are not proposals', async () => {
    const anon = await seed();
    distiller = answer({ outcome: 'distilled', producer: 'nobody', proposals: [concept('memory/x.md')] });
    await distilStep(ctx, job, anon.id);
    expect(await reload(anon.id)).toMatchObject({ state: 'failed', failed_stage: 'distil' });
    const junk = await seed();
    distiller = answer({ outcome: 'distilled', producer: 'archivist/engineering', proposals: [concept('memory/ok.md'), { nope: true } as never] });
    await distilStep(ctx, job, junk.id);
    const stored = await sys(async (tx) => (await tx.query<{ proposals: OkfProposal[] }>('SELECT proposals FROM app.memory_inbox_extracts WHERE item_id = $1', [junk.id])).rows[0]!);
    expect(stored.proposals).toHaveLength(1);
  });

  it('an Archivist whose budget is used up leaves the item queued with the reason and a time to look again', async () => {
    const row = await seed();
    distiller = answer({ outcome: 'budget', message: 'The Archivist has used its budget for today. This is tried again later.', retryAfterSeconds: 3600 });
    await distilStep(ctx, job, row.id);
    const after = await reload(row.id);
    expect(after).toMatchObject({ state: 'queued', stage: 'distil', reason: expect.stringContaining('budget') });
    expect(after.not_before).not.toBeNull();
    expect(after.not_before!.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ queue: 'memory-inbox.distil' });
    expect(enqueued[0]!.runAt).toBeInstanceOf(Date);
    expect(pushes.map((p) => (p.payload as { state: string }).state)).toEqual(['queued']);
    // asked again before the time is up, the step waits: it neither runs the distiller nor loses the item
    let calls = 0;
    distiller = {
      id: 'inbox.distiller',
      async distil(): Promise<InboxDistillResult> {
        calls += 1;
        return { outcome: 'none' };
      },
    };
    await distilStep(ctx, job, row.id);
    expect(calls).toBe(0);
    expect(await reload(row.id)).toMatchObject({ state: 'queued', stage: 'distil' });
  });

  it('a failed run fails the item at the distil step with the reason; so does a distiller that throws', async () => {
    const failed = await seed();
    distiller = answer({ outcome: 'failed', message: 'The Archivist could not make sense of this.' });
    await distilStep(ctx, job, failed.id);
    expect(await reload(failed.id)).toMatchObject({ state: 'failed', failed_stage: 'distil', reason: 'The Archivist could not make sense of this.' });
    const thrown = await seed();
    distiller = answer(new Error('boom: secret internals'));
    await distilStep(ctx, job, thrown.id);
    const after = await reload(thrown.id);
    expect(after).toMatchObject({ state: 'failed', failed_stage: 'distil', reason: 'The Archivist stopped before it finished.' });
    expect(after.reason).not.toContain('boom');
    expect(audits.filter((a) => a['type'] === 'memory.item.failed').map((a) => a['stage'])).toEqual(['distil', 'distil']);
  });

  it('is safe to run twice: the second run finds the item moved on and does nothing', async () => {
    const row = await seed();
    await distilStep(ctx, job, row.id);
    await distilStep(ctx, job, row.id);
    expect(enqueued.filter((e) => e.queue === 'memory-inbox.commit')).toHaveLength(1);
  });

  it('goes back to reading the original when the working copy of the text is gone', async () => {
    const row = await seed({ text: null });
    await distilStep(ctx, job, row.id);
    expect(await reload(row.id)).toMatchObject({ state: 'queued', stage: 'extract' });
    expect(enqueued.map((e) => e.queue)).toEqual(['memory-inbox.extract']);
  });

  it('leaves a discarded item alone', async () => {
    const row = await seed({ state: 'discarded', stage: 'distil' });
    distiller = answer({ outcome: 'failed', message: 'should not run' });
    await distilStep(ctx, job, row.id);
    expect((await reload(row.id)).state).toBe('discarded');
  });
});

// ---- two at once ---------------------------------------------------------------------------------------------------------------------

describe('two at once per team', () => {
  it('lets a third item of a team wait while two are being worked on, then take its turn', async () => {
    const a = await seed({ state: 'filing', stage: 'commit' });
    const b = await seed({ state: 'extracting', stage: 'extract' });
    const c = await seed({ state: 'queued', stage: 'extract' });
    const waited = await sys((tx) => claim(ctx, tx as never, c.id, 'extract', 'extracting'));
    expect(waited.kind).toBe('wait');
    expect(await reload(c.id)).toMatchObject({ state: 'queued' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ queue: 'memory-inbox.extract' });
    // one finishes: the third is let in and marked as running with one more try
    await sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'filed', stage = 'done', commit_sha = repeat('c', 40), filed_at = now() WHERE id = $1`, [a.id]));
    const go = await sys((tx) => claim(ctx, tx as never, c.id, 'extract', 'extracting'));
    expect(go.kind).toBe('go');
    const running = await reload(c.id);
    expect(running).toMatchObject({ state: 'extracting' });
    expect(running.attempts).toBe(c.attempts + 1);
    // another team is not held back by this team's two
    const other = await seed({ team: TEAM_IDS['Customer support'], state: 'queued', stage: 'extract' });
    expect((await sys((tx) => claim(ctx, tx as never, other.id, 'extract', 'extracting'))).kind).toBe('go');
    void b;
  });

  it('skips an item at another stage or in another state', async () => {
    const row = await seed({ state: 'held', stage: 'hold' });
    expect((await sys((tx) => claim(ctx, tx as never, row.id, 'extract', 'extracting'))).kind).toBe('skip');
    expect((await sys((tx) => claim(ctx, tx as never, '00000000-0000-4000-8000-000000000000', 'extract', 'extracting'))).kind).toBe('skip');
  });
});

// ---- validate and commit -------------------------------------------------------------------------------------------------------------

describe('validating proposals', () => {
  const run = async (proposals: OkfProposal[], over: Seed = {}) => {
    const row = await seed({ stage: 'commit', ...over });
    return sys((tx) => validateProposals(ctx, tx as never, repo as never, row, proposals, 'archivist/engineering', 'inbox/filed/2026-11/abc-Notes.md', referencePathOf(row, null), NOW.toISOString()));
  };

  it('accepts a good concept and stamps what only the platform may stamp', async () => {
    const out = await run([concept('memory/facts/deploy-window.md', { tags: ['ops'], description: 'When we deploy.' })]);
    expect(out.left).toEqual([]);
    expect(out.accepted).toHaveLength(1);
    const text = out.accepted[0]!.content;
    expect(text).toContain('type: Fact');
    expect(text).toContain('origin: drop');
    expect(text).toContain('archivist/engineering');
    expect(text).toContain('inbox/filed/2026-11/abc-Notes.md');
    expect(text).not.toContain('share:');
    expect(text).toContain('The deploy window is Tuesday.');
  });

  it('marks a team-only drop so that no share carries it', async () => {
    const out = await run([concept('memory/facts/secret-plan.md')], { teamOnly: true });
    expect(out.accepted[0]!.content).toContain('share: never');
  });

  it('refuses paths outside the bundle’s rules, with a reason in plain words', async () => {
    const out = await run([
      concept('skills/new.md'),
      concept('memory/../TEAM.md'),
      concept('memory/shared/other-team.md'),
      concept('memory/references/forged.md'),
      concept('memory/index.md'),
      concept('memory/notes.txt'),
      concept('memory//double.md'),
      { path: 'memory/untyped.md', body: 'no type' },
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.left).toHaveLength(8);
    expect(out.left.join(' ')).not.toMatch(/undefined|Error/);
  });

  it('never overwrites: a path that exists gets this item’s tail, and a second clash is left out', async () => {
    repoFiles.set('memory/facts/deploy-window.md', 'existing');
    const row = await seed({ stage: 'commit' });
    const out = await sys((tx) => validateProposals(ctx, tx as never, repo as never, row, [concept('memory/facts/deploy-window.md')], 'archivist/engineering', 'o', referencePathOf(row, null), NOW.toISOString()));
    expect(out.accepted[0]!.path).toBe(`memory/facts/deploy-window-${row.id.replace(/-/g, '').slice(-8)}.md`);
    repoFiles.set(out.accepted[0]!.path, 'existing too');
    const again = await sys((tx) => validateProposals(ctx, tx as never, repo as never, row, [concept('memory/facts/deploy-window.md')], 'archivist/engineering', 'o', referencePathOf(row, null), NOW.toISOString()));
    expect(again.accepted).toEqual([]);
    expect(again.left[0]).toContain('already exists');
  });

  it('leaves out a concept the data rules block, and redacts one they redact', async () => {
    egress = { hooks: 1, outcome: 'block', text: '' };
    const blocked = await run([concept('memory/facts/a.md')]);
    expect(blocked.accepted).toEqual([]);
    expect(blocked.left[0]).toContain('data rules');
    egress = { hooks: 1, outcome: 'redact', text: 'The key is [redacted].' };
    const redacted = await run([concept('memory/facts/b.md')]);
    expect(redacted.accepted[0]!.content).toContain('The key is [redacted].');
    expect(redacted.accepted[0]!.content).not.toContain('Tuesday');
  });

  it('turns a relative link into a bundle-absolute one, and keeps to 20 concepts', async () => {
    const many = Array.from({ length: 23 }, (_, i) => concept(`memory/facts/f${i}.md`, i === 0 ? { body: 'See [the rota](../people/rota.md).' } : {}));
    const out = await run(many);
    expect(out.accepted).toHaveLength(20);
    expect(out.accepted[0]!.content).toContain('(/people/rota.md)');
    expect(out.left.at(-1)).toContain('3 more than 20');
  });
});

describe('commit step', () => {
  it('files the Reference alone when nothing was proposed: one commit, the system as author and the dropper as co-author', async () => {
    const row = await seed({ stage: 'commit' });
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actorKind: 'system', message: 'Inbox: file Notes.md', coAuthors: [{ actorId: nadia.actorId, name: 'Nadia' }] });
    expect(written[0]!.changes.map((c) => c.path)).toEqual([referencePathOf(row, null)]);
    const after = await reload(row.id);
    expect(after).toMatchObject({ state: 'filed', stage: 'done', commit_sha: 'a'.repeat(40), filed_paths: [referencePathOf(row, null)] });
    expect(after.filed_at).not.toBeNull();
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_inbox_extracts WHERE item_id = $1', [row.id])).rowCount)).toBe(0);
    expect(audits.find((a) => a['type'] === 'memory.item.filed')).toMatchObject({ itemId: row.id, concepts: 1, distilled: false });
    expect(pushes.map((p) => (p.payload as { state: string }).state)).toEqual(['filed']);
  });

  it('files the Reference and the accepted concepts in one commit', async () => {
    const row = await seed({ stage: 'commit', proposals: [concept('memory/facts/deploy-window.md'), concept('skills/nope.md')], producer: 'archivist/engineering' });
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    expect(written).toHaveLength(1);
    expect(written[0]!.changes.map((c) => c.path)).toEqual([referencePathOf(row, null), 'memory/facts/deploy-window.md']);
    expect(written[0]!.changes[1]).toMatchObject({ baseBlobSha: null });
    const after = await reload(row.id);
    expect(after.state).toBe('filed');
    expect(after.reason).toContain('left out');
    expect(audits.find((a) => a['type'] === 'memory.item.filed')).toMatchObject({ concepts: 2, distilled: true });
  });

  it('when none of the Archivist’s concepts can be filed, a lead looks first; releasing it files the Reference alone', async () => {
    const row = await seed({ stage: 'commit', proposals: [concept('skills/nope.md')], producer: 'archivist/engineering' });
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    const review = await reload(row.id);
    expect(review).toMatchObject({ state: 'needs_review', failed_stage: 'validate' });
    expect(review.reason).toContain('Nothing the Archivist proposed could be filed');
    expect(written).toEqual([]);
    // the release route puts it back in the queue at the commit step, keeping the marker
    await sys((tx) => tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', stage = 'commit' WHERE id = $1`, [row.id]));
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    expect((await reload(row.id)).state).toBe('filed');
    expect(written[0]!.changes).toHaveLength(1);
  });

  it('a refusal by the repo fails the item with a plain reason; a broken repo is retried by the job', async () => {
    const row = await seed({ stage: 'commit' });
    repoWriteStatus = 409;
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    expect(await reload(row.id)).toMatchObject({ state: 'failed', failed_stage: 'commit', reason: expect.stringContaining('changed') });
    const broken = await seed({ stage: 'commit' });
    repoWriteStatus = 500;
    await expect(sys((tx) => commitStep(ctx, tx as never, broken.id))).rejects.toThrow();
    // the job's transaction rolled back: the item is as it was
    expect(await reload(broken.id)).toMatchObject({ state: 'filing', stage: 'commit' });
  });

  it('is safe to run twice', async () => {
    const row = await seed({ stage: 'commit' });
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    await sys((tx) => commitStep(ctx, tx as never, row.id));
    expect(written).toHaveLength(1);
  });

  it('the Reference carries the text, says where the original is, and caps what it copies', () => {
    const row = { id: '01a19e30-6da5-7ee9-932e-242c7077df89', name: 'Big.md', kind: 'markdown', origin: 'person', team_only: false, dropper_name: 'Nadia' } as unknown as ItemRow;
    const text = referenceConcept(row, { text: 'x'.repeat(30_000), title: null }, 'inbox/filed/2026-11/df89-Big.md', NOW.toISOString());
    expect(text).toContain('type: Reference');
    expect(text).toContain('process:inbox');
    expect(text.length).toBeLessThan(25_000);
    expect(text).toMatch(/cut|shortened|first/i);
  });
});

// ---- the sweep and the keeper --------------------------------------------------------------------------------------------------------

describe('the sweep', () => {
  it('puts a step that has been running too long back in the queue, and stops one that has tried too often', async () => {
    const stuck = await seed({ state: 'extracting', stage: 'extract', attempts: 1, updatedMinutesAgo: 45 });
    const tired = await seed({ state: 'filing', stage: 'distil', attempts: 5, updatedMinutesAgo: 45 });
    const fresh = await seed({ state: 'extracting', stage: 'extract', updatedMinutesAgo: 1 });
    await sys((tx) => sweep(ctx, tx as never));
    expect((await reload(stuck.id)).state).toBe('queued');
    expect(await reload(tired.id)).toMatchObject({ state: 'failed', failed_stage: 'distil' });
    expect((await reload(fresh.id)).state).toBe('extracting');
  });

  it('asks again for a queued item whose job was lost, but not for one that is waiting on purpose', async () => {
    const lost = await seed({ state: 'queued', stage: 'commit', updatedMinutesAgo: 10 });
    const waiting = await seed({ state: 'queued', stage: 'distil', updatedMinutesAgo: 10, waitHours: 1 });
    const recent = await seed({ state: 'queued', stage: 'commit' });
    enqueued.length = 0;
    await sys((tx) => sweep(ctx, tx as never));
    const keys = enqueued.map((e) => e.dedupeKey);
    expect(keys).toContain(`commit:${lost.id}`);
    expect(keys).not.toContain(`distil:${waiting.id}`);
    expect(keys).not.toContain(`commit:${recent.id}`);
  });
});

describe('keeping originals', () => {
  it('removes the originals of items filed longer ago than the team keeps them, and says so in the Reference', async () => {
    repoFiles.set('TEAM.md', '---\nname: Engineering\nmemory:\n  inbox:\n    keepOriginals: 30\n---\n');
    const reference = 'memory/references/old-0000aaaa.md';
    repoFiles.set(reference, '# old');
    const old = await seed({ state: 'filed', stage: 'done', filedDaysAgo: 45, filedPaths: [reference], blob: 'blob-old' });
    const young = await seed({ state: 'filed', stage: 'done', filedDaysAgo: 3, filedPaths: [reference], blob: 'blob-young' });
    const removed = await keepOriginals(ctx, job);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await reload(old.id)).toMatchObject({ blob_key: null });
    expect((await reload(old.id)).original_removed_at).not.toBeNull();
    expect((await reload(young.id)).blob_key).toBe('blob-young');
    expect(deletedBlobs).toContain('blob-old');
    expect(deletedBlobs).not.toContain('blob-young');
    expect(written.some((w) => w.changes.some((c) => c.op === 'append' && c.path === reference && (c.content ?? '').includes('original file was removed')))).toBe(true);
  });

  it('keeps everything for a team that keeps originals forever', async () => {
    const team = TEAM_IDS.Marketing;
    const old = await seed({ team, state: 'filed', stage: 'done', filedDaysAgo: 400, blob: 'blob-forever' });
    await keepOriginals(ctx, job);
    expect((await reload(old.id)).blob_key).toBe('blob-forever');
  });
});

describe('the tools of the inbox', () => {
  it('inbox.read answers a person, or a run with nothing bound, that there is no item', async () => {
    const out = await withActor(personaActor(nadia), (tx) => inboxRead({}, tx as never), { pool: appPool });
    expect(out).toMatchObject({ ok: false, code: 'no_item' });
  });
});
