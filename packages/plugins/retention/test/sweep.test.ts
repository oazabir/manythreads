import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  gatewayMcpMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  retentionMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyCounts, startSweep, sweepStep, type SweepState } from '../src/sweep.ts';
import type { RetentionCounts } from '@manythreads/shared';

// The sweep against a real database: which runs go and which stay, that the feed's verdict about what a bot wrote does not change when the run
// it was made from is pruned, what is removed from the retain log (and what never is), batches, dry runs and per-workspace windows.
// Each step is its own system transaction, as the job would make it.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const DAY = 24 * 3_600_000;

let db: TestDatabase;
let sysPool: pg.Pool;
let owner: pg.Client;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const ago = (days: number, extraMs = 0): string => new Date(Date.now() - days * DAY + extraMs).toISOString();

interface Fixture {
  bot: string;
  actor: string;
}
let main: Fixture;
let channelId = '';

async function makeBot(slug: string, workspaceId: string = omar.workspaceId, teamId: string = ENG): Promise<Fixture> {
  return sys(async (tx) => {
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [workspaceId, teamId, slug],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [workspaceId, bot])).rows[0]!.id;
    return { bot, actor };
  });
}

interface RunOptions {
  bot?: Fixture;
  workspaceId?: string;
  teamId?: string;
  status?: 'running' | 'done' | 'failed' | 'stopped';
  startedAt?: string;
  endedAt?: string | null;
  lines?: ReadonlyArray<readonly [string, string, string]>;
}
async function run(options: RunOptions = {}): Promise<string> {
  const status = options.status ?? 'done';
  return sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at, ended_at)
         VALUES ($1, $2, $3, 'mention', $4, $5, $6::timestamptz, $7::timestamptz) RETURNING id`,
        [
          options.workspaceId ?? omar.workspaceId,
          (options.bot ?? main).bot,
          options.teamId ?? ENG,
          options.workspaceId === undefined ? nadia.actorId : null,
          status,
          options.startedAt ?? ago(100, -60_000),
          status === 'running' ? null : (options.endedAt ?? ago(100)),
        ],
      )
    ).rows[0]!.id;
    for (const [i, [type, ref, scope]] of (options.lines ?? []).entries()) {
      await tx.query('INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, $2, $3, $4, $5)', [id, i, type, ref, scope]);
    }
    return id;
  });
}

const runExists = async (id: string): Promise<boolean> => sys(async (tx) => (await tx.query('SELECT 1 FROM app.bot_runs WHERE id = $1', [id])).rows.length > 0);
const linesLeft = async (id: string): Promise<number> => sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.run_source_log WHERE run_id = $1', [id])).rows[0]!.n);

const approval = (runId: string, status: 'pending' | 'approved' | 'denied', outcome = status === 'approved' ? 'ran' : 'none', tool = 'pages.write'): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, requester_name, bot_id, run_id, decided_at)
         VALUES ($1, $2, 'grant', $3, $4, $8, 'Write pages/x.md', '{}', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $5, 'Nadia',
                 (SELECT bot_id FROM app.bot_runs WHERE id = $6), $6, $7) RETURNING id`,
        [omar.workspaceId, ENG, status, outcome, nadia.actorId, runId, status === 'pending' ? null : new Date().toISOString(), tool],
      )
    ).rows[0]!.id;
    if (status !== 'pending') {
      await tx.query(
        'INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, omar.workspaceId, ENG, omar.actorId, 'Omar', status],
      );
    }
    return id;
  });

async function message(author: string, at: string, body = 'The numbers are in.'): Promise<string> {
  return sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          'INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, created_at) VALUES ($1, $2, $3, $4, $4, $5::timestamptz) RETURNING id',
          [omar.workspaceId, channelId, author, body, at],
        )
      ).rows[0]!.id,
  );
}

