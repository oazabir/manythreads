import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import { MemoryError, type MemoryBank, type MemoryProvider, type MemoryRetainItem, type PluginContext, type PluginLogger } from '@manythreads/sdk';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  retentionMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainFeed, type DrainStats, type FeedRuntime } from '../src/feed.ts';
import { ensureWorkspaceKey, readWorkspaceKey } from '../src/keys.ts';
import { contentHash as keyedHash, documentIdFor } from '../src/render.ts';
import { SlidingWindow } from '../src/window.ts';

// The drain against a real database and a stand-in engine (no server, no clocks, no workers: each call is one drain, as the job would make it).
// What it proves: what is read from the database becomes the right call to the engine and the right line in the log — retained once, replaced
// by an edit, forgotten on a delete, withheld by the narrowest-source rule, throttled, backed off, deferred — and nothing else.

const { omar, nadia, rafi } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let sysPool: pg.Pool;
/** The workspace's digest key, as the feed itself reads it (`memory_workspace_keys`). */
let KEY: Buffer;
const contentHash = (text: string): string => keyedHash(text, KEY);
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

// A memory provider that records what it was asked and can be made to fail.
interface Call {
  op: 'retain' | 'forget';
  bank: string;
  items?: readonly MemoryRetainItem[];
  async?: boolean | undefined;
  ids?: readonly string[];
  /** The engine answered with an error to this call. */
  rejected?: boolean;
}
class StubEngine {
  calls: Call[] = [];
  enabled = true;
  failRetain: Error | null = null;
  /** Fails a retain call when this says so for the items of the call (a poison item). */
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
          if (poisoned) {
            stub.calls.push({ op: 'retain', bank: bank.id, items, async: options?.async, rejected: true });
            throw poisoned;
          }
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
const ctx = {
  providers: { get: (kind: string) => (kind === 'memory' ? stub.provider : undefined) },
  jobs: { enqueue: () => Promise.resolve('job') },
  runtime: { now: () => new Date() },
} as unknown as PluginContext;

const runtime = (retain = 1000, forget = 1000): FeedRuntime => ({
  retainWindow: new SlidingWindow(retain, 60_000),
  forgetWindow: new SlidingWindow(forget, 60_000),
  now: () => Date.now(),
});
const drain = (rt: FeedRuntime = runtime()): Promise<DrainStats> => sys((tx) => drainFeed(ctx, tx, quiet, rt));

const mark = (kind: string, id: string, extra = ''): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.memory_feed_pending (source_kind, source_id, workspace_id, not_before) VALUES ($1, $2, $3, now())
       ON CONFLICT (source_kind, source_id) DO UPDATE SET requested_at = now(), not_before = now(), attempts = 0 ${extra}`,
      [kind, id, omar.workspaceId],
    ),
  );
const pendingOf = (kind: string, id: string) =>
  sys(
    async (tx) =>
      (
        await tx.query<{ attempts: number; last_error: string; in_future: boolean; deferred: boolean }>(
          `SELECT attempts, last_error, not_before > now() AS in_future, deferred_since IS NOT NULL AS deferred
             FROM app.memory_feed_pending WHERE source_kind = $1 AND source_id = $2`,
          [kind, id],
        )
      ).rows[0],
  );
const linesOf = (kind: string, id: string) =>
  sys(
    async (tx) =>
      (
        await tx.query<{ outcome: string; reason: string; document_id: string | null; content_hash: string | null; run_id: string | null; source_scopes: string[]; link: string; bank: string }>(
          'SELECT outcome, reason, document_id, content_hash, run_id, source_scopes, link, bank FROM app.memory_retain_log WHERE source_kind = $1 AND source_id = $2 ORDER BY id',
          [kind, id],
        )
      ).rows,
  );

let botId = '';
let pubChannel = '';
let privChannel = '';
let mktChannel = '';
let dmChannel = '';

const channel = (team: string | null, name: string, kind: 'channel' | 'dm', priv: boolean): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          'INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [omar.workspaceId, team, name, kind, priv, kind === 'dm' ? `${nadia.actorId}:${rafi.actorId}` : null],
        )
      ).rows[0]!.id,
  );
const message = (channelId: string, body: string, options: { author?: string; threadRoot?: string; at?: string } = {}): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, created_at)
           VALUES ($1, $2, $3, $4, $4, $5, coalesce($6::timestamptz, now())) RETURNING id`,
          [omar.workspaceId, channelId, options.author ?? nadia.actorId, body, options.threadRoot ?? null, options.at ?? null],
        )
      ).rows[0]!.id,
  );
const setBody = (id: string, body: string): Promise<unknown> => sys((tx) => tx.query('UPDATE app.messages SET body = $2, body_plain = $2, edited_at = now() WHERE id = $1', [id, body]));
const softDelete = (id: string): Promise<unknown> => sys((tx) => tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [id]));

