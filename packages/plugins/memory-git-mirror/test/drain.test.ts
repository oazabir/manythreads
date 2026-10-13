import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import {
  MemoryError,
  ensureMemoryWorkspaceKey,
  readMemoryWorkspaceKey,
  type EventHandler,
  type MemoryBank,
  type MemoryProvider,
  type MemoryRetainItem,
  type PluginContext,
  type PluginLogger,
} from '@manythreads/sdk';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryGitMirrorMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerConsumers } from '../src/consumers.ts';
import { drainMirror, type DrainStats } from '../src/drain.ts';
import { conceptDigest, conceptSourceId, documentIdFor, renderConcept } from '../src/render.ts';
import { parseConcept } from '@manythreads/shared';

// The mirror's drain against a real database and a stand-in engine (no server, no clocks, no workers: each call is one drain, as the job would
// make it). What it proves: what is read from the index becomes the right call to the engine and the right line in the log — retained once,
// replaced by an edit, forgotten on a delete or `deprecated`, withheld when it is not OKF or a refused run wrote it, deferred while that run is
// open — and nothing lands in another team's bank.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let sysPool: pg.Pool;
let KEY: Buffer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

interface Call {
  op: 'retain' | 'forget';
  bank: string;
  items?: readonly MemoryRetainItem[];
  async?: boolean | undefined;
  ids?: readonly string[];
}
class StubEngine {
  calls: Call[] = [];
  enabled = true;
  failRetain: Error | null = null;
  failWhen: ((items: readonly MemoryRetainItem[]) => Error | null) | null = null;
  failForget: Error | null = null;
  gone = new Set<string>();
  provider: MemoryProvider = {
    id: 'stub',
    get enabled() {
      return stub.enabled;
    },
    forRun: () => Promise.reject(new Error('not used')),
    forTeam: (_tx, teamId) => {
      if (stub.gone.has(teamId)) return Promise.reject(new MemoryError('unknown_team', 'No such team'));
      const bank: MemoryBank = {
        id: `team:test:${teamId.slice(-4)}`,
        recall: () => Promise.reject(new Error('not used')),
        retain: async (items, options) => {
          if (stub.failRetain) throw stub.failRetain;
          const poisoned = stub.failWhen?.(items) ?? null;
          if (poisoned) throw poisoned;
          stub.calls.push({ op: 'retain', bank: bank.id, items, async: options?.async });
          return { bank: bank.id, items: items.length, async: options?.async === true, documentIds: items.map((i) => i.documentId ?? '') };
        },
        forget: async (ids) => {
          if (stub.failForget) throw stub.failForget;
          stub.calls.push({ op: 'forget', bank: bank.id, ids });
          return { forgotten: ids.length };
        },
      };
      return Promise.resolve(bank);
    },
  };
  reset(): void {
    this.calls = [];
    this.enabled = true;
    this.failRetain = null;
    this.failWhen = null;
    this.failForget = null;
    this.gone.clear();
  }
  retains(): Call[] {
    return this.calls.filter((c) => c.op === 'retain');
  }
  forgets(): Call[] {
    return this.calls.filter((c) => c.op === 'forget');
  }
}
const stub = new StubEngine();

const quiet: PluginLogger = { info: () => undefined, warn: () => undefined };
const enqueued: Array<{ queue: string; payload: Record<string, unknown>; dedupeKey?: string | undefined }> = [];
const handlers = new Map<string, EventHandler>();
const ctx = {
  providers: { get: (kind: string) => (kind === 'memory' ? stub.provider : undefined) },
  jobs: {
    enqueue: (_tx: unknown, queue: string, payload: Record<string, unknown>, options?: { dedupeKey?: string }) => {
      enqueued.push({ queue, payload, dedupeKey: options?.dedupeKey });
      return Promise.resolve('job');
    },
  },
  events: { subscribe: (type: string, handler: EventHandler) => void handlers.set(type, handler) },
  runtime: { now: () => new Date() },
} as unknown as PluginContext;
registerConsumers(ctx);