const verdict = async (actor: string, at: string) =>
  sys(
    async (tx) =>
      (await tx.query<{ run_open: boolean; retain_refusal: string | null; runs: number }>('SELECT run_open, retain_refusal, runs FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [actor, at])).rows[0]!,
  );

const logLine = (over: { kind?: string; id: string; outcome: string; at: string; reason?: string; workspaceId?: string; team?: string; doc?: string | null }): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason, document_id, created_at)
       VALUES ($1, $2, 'team:test:eng', $3, $4, $5, $6, $7, $8::timestamptz)`,
      [over.workspaceId ?? omar.workspaceId, over.team ?? ENG, over.kind ?? 'message', over.id, over.outcome, over.reason ?? '', over.doc === undefined ? `feed:x:${over.id}` : over.doc, over.at],
    ),
  );
const logOf = (id: string) =>
  sys(async (tx) => (await tx.query<{ outcome: string; reason: string }>('SELECT outcome, reason FROM app.memory_retain_log WHERE source_id = $1 ORDER BY id', [id])).rows.map((r) => [r.outcome, r.reason]));

/** One whole sweep, step by step, each in its own transaction. Returns the counts and how many steps it took. */
async function sweep(options: { workspaceId?: string; dryRun?: boolean; forge?: (state: SweepState) => SweepState } = {}): Promise<{ counts: RetentionCounts; steps: number }> {
  const workspaceId = options.workspaceId ?? omar.workspaceId;
  const started: SweepState = await sys((tx) => startSweep(tx, workspaceId, new Date(), options.dryRun ?? false));
  let state: SweepState = options.forge ? options.forge(started) : started;
  for (let steps = 1; steps < 200; steps += 1) {
    const current = state;
    const result = await sys((tx) => sweepStep(tx, current));
    if (result.done) return { counts: result.summary.counts, steps };
    state = result.state;
  }
  throw new Error('the sweep did not finish');
}

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      gatewayMcpMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
      retentionMigrationSource,
    ],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
  main = await makeBot('archivist');
  channelId = await sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'dev', 'channel', false) RETURNING id", [omar.workspaceId, ENG])
      ).rows[0]!.id,
  );
}, 180_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_RETENTION_BATCH'];
  await sysPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  delete process.env['MANYTHREADS_RETENTION_BATCH'];
  // every test starts from no runs, no memos, and no log lines (the fixtures of the one before must not change the counts of this one)
  await sys(async (tx) => {
    await tx.query('DELETE FROM app.approvals');
    await tx.query('DELETE FROM app.bot_runs');
    await tx.query('DELETE FROM app.memory_run_memo');
    await tx.query('DELETE FROM app.memory_feed_pending');
    await tx.query('DELETE FROM app.retention_settings');
  });
});

describe('which runs are pruned', () => {
  it('ended runs older than the window go, with their source lines; younger ones, running ones and ones a pending approval needs stay', async () => {
    const old = await run({ lines: [['message', 'x', 'team'], ['page', 'pages/a.md', 'team']] });
    const oldFailed = await run({ status: 'failed', startedAt: ago(120, -60_000), endedAt: ago(120) });
    const young = await run({ startedAt: ago(10, -60_000), endedAt: ago(10), lines: [['message', 'y', 'team']] });
    const justInside = await run({ startedAt: ago(89, -60_000), endedAt: ago(89) });
    const stillRunning = await run({ status: 'running', startedAt: ago(200) });
    const waiting = await run({ status: 'stopped', lines: [['drive', 'q3.xlsx', 'person']] });
    await approval(waiting, 'pending');
    const resuming = await run({ status: 'stopped' });
    await approval(resuming, 'approved', 'queued');
    const settled = await run({ status: 'stopped' });
    const settledApproval = await approval(settled, 'approved', 'ran');

    const { counts } = await sweep();
    expect(counts).toMatchObject({ runs: 3, runSourceLines: 2 });

    for (const gone of [old, oldFailed, settled]) expect(await runExists(gone)).toBe(false);
    for (const kept of [young, justInside, stillRunning, waiting, resuming]) expect(await runExists(kept)).toBe(true);
    expect(await linesLeft(old)).toBe(0);
    expect(await linesLeft(young)).toBe(1);
    expect(await linesLeft(waiting)).toBe(1); // the approval's resume still needs what the run read

    // the decided approval and its decision are not run logs: they stay, with no run
    const row = await sys(async (tx) =>
      (await tx.query<{ run_id: string | null; had_run: boolean; decisions: number }>(
        `SELECT a.run_id, a.had_run, (SELECT count(*)::int FROM app.approval_decisions d WHERE d.approval_id = a.id) AS decisions FROM app.approvals a WHERE a.id = $1`,
        [settledApproval],
      )).rows[0],
    );
    expect(row).toEqual({ run_id: null, had_run: true, decisions: 1 });
  });

  it('takes the run endpoint tokens with it', async () => {
    const old = await run();
    await sys((tx) =>
      tx.query(`INSERT INTO app.mcp_run_tokens (run_id, bot_id, token_hash, expires_at) VALUES ($1, $2, decode(md5('t'), 'hex'), now() + interval '1 day')`, [old, main.bot]),
    );
    const { counts } = await sweep();
    expect(counts.runTokens).toBe(1);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.mcp_run_tokens WHERE run_id = $1', [old])).rows.length)).toBe(0);
  });

  it('a dry run counts what it would do and deletes nothing', async () => {
    const old = await run({ lines: [['message', 'x', 'team']] });
    const { counts } = await sweep({ dryRun: true });
    expect(counts).toMatchObject({ runs: 1, runSourceLines: 1, runMemos: 0 });
    expect(await runExists(old)).toBe(true);
    expect(await linesLeft(old)).toBe(1);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_run_memo')).rows.length)).toBe(0);
  });

  it('works in batches, each its own step, and finds every run exactly once', async () => {
    process.env['MANYTHREADS_RETENTION_BATCH'] = '2';
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await run({ startedAt: ago(100 + i, -60_000), endedAt: ago(100 + i) }));
    const keep = await run({ status: 'running', startedAt: ago(300) });
    const dry = await sweep({ dryRun: true });
    expect(dry.counts.runs).toBe(5);
    const real = await sweep();
    expect(real.counts.runs).toBe(5);
    expect(real.steps).toBeGreaterThanOrEqual(4); // three run batches, the log, the memos
    for (const id of ids) expect(await runExists(id)).toBe(false);
    expect(await runExists(keep)).toBe(true);
  });

  it('prunes by the workspace’s own window, and one workspace’s window never reaches another’s runs', async () => {
    const other = await sys(async (tx) => {
      const ws = (await tx.query<{ id: string }>("INSERT INTO app.workspaces (slug, name) VALUES ('other-co', 'Other Co') RETURNING id")).rows[0]!.id;
      const team = (await tx.query<{ id: string }>("INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'ops', 'Ops') RETURNING id", [ws])).rows[0]!.id;
      return { ws, team };
    });
    const otherBot = await makeBot('other-bot', other.ws, other.team);
    // 45 days old: inside the default 90, outside a 30-day window
    const mine = await run({ startedAt: ago(45, -60_000), endedAt: ago(45) });
    const theirs = await run({ bot: otherBot, workspaceId: other.ws, teamId: other.team, startedAt: ago(45, -60_000), endedAt: ago(45) });
    await sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, run_log_days) VALUES ($1, 30)', [other.ws]));

    expect((await sweep()).counts.runs).toBe(0);
    expect(await runExists(mine)).toBe(true);
    expect((await sweep({ workspaceId: other.ws })).counts.runs).toBe(1);
    expect(await runExists(theirs)).toBe(false);
    expect(await runExists(mine)).toBe(true);
  });

  it('a run a legacy never-gated approval row points at is left alone (deleting it would UPDATE that row through SET NULL and its NOT VALID check would refuse)', async () => {
    await owner.query('ALTER TABLE app.approvals DROP CONSTRAINT approvals_never_gated');
    let legacy = '';
    try {
      legacy = await run({ status: 'stopped' });
      await approval(legacy, 'denied', 'none', 'memory.retain');
    } finally {
      await owner.query("ALTER TABLE app.approvals ADD CONSTRAINT approvals_never_gated CHECK (tool NOT IN ('memory.retain')) NOT VALID");
    }
    const fine = await run();
    const { counts } = await sweep();
    expect(counts).toMatchObject({ runs: 1, runsSkipped: 0 });
    expect(await runExists(fine)).toBe(false);
    expect(await runExists(legacy)).toBe(true);
  });

  it('a delete the database refuses anyway is retried run by run: the others go, the one is counted and left, and the sweep finishes', async () => {
    let poison = '';
    await owner.query('ALTER TABLE app.approvals DROP CONSTRAINT IF EXISTS approvals_test_poison');
    try {
      poison = await run({ startedAt: ago(110, -60_000), endedAt: ago(110) });
      await approval(poison, 'denied', 'none', 'x.poison');
      await owner.query("ALTER TABLE app.approvals ADD CONSTRAINT approvals_test_poison CHECK (tool <> 'x.poison') NOT VALID");
      const good1 = await run({ startedAt: ago(105, -60_000), endedAt: ago(105) });
      const good2 = await run({ startedAt: ago(100, -60_000), endedAt: ago(100) });
      const { counts } = await sweep();
      expect(counts).toMatchObject({ runs: 2, runsSkipped: 1 });
      expect(await runExists(good1)).toBe(false);
      expect(await runExists(good2)).toBe(false);
      expect(await runExists(poison)).toBe(true);
      // and the next night it is the same one, not a stalled chain
      expect((await sweep()).counts).toMatchObject({ runs: 0, runsSkipped: 1 });
    } finally {
      await owner.query('ALTER TABLE app.approvals DROP CONSTRAINT IF EXISTS approvals_test_poison');
    }
  });

  it('does not trust its payload: a forged recent cutoff deletes what the workspace’s window says and nothing else', async () => {
    const young = await run({ startedAt: ago(10, -60_000), endedAt: ago(10) });
    const middling = await run({ startedAt: ago(45, -60_000), endedAt: ago(45) });
    const old = await run();
    // inside the 365-day window: a trusted forged cutoff of "now" would prune the two superseded lines
    await logLine({ id: 'forged-a', outcome: 'retained', at: ago(100) });
    await logLine({ id: 'forged-a', outcome: 'forgotten', at: ago(99), reason: 'replaced' });
    await logLine({ id: 'forged-a', outcome: 'retained', at: ago(98) });
    const { counts } = await sweep({ forge: (state) => ({ ...state, runLogCutoff: new Date().toISOString(), memoryLogCutoff: new Date().toISOString() }) });
    expect(counts).toMatchObject({ runs: 1, memoryLogLines: 0 });
    expect(await runExists(old)).toBe(false);
    expect(await runExists(young)).toBe(true);
    expect(await runExists(middling)).toBe(true);
    expect(await logOf('forged-a')).toHaveLength(3);
    // a cutoff below the bound's minimum is lifted to it as well: the window is 90 days here, but the floor is what a hand-set row could not pass
    await sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, run_log_days) VALUES ($1, 30)', [omar.workspaceId]));
    const forgedOld = await sweep({ forge: (state) => ({ ...state, runLogCutoff: ago(1) }) });
    expect(forgedOld.counts.runs).toBe(1); // the 45-day run, by the 30-day window — and not the 10-day one
    expect(await runExists(middling)).toBe(false);
    expect(await runExists(young)).toBe(true);
  });

  it('a payload for another workspace is judged by that workspace’s window, and a window mid-sweep that is longer wins over the payload', async () => {
    const run45 = await run({ startedAt: ago(45, -60_000), endedAt: ago(45) });
    await sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, run_log_days) VALUES ($1, 30)', [omar.workspaceId]));
    // the sweep started under a 30-day window; an admin then lengthened it to 200 days before the step ran
    const started = await sys((tx) => startSweep(tx, omar.workspaceId, new Date(), false));
    await sys((tx) => tx.query('UPDATE app.retention_settings SET run_log_days = 200 WHERE workspace_id = $1', [omar.workspaceId]));
    const result = await sys((tx) => sweepStep(tx, started));
    expect(result.done).toBe(false);
    expect(await runExists(run45)).toBe(true);
  });

  it('a row made by a sweep says nothing was ever changed: updated_at stays NULL until an admin changes a window', async () => {
    await sys((tx) => tx.query("INSERT INTO app.retention_settings (workspace_id, last_dry_run) VALUES ($1, '{}'::jsonb)", [omar.workspaceId]));
    const row = await sys(async (tx) => (await tx.query<{ updated_at: Date | null; last_sweep: unknown }>('SELECT updated_at, last_sweep FROM app.retention_settings WHERE workspace_id = $1', [omar.workspaceId])).rows[0]);
    expect(row).toEqual({ updated_at: null, last_sweep: null });
  });

  it('the window cannot be set below its bound (the table refuses it)', async () => {
    await expect(sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, run_log_days) VALUES ($1, 7)', [omar.workspaceId]))).rejects.toMatchObject({ code: '23514' });
    await expect(sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, memory_log_days) VALUES ($1, 10)', [omar.workspaceId]))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the feed’s verdict about what a bot wrote does not depend on a run that was pruned', () => {
  it('a message withheld because its run read a person source is still withheld after the run is gone', async () => {
    const bot = await makeBot('verdict-bot');
    const at = ago(100, 120_000);
    await run({ bot, startedAt: ago(100, -60_000), endedAt: ago(100, 300_000), lines: [['drive', 'finance/q3.xlsx', 'person']] });
    await message(bot.actor, at);

    expect(await verdict(bot.actor, at)).toMatchObject({ retain_refusal: 'person_source', runs: 1 });
    const { counts } = await sweep();
    expect(counts).toMatchObject({ runs: 1, runMemos: 1 });
    // the run and its log are gone; the verdict is the same
    expect(await verdict(bot.actor, at)).toMatchObject({ run_open: false, retain_refusal: 'person_source', runs: 1 });
    // a message the bot wrote an hour after the run was outside it, then and now
    expect(await verdict(bot.actor, ago(100, 3_900_000))).toMatchObject({ retain_refusal: null, runs: 0 });
  });

  it('without the memo the same prune would have made it retainable (the control: the test above is not vacuous)', async () => {
    const bot = await makeBot('control-bot');
    const at = ago(100, 120_000);
    const id = await run({ bot, startedAt: ago(100, -60_000), endedAt: ago(100, 300_000), lines: [['drive', 'finance/q3.xlsx', 'person']] });
    await message(bot.actor, at);
    expect(await verdict(bot.actor, at)).toMatchObject({ retain_refusal: 'person_source' });
    await sys((tx) => tx.query('DELETE FROM app.bot_runs WHERE id = $1', [id])); // pruned without a memo
    expect(await verdict(bot.actor, at)).toMatchObject({ retain_refusal: null, runs: 0 });
  });

  it('a page a bot wrote in the run is judged the same way', async () => {
    const bot = await makeBot('page-bot');
    const startedAt = ago(100, -60_000);
    const endedAt = ago(100, 300_000);
    await run({ bot, startedAt, endedAt, lines: [['drive', 'x', 'person']] });
    await sys(async (tx) => {
      const sha = 'f'.repeat(40);
      await tx.query(`INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, $2, $3, 'write', $4::timestamptz, ARRAY['pages/r.md'])`, [ENG, sha, bot.actor, ago(100, 120_000)]);
    });
    expect((await sweep()).counts.runMemos).toBe(1);
    expect(await verdict(bot.actor, ago(100, 120_000))).toMatchObject({ retain_refusal: 'person_source' });
  });

  it('a run that read only the team’s own sources and wrote nothing leaves no memo', async () => {
    await run({ lines: [['memory', 'bank:team:test', 'team']] });
    const { counts } = await sweep();
    expect(counts).toMatchObject({ runs: 1, runMemos: 0 });
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_run_memo')).rows.length)).toBe(0);
  });

  it('a refusing run that wrote nothing in its window needs no memo either (a DM chat is not worth a row)', async () => {
    await run({ lines: [['drive', 'x', 'person']] });
    expect((await sweep()).counts.runMemos).toBe(0);
  });

  it('a run an approval was filed from leaves a memo (clean or not); a run whose summary the bank holds leaves none', async () => {
    const held = await run();
    await logLine({ kind: 'run', id: held, outcome: 'retained', at: ago(99) });
    const filed = await run({ lines: [['drive', 'x', 'person']] });
    const approvalId = await approval(filed, 'denied');
    const filedClean = await run({ lines: [['memory', 'bank:team:test', 'team']] });
    const cleanApproval = await approval(filedClean, 'approved');
    const { counts } = await sweep();
    expect(counts.runMemos).toBe(2);
    const memos = await sys(async (tx) => (await tx.query<{ run_id: string; retain_refusal: string | null; approval_ids: string[] }>('SELECT run_id, retain_refusal, approval_ids FROM app.memory_run_memo ORDER BY run_id')).rows);
    expect(memos.find((m) => m.run_id === held)).toBeUndefined();
    expect(memos.find((m) => m.run_id === filed)).toMatchObject({ retain_refusal: 'person_source', approval_ids: [approvalId] });
    expect(memos.find((m) => m.run_id === filedClean)).toMatchObject({ retain_refusal: null, approval_ids: [cleanApproval] });
  });

  // The table of what leaves a memo and what does not, and that no verdict about what a bot wrote moves in any row of it.
  describe.each([
    { refusal: 'person', wrote: 'message', approved: false, memo: true },
    { refusal: 'person', wrote: 'page', approved: false, memo: true },
    { refusal: 'person', wrote: 'nothing', approved: false, memo: false },
    { refusal: 'person', wrote: 'nothing', approved: true, memo: true },
    { refusal: 'person', wrote: 'message', approved: true, memo: true },
    { refusal: 'none', wrote: 'message', approved: false, memo: false },
    { refusal: 'none', wrote: 'nothing', approved: false, memo: false },
    { refusal: 'none', wrote: 'message', approved: true, memo: true },
  ])('a run that read $refusal sources, wrote $wrote, approval filed: $approved', (row) => {
    it(`memo ${row.memo ? 'written' : 'not written'}, and the verdict is the same after the prune`, async () => {
      const bot = await makeBot(`matrix-${row.refusal}-${row.wrote}-${row.approved}`);
      const startedAt = ago(100, -60_000);
      const endedAt = ago(100, 300_000);
      const inside = ago(100, 120_000);
      const outside = ago(100, 3_900_000);
      const id = await run({ bot, startedAt, endedAt, lines: row.refusal === 'person' ? [['drive', 'x', 'person']] : [['memory', 'bank:team:test', 'team']] });
      if (row.wrote === 'message') await message(bot.actor, inside);
      if (row.wrote === 'page') {
        await sys((tx) =>
          tx.query(`INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, md5($2::text) || 'aaaaaaaa', $3, 'write', $4::timestamptz, ARRAY['pages/m.md'])`, [ENG, bot.bot, bot.actor, inside]),
        );
      }
      if (row.approved) await approval(id, 'approved');
      const instants = [startedAt, inside, endedAt, outside, ago(101)];
      const before = await Promise.all(instants.map((at) => verdict(bot.actor, at)));
      const { counts } = await sweep();
      expect(counts.runs).toBe(1);
      expect(counts.runMemos).toBe(row.memo ? 1 : 0);
      const after = await Promise.all(instants.map((at) => verdict(bot.actor, at)));
      // The feed asks for a verdict at the instants of what a bot wrote. Wherever the bot wrote something in the run's window, the answer is the same
      // after the prune: the refusal the run had, and never "open". Where it wrote nothing there is nothing to judge, and no memo is needed.
      if (row.wrote !== 'nothing') {
        expect(after[1]).toMatchObject({ run_open: false, retain_refusal: before[1]!.retain_refusal });
        expect(after[1]!.retain_refusal).toBe(row.refusal === 'person' ? 'person_source' : null);
      }
      // an instant outside the window was never covered, before or after
      expect(after[3]).toMatchObject({ retain_refusal: null, runs: 0 });
    });
  });

  it('a refusing run whose commit was not indexed yet when it was pruned still withholds the page after the reindex', async () => {
    const bot = await makeBot('unindexed-bot');
    const startedAt = ago(100, -60_000);
    const endedAt = ago(100, 300_000);
    const inside = ago(100, 120_000);
    const id = await run({ bot, startedAt, endedAt, lines: [['drive', 'x', 'person']] });
    // the feed already said something about the run: its summary was withheld (the footprint). The bot's commit is in git, not in repo_commits.
    await logLine({ kind: 'run', id, outcome: 'withheld', reason: 'person_source', at: ago(100), doc: null });
    expect((await sweep()).counts).toMatchObject({ runs: 1, runMemos: 1 });
    // the reindex heals: the commit's time falls inside the pruned run's window
    await sys((tx) =>
      tx.query(`INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, md5('late') || 'bbbbbbbb', $2, 'write', $3::timestamptz, ARRAY['pages/late.md'])`, [ENG, bot.actor, inside]),
    );
    expect(await verdict(bot.actor, inside)).toMatchObject({ retain_refusal: 'person_source' });
  });

  it('a footprint by run id counts too (a message of the run was withheld), and a refusing run with no footprint and nothing authored leaves nothing', async () => {
    const bot = await makeBot('footprint-bot');
    const withLine = await run({ bot, startedAt: ago(100, -60_000), endedAt: ago(100, 300_000), lines: [['drive', 'x', 'person']] });
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason, run_id, created_at)
         VALUES ($1, $2, 'b', 'message', 'some-message', 'withheld', 'authoring run: person_source', $3, now() - interval '100 days')`,
        [omar.workspaceId, ENG, withLine],
      ),
    );
    const bare = await run({ bot, startedAt: ago(101, -60_000), endedAt: ago(101, 300_000), lines: [['drive', 'y', 'person']] });
    const { counts } = await sweep();
    expect(counts).toMatchObject({ runs: 2, runMemos: 1 });
    const memos = await sys(async (tx) => (await tx.query<{ run_id: string }>('SELECT run_id FROM app.memory_run_memo')).rows.map((r) => r.run_id));
    expect(memos).toEqual([withLine]);
    expect(memos).not.toContain(bare);
  });

  it('memos of bots that no longer exist are removed (their verdict is bot_removed now); the others stay', async () => {
    const gone = await makeBot('goner');
    const stays = await makeBot('stayer');
    for (const bot of [gone, stays]) {
      await run({ bot, startedAt: ago(100, -60_000), endedAt: ago(100, 300_000), lines: [['drive', 'x', 'person']] });
      await message(bot.actor, ago(100, 120_000));
    }
    expect((await sweep()).counts.runMemos).toBe(2);
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [gone.bot]));
    const dry = await sweep({ dryRun: true });
    expect(dry.counts.memosRemoved).toBe(1);
    const real = await sweep();
    expect(real.counts.memosRemoved).toBe(1);
    const left = await sys(async (tx) => (await tx.query<{ bot_id: string }>('SELECT bot_id FROM app.memory_run_memo')).rows.map((r) => r.bot_id));
    expect(left).toEqual([stays.bot]);
    expect(await verdict(stays.actor, ago(100, 120_000))).toMatchObject({ retain_refusal: 'person_source' });
  });
});