interface RunOptions {
  trigger?: string;
  channelId?: string | null;
  status?: 'running' | 'done' | 'failed' | 'stopped';
  startedAt?: string;
  endedAt?: string | null;
  /** The bot that ran; default the file's first bot. */
  bot?: string;
}
const run = (lines: ReadonlyArray<readonly [string, string, string]>, options: RunOptions = {}): Promise<string> =>
  sys(async (tx) => {
    const status = options.status ?? 'done';
    // One clock for both instants (the statement's `now()`), so a run never ends before it starts; explicit instants are used as given.
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now() - interval '1 minute'),
                 CASE WHEN $7 = 'running' THEN NULL ELSE coalesce($9::timestamptz, now()) END)
         RETURNING id`,
        [
          omar.workspaceId,
          options.bot ?? botId,
          ENG,
          options.trigger ?? 'mention',
          nadia.actorId,
          options.channelId ?? null,
          status,
          options.startedAt ?? null,
          options.endedAt ?? null,
        ],
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
      retentionMigrationSource,
    ],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys((tx) => ensureWorkspaceKey(tx, omar.workspaceId));
  KEY = (await sys((tx) => readWorkspaceKey(tx, omar.workspaceId)))!;
  await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'memo', 'Memo', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    botId = bot.rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, botId]);
  });
  pubChannel = await channel(ENG, 'dev', 'channel', false);
  privChannel = await channel(ENG, 'war-room', 'channel', true);
  mktChannel = await channel(MKT, 'launch', 'channel', false);
  dmChannel = await channel(null, '', 'dm', true);
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(() => {
  stub.reset();
});

describe('a message', () => {
  it('is retained once, with source, actor, time and link, as one async item of its team’s bank', async () => {
    const id = await message(pubChannel, 'The Basilisk migration freezes writes on Friday evening.');
    await mark('message', id);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 1, retained: 1, unchanged: 0 });

    const [call] = stub.retains();
    expect(call).toMatchObject({ bank: `team:test:${ENG.slice(-4)}`, async: true });
    expect(call!.items).toHaveLength(1);
    const item = call!.items![0]!;
    expect(item.content).toBe(`Nadia wrote in #dev on ${item.timestamp!.slice(0, 16).replace('T', ' ')}:\nThe Basilisk migration freezes writes on Friday evening.`);
    expect(item.documentId).toBe(documentIdFor('message', id, contentHash(item.content)));
    expect(item.tags).toEqual(['feed', 'kind:message', 'channel:dev']);
    expect(item.metadata).toMatchObject({
      feed_kind: 'message',
      feed_id: id,
      actor: nadia.actorId,
      actor_name: 'Nadia',
      link: `/t/engineering/c/dev?message=${id}`,
      channel: 'dev',
    });
    expect(item.metadata!['occurred_at']).toBe(item.timestamp);

    const lines = await linesOf('message', id);
    expect(lines).toEqual([
      { outcome: 'retained', reason: '', document_id: item.documentId, content_hash: contentHash(item.content), run_id: null, source_scopes: [], link: `/t/engineering/c/dev?message=${id}`, bank: call!.bank },
    ]);
    expect(await pendingOf('message', id)).toBeUndefined();
  });

  it('delivered again with the same text is nothing: no engine call, no new line', async () => {
    const id = await message(pubChannel, 'Same text twice.');
    await mark('message', id);
    await drain();
    stub.reset();
    await mark('message', id);
    const again = await drain();
    expect(again).toMatchObject({ considered: 1, retained: 0, unchanged: 1 });
    expect(stub.calls).toEqual([]);
    expect(await linesOf('message', id)).toHaveLength(1);
  });

  it('an edit forgets the old document first and retains the new one, so only one version is ever in the bank', async () => {
    const id = await message(pubChannel, 'The password is hunter2.');
    await mark('message', id);
    await drain();
    const first = (await linesOf('message', id))[0]!.document_id!;
    stub.reset();
    await setBody(id, 'Rotate the credentials before Friday.');
    await mark('message', id);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget', 'retain']);
    expect(stub.forgets()[0]!.ids).toEqual([first]);
    const lines = await linesOf('message', id);
    expect(lines.map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'replaced'], ['retained', '']]);
    expect(lines[2]!.document_id).not.toBe(first);
    expect(lines[2]!.document_id).toBe(stub.retains()[0]!.items![0]!.documentId);
  });

  it('a delete forgets it; a second delete event finds nothing to do', async () => {
    const id = await message(pubChannel, 'Delete me.');
    await mark('message', id);
    await drain();
    const doc = (await linesOf('message', id))[0]!.document_id!;
    stub.reset();
    await softDelete(id);
    await mark('message', id);
    await drain();
    expect(stub.calls).toEqual([{ op: 'forget', bank: `team:test:${ENG.slice(-4)}`, ids: [doc] }]);
    expect((await linesOf('message', id)).map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'deleted']]);
    stub.reset();
    await mark('message', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('message', id)).toHaveLength(2);
  });

  it('is never read when it is in a private channel, a DM or a bot conversation: no call, no line, and the work row is gone', async () => {
    const ids = [await message(privChannel, 'Layoffs are planned for June.'), await message(dmChannel, 'Between the two of us.')];
    for (const id of ids) await mark('message', id);
    const stats = await drain();
    expect(stats.considered).toBe(2);
    expect(stub.calls).toEqual([]);
    for (const id of ids) {
      expect(await linesOf('message', id)).toEqual([]);
      expect(await pendingOf('message', id)).toBeUndefined();
    }
  });

  it('a channel that stops being public takes its documents out of the bank', async () => {
    const id = await message(pubChannel, 'This channel will be made private.');
    await mark('message', id);
    await drain();
    const doc = (await linesOf('message', id))[0]!.document_id!;
    stub.reset();
    await sys((tx) => tx.query('UPDATE app.channels SET private = true WHERE id = $1', [pubChannel]));
    try {
      await mark('message', id);
      await drain();
      expect(stub.forgets()[0]!.ids).toEqual([doc]);
      expect((await linesOf('message', id)).map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'not_team_visible']]);
    } finally {
      await sys((tx) => tx.query('UPDATE app.channels SET private = false WHERE id = $1', [pubChannel]));
    }
  });

  it('another team’s message is retained to that team’s own bank', async () => {
    const id = await message(mktChannel, 'Launch is on the ninth.', { author: nadia.actorId });
    await mark('message', id);
    await drain();
    expect(stub.retains()[0]!.bank).toBe(`team:test:${MKT.slice(-4)}`);
    expect(stub.retains()[0]!.bank).not.toBe(`team:test:${ENG.slice(-4)}`);
  });
});