const drain = (): Promise<DrainStats> => sys((tx) => drainMirror(ctx, tx, quiet));
const mark = (teamId: string, path: string): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.memory_mirror_pending (team_id, path, workspace_id, not_before) VALUES ($1, $2, $3, now())
       ON CONFLICT (team_id, path) DO UPDATE SET requested_at = now(), not_before = now(), attempts = 0, last_error = ''`,
      [teamId, path, omar.workspaceId],
    ),
  );
const pendingOf = (teamId: string, path: string) =>
  sys(
    async (tx) =>
      (
        await tx.query<{ attempts: number; last_error: string; in_future: boolean; deferred: boolean }>(
          `SELECT attempts, last_error, not_before > now() AS in_future, deferred_since IS NOT NULL AS deferred
             FROM app.memory_mirror_pending WHERE team_id = $1 AND path = $2`,
          [teamId, path],
        )
      ).rows[0],
  );
const linesOf = (teamId: string, path: string) =>
  sys(
    async (tx) =>
      (
        await tx.query<{ outcome: string; reason: string; document_id: string | null; content_hash: string | null; link: string; bank: string; actor_id: string | null }>(
          `SELECT outcome, reason, document_id, content_hash, link, bank, actor_id FROM app.memory_retain_log
            WHERE source_kind = 'concept' AND source_id = $1 ORDER BY id`,
          [conceptSourceId(teamId, path)],
        )
      ).rows,
  );

let botId = '';
let botActor = '';

const concept = (frontmatter: string, body = 'The deploy freeze starts on Friday at 18:00.\n'): string => `---\n${frontmatter}\n---\n\n${body}`;

/** Writes a file into the index the way the writer would: a commit row and the entry that points at it. */
const put = (teamId: string, path: string, text: string | null, options: { author?: string; committedAt?: string; indexedAt?: string | null } = {}): Promise<void> =>
  sys(async (tx) => {
    const sha = (await tx.query<{ sha: string }>("SELECT md5(random()::text) || md5(random()::text) || 'abcdefgh' AS sha")).rows[0]!.sha.slice(0, 40);
    await tx.query(
      options.indexedAt === undefined
        ? `INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, $2, $3, 'write', coalesce($5::timestamptz, now()), ARRAY[$4]::text[])`
        : `INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths, indexed_at) VALUES ($1, $2, $3, 'write', coalesce($5::timestamptz, now()), ARRAY[$4]::text[], $6::timestamptz)`,
      options.indexedAt === undefined
        ? [teamId, sha, options.author ?? nadia.actorId, path, options.committedAt ?? null]
        : [teamId, sha, options.author ?? nadia.actorId, path, options.committedAt ?? null, options.indexedAt],
    );
    await tx.query(
      `INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain) VALUES ($1, $2, $3, 10, $4, $5)
       ON CONFLICT (team_id, path) DO UPDATE SET blob_sha = EXCLUDED.blob_sha, last_commit_sha = EXCLUDED.last_commit_sha, text_plain = EXCLUDED.text_plain`,
      [teamId, path, sha, sha, text],
    );
  });
const remove = (teamId: string, path: string): Promise<unknown> => sys((tx) => tx.query('DELETE FROM app.repo_entries WHERE team_id = $1 AND path = $2', [teamId, path]));

interface RunOptions {
  status?: 'running' | 'done';
  startedAt?: string;
  endedAt?: string | null;
}
const run = (lines: ReadonlyArray<readonly [string, string, string]>, options: RunOptions = {}): Promise<string> =>
  sys(async (tx) => {
    const status = options.status ?? 'done';
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at, ended_at)
         VALUES ($1, $2, $3, 'mention', $4, $5, coalesce($6::timestamptz, now() - interval '1 minute'),
                 CASE WHEN $5 = 'running' THEN NULL ELSE coalesce($7::timestamptz, now()) END)
         RETURNING id`,
        [omar.workspaceId, botId, ENG, nadia.actorId, status, options.startedAt ?? null, options.endedAt ?? null],
      )
    ).rows[0]!.id;
    for (const [i, [type, ref, scope]] of lines.entries()) {
      await tx.query('INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, $2, $3, $4, $5)', [id, i, type, ref, scope]);
    }
    return id;
  });

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
      memoryGitMirrorMigrationSource,
    ],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys((tx) => ensureMemoryWorkspaceKey(tx, omar.workspaceId));
  KEY = (await sys((tx) => readMemoryWorkspaceKey(tx, omar.workspaceId)))!;
  await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'scribe', 'Scribe', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    botId = bot.rows[0]!.id;
    botActor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId])).rows[0]!.id;
  });
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(() => {
  stub.reset();
  enqueued.length = 0;
});