describe('the memoize plan', () => {
  it('reads a bot’s messages through the author index and its commits through the team and time index: no new index is needed', async () => {
    const plan = await sys(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const messages = await tx.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM app.messages m JOIN app.channels ch ON ch.id = m.channel_id
          WHERE m.author_id = gen_random_uuid() AND m.deleted_at IS NULL AND ch.kind = 'channel' AND NOT ch.private AND ch.team_id IS NOT NULL
            AND m.created_at BETWEEN now() - interval '1 day' AND now()`,
      );
      const commits = await tx.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM app.repo_commits rc WHERE rc.team_id = gen_random_uuid() AND rc.author_id = gen_random_uuid()
            AND rc.committed_at BETWEEN now() - interval '1 day' AND now()`,
      );
      return [...messages.rows, ...commits.rows].map((r) => r['QUERY PLAN']).join('\n');
    });
    // an index either way: the author index, or the channel index when the planner starts from the channels (a toy database has few of both)
    expect(plan).toMatch(/messages_author|messages_channel_id_desc/);
    expect(plan).toMatch(/repo_commits_/);
    expect(plan).not.toMatch(/Seq Scan on (messages|repo_commits)/);
  });
});

describe('the retain log', () => {
  const old = (n: number): string => ago(400 + n);
  const seed = async (tag: string): Promise<void> => {
    // one message edited twice: retained, forgotten (replaced), retained, forgotten (replaced), retained (the newest state)
    await logLine({ id: `edited-${tag}`, outcome: 'retained', at: old(5), doc: 'feed:message:edited:v1' });
    await logLine({ id: `edited-${tag}`, outcome: 'forgotten', at: old(4), reason: 'replaced', doc: 'feed:message:edited:v1' });
    await logLine({ id: `edited-${tag}`, outcome: 'retained', at: old(3), doc: 'feed:message:edited:v2' });
    await logLine({ id: `edited-${tag}`, outcome: 'forgotten', at: old(2), reason: 'replaced', doc: 'feed:message:edited:v2' });
    await logLine({ id: `edited-${tag}`, outcome: 'retained', at: old(1), doc: 'feed:message:edited:v3' });
    // a source whose newest state is a forget keeps that line (it says nothing is held)
    await logLine({ id: `deleted-${tag}`, outcome: 'retained', at: old(3) });
    await logLine({ id: `deleted-${tag}`, outcome: 'forgotten', at: old(2), reason: 'deleted' });
    // attempt notes
    await logLine({ id: `noted-${tag}`, outcome: 'not_configured', at: old(1), doc: null });
    await logLine({ id: `noted-${tag}`, outcome: 'failed', at: old(1), reason: 'the engine did not take it', doc: null });
    // what was withheld is the audit record of SPEC §15: never pruned, however old
    await logLine({ id: `withheld-${tag}`, kind: 'run', outcome: 'withheld', at: old(10), reason: 'person_source', doc: null });
    // a source with an old superseded line and younger ones: only the old superseded line goes
    await logLine({ id: `young-${tag}`, outcome: 'retained', at: old(1) });
    await logLine({ id: `young-${tag}`, outcome: 'forgotten', at: ago(5), reason: 'replaced' });
    await logLine({ id: `young-${tag}`, outcome: 'retained', at: ago(4) });
  };
  it('loses attempt notes and superseded lines past its window, and never a withheld line or the newest state of a source', async () => {
    await seed('one');
    const dry = await sweep({ dryRun: true });
    expect(dry.counts.memoryLogLines).toBe(8);
    expect(await logOf(`edited-one`)).toHaveLength(5);

    const real = await sweep();
    expect(real.counts.memoryLogLines).toBe(8);
    expect(await logOf(`edited-one`)).toEqual([['retained', '']]);
    expect(await logOf(`deleted-one`)).toEqual([['forgotten', 'deleted']]);
    expect(await logOf(`noted-one`)).toEqual([]);
    expect(await logOf(`withheld-one`)).toEqual([['withheld', 'person_source']]);
    expect(await logOf(`young-one`)).toEqual([['forgotten', 'replaced'], ['retained', '']]);

    // and a second sweep has nothing left to do
    expect((await sweep()).counts.memoryLogLines).toBe(0);
  });

  it('pages through a long log with a cursor and finds the same lines', async () => {
    process.env['MANYTHREADS_RETENTION_BATCH'] = '1'; // four log lines a page
    await seed('two');
    const real = await sweep();
    expect(real.counts.memoryLogLines).toBe(8);
    expect(real.steps).toBeGreaterThanOrEqual(4);
    expect(await logOf(`edited-two`)).toEqual([['retained', '']]);
  });

  it('is reached only through the door: the system role still cannot delete a line', async () => {
    await seed('three');
    await expect(sys((tx) => tx.query("DELETE FROM app.memory_retain_log WHERE source_id = 'edited-three'"))).rejects.toMatchObject({ code: '42501' });
    await expect(sys((tx) => tx.query("UPDATE app.memory_retain_log SET reason = 'x' WHERE source_id = 'edited-three'"))).rejects.toMatchObject({ code: '42501' });
    await sweep(); // leave nothing prunable behind for the next test
  });

  it('a different window moves the cutoff, and a line younger than it is never touched', async () => {
    await logLine({ id: 'mid', outcome: 'retained', at: ago(200) });
    await logLine({ id: 'mid', outcome: 'forgotten', at: ago(199), reason: 'replaced' });
    await logLine({ id: 'mid', outcome: 'retained', at: ago(198) });
    expect((await sweep()).counts.memoryLogLines).toBe(0); // default 365 days
    await sys((tx) => tx.query('INSERT INTO app.retention_settings (workspace_id, memory_log_days) VALUES ($1, 180)', [omar.workspaceId]));
    // both older lines are superseded by the newest state (which is older than 180 days too, and stays)
    expect((await sweep()).counts.memoryLogLines).toBe(2);
    expect(await logOf('mid')).toEqual([['retained', '']]);
  });
});

describe('the empty sweep', () => {
  it('has nothing to do and says so', async () => {
    expect((await sweep()).counts).toEqual(emptyCounts());
  });
});