describe('a thread', () => {
  it('is one document of the root and its replies; the root’s own document goes once it has replies; an edit of a reply replaces it', async () => {
    const root = await message(pubChannel, 'Can we ship on Friday?');
    await mark('message', root);
    await drain();
    expect((await linesOf('message', root)).map((l) => l.outcome)).toEqual(['retained']);
    stub.reset();

    const reply = await message(pubChannel, 'Only after the migration.', { author: rafi.actorId, threadRoot: root });
    await mark('thread', root);
    await mark('message', root);
    await drain();
    const doc = stub.retains()[0]!.items![0]!;
    expect(doc.content).toMatch(/^Thread in #dev/);
    expect(doc.content).toContain('Nadia: Can we ship on Friday?');
    expect(doc.content).toContain('Rafi: Only after the migration.');
    expect(doc.metadata).toMatchObject({ feed_kind: 'thread', feed_id: root });
    expect(stub.forgets()).toHaveLength(1); // the root's own document (in_thread)
    expect((await linesOf('message', root)).map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'in_thread']]);

    stub.reset();
    await setBody(reply, 'Only after the migration lands, which is Thursday.');
    await mark('thread', root);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget', 'retain']);
    expect(stub.retains()[0]!.items![0]!.content).toContain('which is Thursday');
    expect((await linesOf('thread', root)).map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'replaced'], ['retained', '']]);

    // the last reply goes: the thread document goes with it and the root is a plain message again
    stub.reset();
    await softDelete(reply);
    await mark('thread', root);
    await mark('message', root);
    await drain();
    expect((await linesOf('thread', root)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'no_replies' });
    expect((await linesOf('message', root)).at(-1)).toMatchObject({ outcome: 'retained' });
  });
});

describe('batching and rate limit', () => {
  it('sixty changed messages are three engine calls of at most 25 items, all asynchronous', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) ids.push(await message(pubChannel, `Batch note number ${i}.`));
    for (const id of ids) await mark('message', id);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 60, retained: 60 });
    expect(stub.retains().map((c) => c.items!.length)).toEqual([25, 25, 10]);
    expect(stub.retains().every((c) => c.async === true)).toBe(true);
  });

  it('a team over its per-minute allowance keeps the rest in the work list, delayed, and loses nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await message(pubChannel, `Throttled note ${i}.`));
    for (const id of ids) await mark('message', id);
    const rt = runtime(10, 1000);
    const stats = await drain(rt);
    expect(stats).toMatchObject({ considered: 12, retained: 10, throttled: 2 });
    expect(stub.retains().reduce((n, c) => n + c.items!.length, 0)).toBe(10);
    const waiting = ids.slice(10);
    for (const id of waiting) expect(await pendingOf('message', id)).toMatchObject({ in_future: true, attempts: 0 });
    for (const id of ids.slice(0, 10)) expect(await pendingOf('message', id)).toBeUndefined();
    // nothing is due yet, so the next drain leaves them; once their time comes the allowance is back
    expect((await drain(rt)).considered).toBe(0);
    await sys((tx) => tx.query("UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = ANY($1)", [waiting]));
    const later = await drain(runtime());
    expect(later).toMatchObject({ considered: 2, retained: 2 });
  });
});