const expectedItem = (path: string, text: string) => {
  const parsed = parseConcept(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return renderConcept({ path, teamSlug: 'engineering', frontmatter: parsed.frontmatter, body: parsed.body, authorId: nadia.actorId, authorName: 'Nadia', committedAt: '2026-01-01T00:00:00.000Z' });
};

describe('a concept', () => {
  it('is retained once, async, as one item of its team’s bank: path + keyed digest, type, tags, origin and trust tier', async () => {
    const path = 'memory/decisions/db.md';
    const text = concept('type: Decision\ntitle: Use Postgres\ntags: [db]\norigin: drop\nverified:\n  by: human:abc');
    await put(ENG, path, text, { committedAt: '2026-01-01T00:00:00.000Z' });
    await mark(ENG, path);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 1, retained: 1, unchanged: 0 });

    const [call] = stub.retains();
    expect(call).toMatchObject({ bank: `team:test:${ENG.slice(-4)}`, async: true });
    const item = call!.items![0]!;
    expect(item.tags).toEqual(['okf', 'kind:concept', 'type:decision', 'trust:human-reviewed', 'status:stable', 'origin:drop', 'tag:db']);
    expect(item.metadata).toMatchObject({ feed_kind: 'concept', concept_path: path, concept_type: 'Decision', trust_tier: 'human-reviewed', origin: 'drop', actor: nadia.actorId, actor_name: 'Nadia' });
    expect(item.content).toContain('Memory concept memory/decisions/db.md (type Decision, status stable, trust human-reviewed, origin drop');
    expect(item.content).toContain('The deploy freeze starts on Friday at 18:00.');
    // the id is the path and the keyed digest of what the bank shows, and nothing of the other plugins' namespaces
    const digest = conceptDigest(expectedItem(path, text), KEY);
    expect(item.documentId).toBe(documentIdFor(path, digest));
    expect(item.documentId).toMatch(/^okf:/);

    expect(await linesOf(ENG, path)).toEqual([
      { outcome: 'retained', reason: '', document_id: item.documentId, content_hash: digest, link: `/t/engineering/files?open=${encodeURIComponent(path)}`, bank: call!.bank, actor_id: nadia.actorId },
    ]);
    expect(await pendingOf(ENG, path)).toBeUndefined();
  });

  it('delivered again unchanged is nothing: no engine call, no new line', async () => {
    const path = 'memory/facts/unchanged.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    await drain();
    stub.reset();
    await mark(ENG, path);
    expect(await drain()).toMatchObject({ considered: 1, retained: 0, unchanged: 1 });
    expect(stub.calls).toEqual([]);
    expect(await linesOf(ENG, path)).toHaveLength(1);
  });

  it('an edit forgets the old document first and retains the new one; adding a human verifier alone is an edit too', async () => {
    const path = 'memory/facts/edited.md';
    await put(ENG, path, concept('type: Fact', 'The password is hunter2.\n'));
    await mark(ENG, path);
    await drain();
    const first = (await linesOf(ENG, path))[0]!.document_id!;
    stub.reset();
    await put(ENG, path, concept('type: Fact', 'Rotate the credentials before Friday.\n'));
    await mark(ENG, path);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget', 'retain']);
    expect(stub.forgets()[0]!.ids).toEqual([first]);
    const lines = await linesOf(ENG, path);
    expect(lines.map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'replaced'], ['retained', '']]);
    expect(stub.calls.some((c) => JSON.stringify(c).includes('hunter2') && c.op === 'retain')).toBe(false);

    stub.reset();
    await put(ENG, path, concept('type: Fact\nverified:\n  by: human:abc', 'Rotate the credentials before Friday.\n'));
    await mark(ENG, path);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget', 'retain']);
    expect(stub.retains()[0]!.items![0]!.tags).toContain('trust:human-reviewed');
  });

  it('a delete forgets it, once', async () => {
    const path = 'memory/facts/gone.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    await drain();
    const doc = (await linesOf(ENG, path))[0]!.document_id!;
    stub.reset();
    await remove(ENG, path);
    await mark(ENG, path);
    await drain();
    expect(stub.calls).toEqual([{ op: 'forget', bank: `team:test:${ENG.slice(-4)}`, ids: [doc] }]);
    expect((await linesOf(ENG, path)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
    stub.reset();
    await mark(ENG, path);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf(ENG, path)).toHaveLength(2);
  });

  it('`status: deprecated` forgets it (git keeps the history), and a concept made stable again is retained again', async () => {
    const path = 'memory/playbooks/rollback.md';
    await put(ENG, path, concept('type: Playbook'));
    await mark(ENG, path);
    await drain();
    stub.reset();
    await put(ENG, path, concept('type: Playbook\nstatus: deprecated'));
    await mark(ENG, path);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget']);
    expect((await linesOf(ENG, path)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deprecated' });

    stub.reset();
    await put(ENG, path, concept('type: Playbook\nstatus: stable'));
    await mark(ENG, path);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['retain']);
    expect((await linesOf(ENG, path)).map((l) => l.outcome)).toEqual(['retained', 'forgotten', 'retained']);
  });

  it('a draft is retained, tagged as one', async () => {
    const path = 'memory/facts/maybe.md';
    await put(ENG, path, concept('type: Fact\nstatus: draft'));
    await mark(ENG, path);
    await drain();
    expect(stub.retains()[0]!.items![0]!.tags).toContain('status:draft');
  });

  it('a file that is not valid OKF is withheld with the reason, once; a held document goes when its file stops being valid', async () => {
    const bad = 'memory/facts/no-type.md';
    await put(ENG, bad, '# A page with no frontmatter at all\n');
    await mark(ENG, bad);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf(ENG, bad)).toMatchObject([{ outcome: 'withheld', reason: 'okf_invalid: the file does not open with a --- frontmatter line' }]);
    await mark(ENG, bad);
    await drain();
    expect(await linesOf(ENG, bad)).toHaveLength(1);

    const good = 'memory/facts/was-good.md';
    await put(ENG, good, concept('type: Fact'));
    await mark(ENG, good);
    await drain();
    stub.reset();
    await put(ENG, good, concept('title: the type was removed'));
    await mark(ENG, good);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget']);
    expect((await linesOf(ENG, good)).map((l) => [l.outcome, l.reason])).toEqual([
      ['retained', ''],
      ['forgotten', 'okf_invalid: the frontmatter has no `type`'],
      ['withheld', 'okf_invalid: the frontmatter has no `type`'],
    ]);
  });

  it('index.md, log.md and anything that is not a concept are not read: no call, no line, and the work row is gone', async () => {
    const paths = ['memory/index.md', 'memory/log.md', 'memory/facts/index.md', 'memory/facts/data.csv'];
    for (const p of paths) {
      await put(ENG, p, concept('okf_version: "0.2"'));
      await mark(ENG, p);
    }
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 4, retained: 0, unchanged: 4 });
    expect(stub.calls).toEqual([]);
    for (const p of paths) {
      expect(await linesOf(ENG, p)).toEqual([]);
      expect(await pendingOf(ENG, p)).toBeUndefined();
    }
  });

  it('a binary or oversized file (no text in the index) is not a concept: forgotten if it was held', async () => {
    const path = 'memory/facts/became-binary.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    await drain();
    stub.reset();
    await put(ENG, path, null);
    await mark(ENG, path);
    await drain();
    expect((await linesOf(ENG, path)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'no_text' });
  });
});

describe('what a bot wrote', () => {
  it('a concept written during a run that read a person source is withheld; one written outside any run is retained', async () => {
    await run([['drive', 'finance/q3.xlsx', 'person']], { startedAt: '2012-03-01T10:00:00.000Z', endedAt: '2012-03-01T10:05:00.000Z' });
    const refused = 'memory/facts/bot-refused.md';
    const clean = 'memory/facts/bot-clean.md';
    await put(ENG, refused, concept('type: Fact', 'Q3 revenue was 4.2M.\n'), { author: botActor, committedAt: '2012-03-01T10:02:00.000Z', indexedAt: null });
    await put(ENG, clean, concept('type: Fact', 'Standup is at ten.\n'), { author: botActor, committedAt: '2012-07-01T10:00:00.000Z', indexedAt: null });
    await mark(ENG, refused);
    await mark(ENG, clean);
    await drain();
    expect(await linesOf(ENG, refused)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: person_source' }]);
    expect((await linesOf(ENG, clean)).map((l) => l.outcome)).toEqual(['retained']);
    expect(JSON.stringify(stub.calls)).not.toContain('Q3 revenue');
  });

  it('waits for a run that has not closed, and withholds as run_open after a day', async () => {
    const open = await run([], { status: 'running' });
    const path = 'memory/facts/bot-open.md';
    await put(ENG, path, concept('type: Fact'), { author: botActor });
    await mark(ENG, path);
    const first = await drain();
    expect(first).toMatchObject({ deferred: 1, retained: 0 });
    expect(await pendingOf(ENG, path)).toMatchObject({ deferred: true, in_future: true });
    expect(stub.calls).toEqual([]);

    // a day of waiting later
    await sys((tx) => tx.query("UPDATE app.memory_mirror_pending SET deferred_since = now() - interval '25 hours', not_before = now() WHERE team_id = $1 AND path = $2", [ENG, path]));
    await drain();
    expect(await linesOf(ENG, path)).toMatchObject([{ outcome: 'withheld', reason: 'run_open' }]);
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [open]));
  });
});