describe('when the engine is not there, or not well', () => {
  it('an engine that is down backs the source off in its own row, without throwing, and the rest of the batch goes on', async () => {
    const a = await message(pubChannel, 'Engine down note.');
    const b = await message(mktChannel, 'Other team, engine fine for them.');
    await mark('message', a);
    await mark('message', b);
    stub.failRetain = new MemoryError('unavailable', 'The memory engine did not answer');
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 2, failed: 2, retained: 0 });
    for (const id of [a, b]) {
      expect(await pendingOf('message', id)).toMatchObject({ attempts: 1, in_future: true });
      expect((await pendingOf('message', id))!.last_error).toMatch(/did not answer/);
      expect(await linesOf('message', id)).toEqual([]);
    }
    // it comes back: the sources are retained on the next drain that finds them due
    stub.failRetain = null;
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = ANY($1)', [[a, b]]));
    expect(await drain()).toMatchObject({ retained: 2, failed: 0 });
    expect(await pendingOf('message', a)).toBeUndefined();
  });

  it('after the last attempt the source is logged failed and dropped', async () => {
    const id = await message(pubChannel, 'Never accepted.');
    await mark('message', id);
    await sys((tx) => tx.query("UPDATE app.memory_feed_pending SET attempts = 7 WHERE source_id = $1", [id]));
    stub.failRetain = new MemoryError('unavailable', 'nope');
    await drain();
    expect(await pendingOf('message', id)).toBeUndefined();
    expect((await linesOf('message', id)).map((l) => [l.outcome, l.reason])).toEqual([['failed', 'the engine did not take it after 8 attempts']]);
  });

  it('a forget that fails stops the retain behind it (the old text is never left beside the new)', async () => {
    const id = await message(pubChannel, 'Version one.');
    await mark('message', id);
    await drain();
    stub.reset();
    await setBody(id, 'Version two.');
    await mark('message', id);
    stub.failForget = new MemoryError('unavailable', 'forget failed');
    const stats = await drain();
    expect(stats).toMatchObject({ failed: 1, retained: 0 });
    expect(stub.retains()).toEqual([]);
    expect((await linesOf('message', id)).map((l) => l.outcome)).toEqual(['retained']);
    expect(await pendingOf('message', id)).toMatchObject({ attempts: 1 });
  });

  it('no engine configured: a change to a source the bank holds nothing for is dropped, one it holds a document for waits to be taken out', async () => {
    const held = await message(pubChannel, 'Held before the engine was switched off.');
    await mark('message', held);
    await drain();
    const doc = (await linesOf('message', held))[0]!.document_id!;
    stub.reset();

    const fresh = await message(pubChannel, 'Nobody to tell.');
    await softDelete(held);
    await mark('message', fresh);
    await mark('message', held);
    stub.enabled = false;
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 2, dropped: 1, deferred: 1, retained: 0 });
    expect(stub.calls).toEqual([]);
    expect(await pendingOf('message', fresh)).toBeUndefined();
    expect(await linesOf('message', fresh)).toEqual([]);
    expect(await pendingOf('message', held)).toMatchObject({ in_future: true });

    // the engine is back: the delete that was made while it was off is carried out
    stub.enabled = true;
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [held]));
    await drain();
    expect(stub.forgets()[0]!.ids).toEqual([doc]);
    expect((await linesOf('message', held)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });

  it('a not_configured line does not hide a document that is still in the bank: the delete after it still takes the document out', async () => {
    const id = await message(pubChannel, 'Retained, then a day of no engine, then deleted.');
    await mark('message', id);
    await drain();
    const doc = (await linesOf('message', id))[0]!.document_id!;
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason)
         VALUES ($1, $2, '(no engine)', 'message', $3, 'not_configured', 'no memory engine is configured in this deployment')`,
        [omar.workspaceId, ENG, id],
      ),
    );
    stub.reset();
    await softDelete(id);
    await mark('message', id);
    await drain();
    expect(stub.forgets()[0]!.ids).toEqual([doc]);
  });

  it('a forget that never succeeds is never given up on: the work row stays, the failure is logged once with the document, and a later success removes it', async () => {
    const id = await message(pubChannel, 'Cannot be forgotten yet.');
    await mark('message', id);
    await drain();
    const doc = (await linesOf('message', id))[0]!.document_id!;
    stub.reset();
    await softDelete(id);
    await mark('message', id);
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET attempts = 7 WHERE source_id = $1', [id]));
    stub.failForget = new MemoryError('unavailable', 'engine says no');
    await drain();
    // eighth attempt: logged as failed WITH the document, and the row is still there (half an hour on), not dropped
    expect(await pendingOf('message', id)).toMatchObject({ attempts: 8, in_future: true });
    const failed = (await linesOf('message', id)).filter((l) => l.outcome === 'failed');
    expect(failed).toMatchObject([{ document_id: doc }]);
    // a ninth attempt writes no second line, and the row stays
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [id]));
    await drain();
    expect((await linesOf('message', id)).filter((l) => l.outcome === 'failed')).toHaveLength(1);
    expect(await pendingOf('message', id)).toMatchObject({ attempts: 9 });
    // the engine recovers: the document goes, and the newest state line says so
    stub.failForget = null;
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [id]));
    await drain();
    expect(stub.forgets()[0]!.ids).toEqual([doc]);
    expect(await pendingOf('message', id)).toBeUndefined();
    expect((await linesOf('message', id)).filter((l) => l.outcome !== 'failed').map((l) => l.outcome)).toEqual(['retained', 'forgotten']);
  });

  it('an item the engine rejects (422) does not take the other items of its chunk with it: they are tried one at a time', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await message(pubChannel, i === 3 ? 'POISON that the engine will not take.' : `Fine note ${i}.`));
    for (const id of ids) await mark('message', id);
    stub.failWhen = (items) => (items.some((it) => it.content.includes('POISON')) ? new MemoryError('unavailable', 'engine said 422', 422) : null);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 6, retained: 5, failed: 1 });
    expect(stub.retains().filter((c) => !c.rejected).reduce((n, c) => n + c.items!.length, 0)).toBe(5);
    expect(await pendingOf('message', ids[3]!)).toMatchObject({ attempts: 1 });
    for (const id of ids.filter((_, i) => i !== 3)) expect((await linesOf('message', id)).map((l) => l.outcome)).toEqual(['retained']);
    stub.failWhen = null;
    await sys((tx) => tx.query('DELETE FROM app.memory_feed_pending WHERE source_id = $1', [ids[3]!]));
  });

  it('a source whose workspace has no key yet waits: the drain reads keys, it never makes one', async () => {
    const saved = KEY;
    await sys((tx) => tx.query('DELETE FROM app.memory_workspace_keys WHERE workspace_id = $1', [omar.workspaceId]));
    const id = await message(pubChannel, 'Waits for its key.');
    await mark('message', id);
    const stats = await drain();
    expect(stats).toMatchObject({ considered: 1, deferred: 1, retained: 0 });
    expect(stub.calls).toEqual([]);
    expect(await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_workspace_keys')).rows[0]!.n)).toBe(0);
    expect(await pendingOf('message', id)).toMatchObject({ in_future: true });
    // the key is there (made by a handler, committed with the work row): the source goes on
    await sys((tx) => tx.query('INSERT INTO app.memory_workspace_keys (workspace_id, key) VALUES ($1, $2)', [omar.workspaceId, saved]));
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [id]));
    expect(await drain()).toMatchObject({ retained: 1 });
  });

  it('sources of a keyless workspace warn once an hour, and are given up on after repeated waits', async () => {
    const saved = KEY;
    await sys((tx) => tx.query('DELETE FROM app.memory_workspace_keys WHERE workspace_id = $1', [omar.workspaceId]));
    const ids = [await message(pubChannel, 'Keyless one.'), await message(pubChannel, 'Keyless two.'), await message(pubChannel, 'Keyless three.')];
    for (const id of ids) await mark('message', id);
    const lines: string[] = [];
    const logger: PluginLogger = { info: () => undefined, warn: (m: string) => void lines.push(m) };
    const base = Date.now() + 10 * 24 * 3_600_000; // far from any other test's clock
    const at = (offsetMs: number): FeedRuntime => ({ ...runtime(), now: () => base + offsetMs });
    const due = () => sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = ANY($1::text[])', [ids]));

    expect(await sys((tx) => drainFeed(ctx, tx, logger, at(0)))).toMatchObject({ considered: 3, deferred: 3 });
    expect(lines.filter((l) => l.includes('no digest key'))).toHaveLength(1); // three rows, one workspace, one line
    await due();
    await sys((tx) => drainFeed(ctx, tx, logger, at(10 * 60_000)));
    expect(lines.filter((l) => l.includes('no digest key'))).toHaveLength(1); // still inside the hour
    await due();
    await sys((tx) => drainFeed(ctx, tx, logger, at(61 * 60_000)));
    expect(lines.filter((l) => l.includes('no digest key'))).toHaveLength(2);
    expect(await pendingOf('message', ids[0]!)).toMatchObject({ attempts: 3 });

    // a row that has waited for a key this many times is dropped, not looked at for ever
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET attempts = 19, not_before = now() WHERE source_id = ANY($1::text[])', [ids]));
    expect(await sys((tx) => drainFeed(ctx, tx, logger, at(62 * 60_000)))).toMatchObject({ considered: 3, dropped: 3, retained: 0 });
    for (const id of ids) expect(await pendingOf('message', id)).toBeUndefined();
    expect(stub.calls).toEqual([]);
    await sys((tx) => tx.query('INSERT INTO app.memory_workspace_keys (workspace_id, key) VALUES ($1, $2)', [omar.workspaceId, saved]));
  });

  it('a team that no longer exists is dropped quietly', async () => {
    const id = await message(pubChannel, 'The team is gone.');
    await mark('message', id);
    stub.gone.add(ENG);
    await drain();
    expect(await pendingOf('message', id)).toBeUndefined();
    expect(stub.calls).toEqual([]);
  });

  it('one drain at a time: while another holds the lock this one reads nothing', async () => {
    const id = await message(pubChannel, 'Locked out.');
    await mark('message', id);
    const holder = await sysPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('memory.feed.drain'))");
      expect(await drain()).toMatchObject({ considered: 0 });
      expect(await pendingOf('message', id)).toBeDefined();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await drain()).toMatchObject({ considered: 1, retained: 1 });
  });
});

describe('a run (the narrowest-source rule)', () => {
  it('that read only team-visible sources is retained as a summary with the run, the actor and the scopes of its source log', async () => {
    const pub = await message(pubChannel, 'A public note the run read.');
    const id = await run([['memory', 'bank:team:test:eng', 'team'], ['message', pub, 'channel']], { channelId: pubChannel });
    await mark('run', id);
    await drain();
    const item = stub.retains()[0]!.items![0]!;
    expect(item.content).toContain('The bot Memo of team engineering ran for a mention in #dev, asked by Nadia.');
    expect(item.content).toContain('It read 2 sources: 1 memory, 1 message.');
    expect(item.tags).toEqual(['feed', 'kind:run', 'bot:memo', 'trigger:mention']);
    expect(item.metadata).toMatchObject({ feed_kind: 'run', feed_id: id, actor: nadia.actorId, link: '/t/engineering/bots/memo', status: 'done' });
    expect(await linesOf('run', id)).toMatchObject([{ outcome: 'retained', run_id: id, source_scopes: ['channel', 'team'] }]);
  });

  const withheldCases: Array<{
    name: string;
    lines: () => Promise<Array<readonly [string, string, string]>>;
    options?: { trigger?: string; channel?: () => string };
    reason: string;
    scopes: string[];
  }> = [
    { name: 'read a person-scoped source', lines: async () => [['drive', 'x', 'person']], reason: 'person_source', scopes: ['person'] },
    { name: 'read a private channel message', lines: async () => [['message', await message(privChannel, 'Private words.'), 'channel']], reason: 'private_source', scopes: ['channel'] },
    { name: 'read a DM', lines: async () => [['message', await message(dmChannel, 'DM words.'), 'channel']], reason: 'private_source', scopes: ['channel'] },
  ];

  it.each(withheldCases)('that $name is withheld: nothing is retained and the log says why', async ({ lines, options, reason, scopes }) => {
    const id = await run(await lines(), { ...(options?.trigger ? { trigger: options.trigger } : {}), channelId: options?.channel ? options.channel() : null });
    await mark('run', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('run', id)).toMatchObject([{ outcome: 'withheld', reason, run_id: id, source_scopes: scopes, document_id: null }]);
    // delivered again: the same refusal is not written twice
    await mark('run', id);
    await drain();
    expect(await linesOf('run', id)).toHaveLength(1);
  });

  it('of a private conversation, a private channel or a private thread leaves no line at all, and nothing is retained', async () => {
    const ids = [
      await run([], { trigger: 'conversation' }),
      await run([], { channelId: privChannel }),
      await run([], { channelId: dmChannel }),
      // decided from the run itself, before anything it read: a DM run that also read a person source is still a DM run and leaves no line
      await run([['drive', 'x', 'person']], { channelId: dmChannel }),
      await run([['drive', 'x', 'person']], { trigger: 'conversation' }),
    ];
    for (const id of ids) await mark('run', id);
    await drain();
    expect(stub.calls).toEqual([]);
    for (const id of ids) {
      expect(await linesOf('run', id)).toEqual([]);
      expect(await pendingOf('run', id)).toBeUndefined();
    }
  });

  it('that is still open waits, and is judged when it closes; one that never closes is withheld after a day', async () => {
    const id = await run([['drive', 'x', 'person']], { status: 'running' });
    await mark('run', id);
    expect(await drain()).toMatchObject({ considered: 1, deferred: 1 });
    expect(await pendingOf('run', id)).toMatchObject({ deferred: true, in_future: true });
    expect(await linesOf('run', id)).toEqual([]);

    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [id]));
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [id]));
    expect(await drain()).toMatchObject({ withheld: 1 });
    expect(await linesOf('run', id)).toMatchObject([{ outcome: 'withheld', reason: 'person_source' }]);

    const stuck = await run([], { status: 'running' });
    await mark('run', stuck);
    await drain();
    await sys((tx) => tx.query("UPDATE app.memory_feed_pending SET not_before = now(), deferred_since = now() - interval '25 hours' WHERE source_id = $1", [stuck]));
    await drain();
    expect(await linesOf('run', stuck)).toMatchObject([{ outcome: 'withheld', reason: 'run_open' }]);
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'failed', ended_at = now() WHERE id = $1", [stuck]));
  });
});

describe('what a bot wrote during a run', () => {
  // A bot of its own, so the runs of the tests above (which are open or close to "now") never cover the instants used here.
  let writer = '';
  let writerActor = '';
  beforeAll(async () => {
    await sys(async (tx) => {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'writer', 'Writer', '', 'agent', 'rules', 'team', repeat('b', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      );
      writer = bot.rows[0]!.id;
      writerActor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, writer])).rows[0]!.id;
    });
  });

  it('a message the bot posted while its run read a person source is withheld; one outside any run is retained; an open run waits', async () => {
    // a run that read a person-scoped source, closed, and a message the bot posted inside it
    await run([['drive', 'x', 'person']], { bot: writer, startedAt: '2019-03-01T10:00:00.000Z', endedAt: '2019-03-01T10:05:00.000Z' });
    const dirty = await message(pubChannel, 'Your quarterly numbers are in the attached sheet.', { author: writerActor, at: '2019-03-01T10:02:00.000Z' });
    await mark('message', dirty);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('message', dirty)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: person_source' }]);

    // outside any run the bot's message is an ordinary team message
    const clean = await message(pubChannel, 'Reminder: the freeze starts Friday.', { author: writerActor, at: '2019-06-01T10:00:00.000Z' });
    await mark('message', clean);
    await drain();
    expect(stub.retains()).toHaveLength(1);
    expect((await linesOf('message', clean)).map((l) => l.outcome)).toEqual(['retained']);

    // a run that is still open: wait for it, then judge by what it read
    stub.reset();
    const open = await run([], { bot: writer, status: 'running', startedAt: new Date(Date.now() - 10_000).toISOString() });
    const during = await message(pubChannel, 'Working on it.', { author: writerActor });
    await mark('message', during);
    expect(await drain()).toMatchObject({ deferred: 1 });
    expect(await pendingOf('message', during)).toMatchObject({ deferred: true });
    expect(stub.calls).toEqual([]);
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [open]));
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [during]));
    expect(await drain()).toMatchObject({ retained: 1 });
  });

  it('a withheld bot root does not leak through the thread: no head, no quote, and a line for the root', async () => {
    // a run that read a person source; the bot's message (a root) was posted inside it; a person replied
    await run([['drive', 'x', 'person']], { bot: writer, startedAt: '2017-03-01T10:00:00.000Z', endedAt: '2017-03-01T10:05:00.000Z' });
    const root = await message(pubChannel, 'The Hummingbird acquisition closes at 12 million.', { author: writerActor, at: '2017-03-01T10:02:00.000Z' });
    // the copy of the root's first characters the threads table keeps (it is what the thread title used to be taken from)
    await sys((tx) => tx.query("INSERT INTO app.threads (root_message_id, channel_id, title) VALUES ($1, $2, 'The Hummingbird acquisition closes at 12 million.') ON CONFLICT (root_message_id) DO UPDATE SET title = EXCLUDED.title", [root, pubChannel]));
    const reply = await message(pubChannel, 'Is that public yet?', { author: rafi.actorId, threadRoot: root, at: '2017-03-01T10:20:00.000Z' });
    await mark('thread', root);
    await drain();
    const doc = stub.retains()[0]!.items![0]!;
    expect(doc.content).toBe(`Thread in #dev\n[2017-03-01 10:20] Rafi: Is that public yet?`);
    expect(JSON.stringify(stub.calls)).not.toMatch(/Hummingbird|12 million/);
    // the excluded message is on the record, once
    expect(await linesOf('message', root)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: person_source' }]);
    await mark('thread', root);
    await setBody(reply, 'Is that public yet? Asking for the board.');
    await drain();
    expect(await linesOf('message', root)).toHaveLength(1);
  });

  it('what a bot that no longer exists wrote is refused (its runs went with it), not read as written outside a run', async () => {
    const gone = await sys(async (tx) => {
      const bot = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'removed-later', 'Removed later', '', 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot])).rows[0]!.id;
      return { bot, actor };
    });
    // written outside any run while the bot existed: an ordinary team message
    const before = await message(pubChannel, 'Posted by a bot that was later removed.', { author: gone.actor, at: '2014-03-01T10:00:00.000Z' });
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [gone.bot]));
    await mark('message', before);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('message', before)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: bot_removed' }]);
  });

  it('a withheld line never hides a document that is still in the bank: a thread that excludes a retained root while its forget fails leaves the root held', async () => {
    // a bot's message outside any run: retained as an ordinary message
    const root = await message(pubChannel, 'The Kingfisher numbers are final.', { author: writerActor, at: '2013-03-01T10:02:00.000Z' });
    await mark('message', root);
    await drain();
    const doc = (await linesOf('message', root))[0]!.document_id!;
    // a run of that bot that read a person source is now on record around that instant, and a person replied
    await run([['drive', 'x', 'person']], { bot: writer, startedAt: '2013-03-01T10:00:00.000Z', endedAt: '2013-03-01T10:05:00.000Z' });
    await message(pubChannel, 'Where do those come from?', { author: rafi.actorId, threadRoot: root, at: '2013-03-01T10:30:00.000Z' });
    stub.reset();
    await mark('thread', root);
    await mark('message', root);
    stub.failForget = new MemoryError('unavailable', 'engine says no');
    await drain();
    // the root's own forget failed; the thread document excludes it, and that exclusion is NOT a line that says "nothing is held"
    expect((await linesOf('message', root)).map((l) => l.outcome)).toEqual(['retained']);
    expect(await pendingOf('message', root)).toMatchObject({ attempts: 1 });
    // the engine recovers: the document is taken out, because it is still held
    stub.failForget = null;
    await sys((tx) => tx.query('UPDATE app.memory_feed_pending SET not_before = now() WHERE source_id = $1', [root]));
    await drain();
    expect(stub.forgets()[0]!.ids).toEqual([doc]);
    expect((await linesOf('message', root)).map((l) => l.outcome)).toEqual(['retained', 'forgotten']);
  });

  it('a bot reply in a thread whose run read a person source is left out of the thread document; the people’s messages stay', async () => {
    const root = await message(pubChannel, 'Who has the Q3 numbers?', { at: '2018-03-01T10:00:00.000Z' });
    await run([['drive', 'x', 'person']], { bot: writer, startedAt: '2018-03-01T10:01:00.000Z', endedAt: '2018-03-01T10:03:00.000Z' });
    await message(pubChannel, 'They are in the finance drive: 4.2M.', { author: writerActor, threadRoot: root, at: '2018-03-01T10:02:00.000Z' });
    await message(pubChannel, 'Thanks, I will check.', { author: rafi.actorId, threadRoot: root, at: '2018-03-01T10:10:00.000Z' });
    await mark('thread', root);
    await drain();
    const content = stub.retains()[0]!.items![0]!.content;
    expect(content).toContain('Nadia: Who has the Q3 numbers?');
    expect(content).toContain('Rafi: Thanks, I will check.');
    expect(content).not.toContain('4.2M');
    expect(content).not.toContain('finance drive');
  });
});