describe('teams', () => {
  it('another team’s concept goes to that team’s bank, and the first team’s bank is never named for it', async () => {
    const path = 'memory/facts/marketing-launch.md';
    await put(MKT, path, concept('type: Fact', 'The Halcyon launch is on 9 March.\n'));
    await mark(MKT, path);
    await drain();
    expect(stub.calls.map((c) => c.bank)).toEqual([`team:test:${MKT.slice(-4)}`]);
    expect(stub.calls.every((c) => c.bank !== `team:test:${ENG.slice(-4)}`)).toBe(true);
    expect(await linesOf(MKT, path)).toMatchObject([{ outcome: 'retained' }]);
  });

  it('a path that exists only in another team is nothing for this one (the team comes from the row, not from a path)', async () => {
    const path = 'memory/facts/only-in-eng.md';
    await put(ENG, path, concept('type: Fact', 'Engineering only.\n'));
    await mark(MKT, path); // the event named the wrong team
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf(MKT, path)).toEqual([]);
  });

  it('a team that is gone settles the row', async () => {
    const path = 'memory/facts/team-gone.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    stub.gone.add(ENG);
    await drain();
    expect(await pendingOf(ENG, path)).toBeUndefined();
    expect(await linesOf(ENG, path)).toEqual([]);
  });
});

describe('the engine', () => {
  it('failing backs the concept off in its own row, and after 8 attempts writes `failed` and drops it', async () => {
    const path = 'memory/facts/engine-down.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    stub.failRetain = new MemoryError('unavailable', 'the engine is down', 503);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      const stats = await drain();
      expect(stats).toMatchObject({ failed: 1 });
      expect(await pendingOf(ENG, path)).toMatchObject({ attempts: attempt, in_future: true, last_error: 'the engine is down' });
      await sys((tx) => tx.query('UPDATE app.memory_mirror_pending SET not_before = now() WHERE team_id = $1 AND path = $2', [ENG, path]));
    }
    await drain();
    expect(await pendingOf(ENG, path)).toBeUndefined();
    expect(await linesOf(ENG, path)).toMatchObject([{ outcome: 'failed', reason: 'the engine did not take it after 8 attempts' }]);
  });

  it('a forget that fails is never given up on: the row stays, and the failed line carries the document', async () => {
    const path = 'memory/facts/forget-fails.md';
    await put(ENG, path, concept('type: Fact'));
    await mark(ENG, path);
    await drain();
    const doc = (await linesOf(ENG, path))[0]!.document_id!;
    await remove(ENG, path);
    await mark(ENG, path);
    stub.failForget = new MemoryError('unavailable', 'forget failed', 503);
    for (let i = 0; i < 9; i += 1) {
      await drain();
      await sys((tx) => tx.query('UPDATE app.memory_mirror_pending SET not_before = now() WHERE team_id = $1 AND path = $2', [ENG, path]));
    }
    expect(await pendingOf(ENG, path)).toMatchObject({ attempts: 9 });
    const failed = (await linesOf(ENG, path)).filter((l) => l.outcome === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.document_id).toBe(doc);
    stub.failForget = null;
    await drain();
    expect(await pendingOf(ENG, path)).toBeUndefined();
    expect((await linesOf(ENG, path)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });

  it('a 422 on a chunk retries its items one at a time, so one poison concept holds back no other', async () => {
    const paths = ['memory/facts/ok-1.md', 'memory/facts/poison.md', 'memory/facts/ok-2.md'];
    for (const p of paths) {
      await put(ENG, p, concept('type: Fact', `Body of ${p}.\n`));
      await mark(ENG, p);
    }
    stub.failWhen = (items) => (items.some((i) => i.content.includes('poison.md')) && items.length >= 1 ? new MemoryError('unavailable', 'unprocessable', 422) : null);
    await drain();
    expect((await linesOf(ENG, paths[0]!)).map((l) => l.outcome)).toEqual(['retained']);
    expect((await linesOf(ENG, paths[2]!)).map((l) => l.outcome)).toEqual(['retained']);
    expect(await linesOf(ENG, paths[1]!)).toEqual([]);
    expect(await pendingOf(ENG, paths[1]!)).toMatchObject({ attempts: 1 });
  });

  it('is not configured: nothing is retained, a concept the bank holds waits to be taken out, and every other row goes', async () => {
    const held = 'memory/facts/held-while-off.md';
    const other = 'memory/facts/never-held.md';
    await put(ENG, held, concept('type: Fact'));
    await mark(ENG, held);
    await drain();
    stub.reset();
    stub.enabled = false;
    await remove(ENG, held);
    await put(ENG, other, concept('type: Fact'));
    await mark(ENG, held);
    await mark(ENG, other);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 2, deferred: 1, dropped: 1 });
    expect(stub.calls).toEqual([]);
    expect(await pendingOf(ENG, other)).toBeUndefined();
    expect(await pendingOf(ENG, held)).toMatchObject({ in_future: true });
    // the engine is back: the delete made while it was off is carried out
    stub.enabled = true;
    await sys((tx) => tx.query('UPDATE app.memory_mirror_pending SET not_before = now() WHERE team_id = $1 AND path = $2', [ENG, held]));
    await drain();
    expect((await linesOf(ENG, held)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });
});

describe('the event handler', () => {
  const committed = (paths: Array<{ path: string; op: 'put' | 'delete' }>, teamId = ENG) => ({
    type: 'repo.repo.committed',
    schemaVersion: 1,
    workspaceId: omar.workspaceId,
    teamId,
    sha: 'a'.repeat(40),
    parentSha: null,
    authorId: null,
    coAuthorIds: [],
    subject: 'x',
    paths,
  });
  const handle = (event: unknown): Promise<void> => sys(async (tx) => void (await handlers.get('repo.repo.committed')!(event as never, tx as never)));
  const queued = (): Promise<string[]> =>
    sys(async (tx) => (await tx.query<{ path: string }>('SELECT path FROM app.memory_mirror_pending WHERE team_id = $1 ORDER BY path', [ENG])).rows.map((r) => r.path));

  beforeEach(async () => {
    await sys((tx) => tx.query('DELETE FROM app.memory_mirror_pending'));
    await sys((tx) => tx.query('DELETE FROM app.memory_mirror_teams'));
  });

  it('marks every concept path of a commit (puts and deletes), once, and nothing else', async () => {
    await handle(
      committed([
        { path: 'memory/facts/a.md', op: 'put' },
        { path: 'memory/facts/a.md', op: 'put' },
        { path: 'memory/old.md', op: 'delete' },
        { path: 'memory/index.md', op: 'put' },
        { path: 'memory/log.md', op: 'put' },
        { path: 'pages/x.md', op: 'put' },
        { path: 'memory/facts/data.csv', op: 'put' },
      ]),
    );
    expect(await queued()).toEqual(['memory/facts/a.md', 'memory/old.md']);
    expect(enqueued.map((e) => e.queue).sort()).toEqual(['memory-git-mirror.drain', 'memory-git-mirror.ensure']);
  });

  it('asks for the bundle root the first time a team’s memory is touched, and not again once it is recorded', async () => {
    await handle(committed([{ path: 'memory/facts/a.md', op: 'put' }]));
    expect(enqueued.filter((e) => e.queue === 'memory-git-mirror.ensure')).toEqual([
      { queue: 'memory-git-mirror.ensure', payload: { workspaceId: omar.workspaceId, teamId: ENG }, dedupeKey: `ensure:${ENG}` },
    ]);
    enqueued.length = 0;
    await sys((tx) => tx.query('INSERT INTO app.memory_mirror_teams (team_id, workspace_id) VALUES ($1, $2)', [ENG, omar.workspaceId]));
    await handle(committed([{ path: 'memory/facts/b.md', op: 'put' }]));
    expect(enqueued.map((e) => e.queue)).toEqual(['memory-git-mirror.drain']);
  });

  it('ignores a commit that touches nothing under memory/, and a payload that is not the event', async () => {
    await handle(committed([{ path: 'pages/x.md', op: 'put' }]));
    await handle({ type: 'repo.repo.committed', schemaVersion: 1 });
    expect(await queued()).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('without an engine: one not_configured line, no bundle root, and only a concept the bank holds is queued', async () => {
    stub.enabled = false;
    const held = 'memory/facts/off-held.md';
    await put(ENG, held, concept('type: Fact'));
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, document_id, content_hash)
         VALUES ($1, $2, 'team:test:x', 'concept', $3, 'retained', 'okf:x:y', repeat('a', 64))`,
        [omar.workspaceId, ENG, conceptSourceId(ENG, held)],
      ),
    );
    await handle(committed([{ path: held, op: 'delete' }, { path: 'memory/facts/off-never.md', op: 'put' }]));
    expect(await queued()).toEqual([held]);
    expect(enqueued.map((e) => e.queue)).toEqual(['memory-git-mirror.drain']);
    const notes = await sys(async (tx) => (await tx.query("SELECT bank, outcome FROM app.memory_retain_log WHERE team_id = $1 AND outcome = 'not_configured'", [ENG])).rows);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    // a second commit the same day writes no second line
    await handle(committed([{ path: 'memory/facts/off-more.md', op: 'put' }]));
    const again = await sys(async (tx) => (await tx.query("SELECT 1 FROM app.memory_retain_log WHERE team_id = $1 AND outcome = 'not_configured'", [ENG])).rows);
    expect(again.length).toBe(notes.length);
  });
});