describe('an approval', () => {
  const approval = (over: { status?: string; channelId?: string | null; runId?: string | null; tool?: string }): Promise<string> =>
    sys(async (tx) => {
      const status = over.status ?? 'approved';
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, requester_name, bot_id, run_id, channel_id, decided_at)
           VALUES ($1, $2, 'grant', $3, $4, $5, $6, '{}', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $7, 'Nadia', $8, $9, $10, $11) RETURNING id`,
          [
            omar.workspaceId,
            ENG,
            status,
            status === 'approved' ? 'ran' : 'none',
            over.tool ?? 'pages.write',
            'Write pages/reports/q3.md',
            nadia.actorId,
            botId,
            over.runId ?? null,
            over.channelId ?? null,
            status === 'pending' ? null : new Date().toISOString(),
          ],
        )
      ).rows[0]!.id;
      if (status === 'approved' || status === 'denied') {
        await tx.query(
          `INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision) VALUES ($1, $2, $3, $4, 'Omar', $5)`,
          [id, omar.workspaceId, ENG, omar.actorId, status],
        );
      }
      return id;
    });

  it('a decided one is retained without its arguments; a pending one waits; one from a private channel is never read', async () => {
    const done = await approval({ channelId: pubChannel });
    await mark('approval', done);
    await drain();
    const item = stub.retains()[0]!.items![0]!;
    expect(item.content).toContain('Approval requested by Memo (for Nadia) in #dev: Write pages/reports/q3.md');
    expect(item.content).toContain('Approved by Omar');
    expect(item.metadata).toMatchObject({ feed_kind: 'approval', feed_id: done, link: '/t/engineering/approvals', tool: 'pages.write' });
    expect(await linesOf('approval', done)).toMatchObject([{ outcome: 'retained' }]);

    stub.reset();
    const pending = await approval({ status: 'pending' });
    const priv = await approval({ channelId: privChannel });
    for (const id of [pending, priv]) await mark('approval', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('approval', pending)).toEqual([]);
    expect(await linesOf('approval', priv)).toEqual([]);
  });

  it('one raised by a run that read a person source is withheld with that reason', async () => {
    const r = await run([['drive', 'x', 'person']]);
    const id = await approval({ runId: r });
    await mark('approval', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('approval', id)).toMatchObject([{ outcome: 'withheld', reason: 'person_source', run_id: r }]);
  });
});

describe('a page', () => {
  /** `indexedAt` undefined: the column default (now); null: a commit indexed before the column existed; a string: that instant. */
  const put = (path: string, text: string | null, options: { author?: string; committedAt?: string; indexedAt?: string | null } = {}): Promise<string> =>
    sys(async (tx) => {
      const sha = (await tx.query<{ sha: string }>("SELECT md5(random()::text) || md5(random()::text) || 'abcdefgh' AS sha")).rows[0]!.sha.slice(0, 40);
      await tx.query(
        options.indexedAt === undefined
          ? `INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, $2, $3, 'write', coalesce($5::timestamptz, now()), ARRAY[$4]::text[])`
          : `INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths, indexed_at) VALUES ($1, $2, $3, 'write', coalesce($5::timestamptz, now()), ARRAY[$4]::text[], $6::timestamptz)`,
        options.indexedAt === undefined
          ? [ENG, sha, options.author ?? omar.actorId, path, options.committedAt ?? null]
          : [ENG, sha, options.author ?? omar.actorId, path, options.committedAt ?? null, options.indexedAt],
      );
      await tx.query(
        `INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain) VALUES ($1, $2, $3, 10, $4, $5)
         ON CONFLICT (team_id, path) DO UPDATE SET blob_sha = EXCLUDED.blob_sha, last_commit_sha = EXCLUDED.last_commit_sha, text_plain = EXCLUDED.text_plain`,
        [ENG, path, sha, sha, text],
      );
      return `${ENG}/${path}`;
    });

  it('is retained from the index with its path, author and link; a rewrite replaces it; a delete forgets it', async () => {
    const source = await put('pages/reports/q3.md', '# Q3 report\n\nRevenue grew.');
    await mark('page', source);
    await drain();
    const item = stub.retains()[0]!.items![0]!;
    expect(item.content).toMatch(/^Page pages\/reports\/q3\.md, last written by Omar on /);
    expect(item.content).toContain('Revenue grew.');
    expect(item.metadata).toMatchObject({ feed_kind: 'page', link: '/t/engineering/files?open=pages%2Freports%2Fq3.md', path: 'pages/reports/q3.md', actor: omar.actorId });

    stub.reset();
    await put('pages/reports/q3.md', '# Q3 report\n\nRevenue grew by ten percent.');
    await mark('page', source);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget', 'retain']);

    stub.reset();
    await sys((tx) => tx.query("DELETE FROM app.repo_entries WHERE team_id = $1 AND path = 'pages/reports/q3.md'", [ENG]));
    await mark('page', source);
    await drain();
    expect(stub.calls.map((c) => c.op)).toEqual(['forget']);
    expect((await linesOf('page', source)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });

  it('a bot page committed before indexed_at existed (NULL) is judged at its author date, not at the instant of the migration', async () => {
    const bot = await sys(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'page-writer-legacy', 'Legacy page writer', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, id])).rows[0]!.id;
      return { id, actor };
    });
    // a run of that bot is open NOW (what was in flight when the migration ran), and a person-source run covered the page's real time
    const open = await run([], { bot: bot.id, status: 'running' });
    await run([['drive', 'x', 'person']], { bot: bot.id, startedAt: '2011-03-01T10:00:00.000Z', endedAt: '2011-03-01T10:05:00.000Z' });
    const refused = await put('pages/legacy-refused.md', 'Written inside the person-source run.', { author: bot.actor, committedAt: '2011-03-01T10:02:00.000Z', indexedAt: null });
    const clean = await put('pages/legacy-clean.md', 'Written long ago, outside any run.', { author: bot.actor, committedAt: '2011-07-01T10:00:00.000Z', indexedAt: null });
    await mark('page', refused);
    await mark('page', clean);
    await drain();
    expect(await linesOf('page', refused)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: person_source' }]);
    // not deferred by the run that is open now: its time is the author date
    expect((await linesOf('page', clean)).map((l) => l.outcome)).toEqual(['retained']);
    expect(await pendingOf('page', clean)).toBeUndefined();
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [open]));
  });

  it('only pages are read: a path outside pages/ is not a page', async () => {
    const source = await put('routines/weekly.yaml', 'schedule: weekly');
    await mark('page', source);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('page', source)).toEqual([]);
  });
});

describe('after retention pruned the run', () => {
  /** What retention does to a run: the memo first, then the run (its source lines go with it). */
  const prune = (id: string): Promise<unknown> =>
    sys(async (tx) => {
      await tx.query('SELECT app.memory_memoize_runs($1::uuid[])', [[id]]);
      await tx.query('DELETE FROM app.bot_runs WHERE id = $1', [id]);
    });
  const approvalOf = (runId: string, status: 'approved' | 'denied'): Promise<string> =>
    sys(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, requester_name, bot_id, run_id, decided_at)
           VALUES ($1, $2, 'grant', $3, $4, 'pages.write', 'Write pages/reports/q3.md', '{}', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $5, 'Nadia', $6, $7, now()) RETURNING id`,
          [omar.workspaceId, ENG, status, status === 'approved' ? 'ran' : 'none', nadia.actorId, botId, runId],
        )
      ).rows[0]!.id;
      await tx.query('INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision) VALUES ($1, $2, $3, $4, $5, $6)', [id, omar.workspaceId, ENG, omar.actorId, 'Omar', status]);
      return id;
    });

  it('a run summary that is in the bank stays there: the source is gone, the memory is not (a run that is gone any other way still forgets)', async () => {
    const kept = await run([['memory', 'bank:team:test', 'team']]);
    const removed = await run([['memory', 'bank:team:test', 'team']]);
    for (const id of [kept, removed]) await mark('run', id);
    await drain();
    expect((await linesOf('run', kept)).map((l) => l.outcome)).toEqual(['retained']);
    stub.reset();

    await prune(kept);
    await sys((tx) => tx.query('DELETE FROM app.bot_runs WHERE id = $1', [removed])); // no memo: not retention's doing
    for (const id of [kept, removed]) await mark('run', id);
    await drain();
    expect((await linesOf('run', kept)).map((l) => l.outcome)).toEqual(['retained']);
    expect((await linesOf('run', removed)).map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'gone']]);
    expect(stub.forgets()).toHaveLength(1);
  });

  it('an approval withheld because its run read a person source is withheld after the run is pruned, and is not retained', async () => {
    const r = await run([['drive', 'finance/q3.xlsx', 'person']]);
    const id = await approvalOf(r, 'approved');
    await mark('approval', id);
    await drain();
    expect(await linesOf('approval', id)).toMatchObject([{ outcome: 'withheld', reason: 'person_source' }]);
    stub.reset();

    await prune(r);
    const row = await sys(async (tx) => (await tx.query<{ run_id: string | null; had_run: boolean }>('SELECT run_id, had_run FROM app.approvals WHERE id = $1', [id])).rows[0]);
    expect(row).toEqual({ run_id: null, had_run: true });
    await mark('approval', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('approval', id)).toHaveLength(1);
  });

  it('an approval whose run is gone and left no memo cannot be judged, which is a refusal (never "a run that read nothing")', async () => {
    const r = await run([['memory', 'bank:team:test', 'team']]);
    const id = await approvalOf(r, 'denied');
    await sys((tx) => tx.query('DELETE FROM app.bot_runs WHERE id = $1', [r]));
    await mark('approval', id);
    await drain();
    expect(stub.calls).toEqual([]);
    expect(await linesOf('approval', id)).toMatchObject([{ outcome: 'withheld', reason: 'run_gone' }]);
  });

  it('an approval whose pruned run read only the team’s own sources is retained as before', async () => {
    const r = await run([['memory', 'bank:team:test', 'team']]);
    const id = await approvalOf(r, 'approved');
    await prune(r);
    await mark('approval', id);
    await drain();
    expect(stub.retains()).toHaveLength(1);
    expect(await linesOf('approval', id)).toMatchObject([{ outcome: 'retained' }]);
  });
});
