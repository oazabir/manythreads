import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import { Bot, BotRun, RunId, RunSourceLogEntry } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBot, toBotRun, toRunSourceLogEntry, type BotRow, type BotRunRow, type RunSourceLogRow } from '../../src/rows.ts';

// P5-03: who may read a bot, a run and the run's sources, and who may write them. The rows exist through the
// system role (the loader writes that way); every assertion runs as a persona through the app pool, which is
// what a request is.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (e: { code?: string }) => e.code);
const slugs = async (p: Persona): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.bots ORDER BY slug')).rows.map((r) => r.slug));
const sha = (n: number): string => n.toString(16).padStart(64, '0');
/** The run whose sources the read tests look at, created in beforeAll. */
let engRunId = '';

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  await sys(async (tx) => {
    const insert = (team: string, slug: string, visibility: string) =>
      tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, $3, 'agent', 'hermes', $4, $5, 'active', '{"runner": "default"}')`,
        [omar.workspaceId, team, slug, visibility, sha(slug.length)],
      );
    await insert(ENG, 'release-bot', 'team');
    await insert(MKT, 'campaign-bot', 'workspace');
    const eng = await tx.query<{ id: string }>("SELECT id FROM app.bots WHERE slug = 'release-bot'");
    const mkt = await tx.query<{ id: string }>("SELECT id FROM app.bots WHERE slug = 'campaign-bot'");
    // a pairing token: a credential the request role never sees
    await tx.query('INSERT INTO app.bot_pairing_tokens (bot_id, token_hash) VALUES ($1, $2)', [eng.rows[0]!.id, Buffer.alloc(32, 7)]);
    // one run Nadia asked for in Engineering, one Sameera asked for in Marketing (she is not on that team)
    const run = await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status)
       VALUES ($1, $2, $3, 'mention', $4, 'running') RETURNING id`,
      [omar.workspaceId, eng.rows[0]!.id, ENG, nadia.actorId],
    );
    engRunId = run.rows[0]!.id;
    await tx.query(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, started_at, ended_at)
       VALUES ($1, $2, $3, 'conversation', $4, 'done', now() - interval '1 minute', now())`,
      [omar.workspaceId, mkt.rows[0]!.id, MKT, sameera.actorId],
    );
    await tx.query(
      `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
       VALUES ($1, 0, 'message', 'm-1', 'channel'), ($1, 1, 'page', 'pages/report.md', 'team')`,
      [engRunId],
    );
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('bots, bot_pairing_tokens, bot_runs and run_source_log (P5-03)', () => {
  it('passes the RLS harness: forced, with a policy and an rls comment on all four tables', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('reads without a per-row policy helper (the team visibility set is hoisted)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      for (const table of ['bots', 'bot_runs', 'run_source_log']) {
        expect(await findPerRowPolicyCalls(admin, table), `per-row calls in ${table}`).toEqual([]);
      }
    } finally {
      await admin.end();
    }
  });

  it('a team bot is readable by its team and by a workspace owner, by nobody else', async () => {
    expect(await slugs(nadia)).toEqual(['campaign-bot', 'release-bot']); // Engineering + the workspace-visible one
    expect(await slugs(rafi)).toEqual(['campaign-bot', 'release-bot']);
    expect(await slugs(tariq)).toEqual(['campaign-bot']); // Marketing lead: no Engineering bot
    expect(await slugs(sameera)).toEqual(['campaign-bot']); // on neither team
    expect(await slugs(omar)).toEqual(['campaign-bot', 'release-bot']); // workspace owner
    expect(await slugs(lena)).toEqual([]); // a guest sees neither
  });

  it('the bot row maps into the shared entity, placement included', async () => {
    const row = await as(nadia, async (tx) =>
      (
        await tx.query<BotRow>(
          'SELECT id, workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement, created_at, updated_at FROM app.bots WHERE slug = $1',
          ['release-bot'],
        )
      ).rows[0],
    );
    expect(row).toBeDefined();
    const bot = toBot(row!);
    expect(Bot.parse(bot)).toEqual(bot);
    expect(bot).toMatchObject({
      slug: 'release-bot',
      kind: 'agent',
      runtime: 'hermes',
      visibility: 'team',
      status: 'active',
      placement: { runner: 'default' },
    });
  });

  it('nobody but the system role writes a bot (the loader owns the table)', async () => {
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
             VALUES ($1, $2, 'mine', 'agent', 'rules', 'team', $3, 'active')`,
            [nadia.workspaceId, ENG, sha(1)],
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.bots SET status = 'disabled'")))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query("DELETE FROM app.bots WHERE slug = 'release-bot'")))).toBe('42501');
    expect(await slugs(nadia)).toEqual(['campaign-bot', 'release-bot']); // nothing changed
  });

  it('the pairing token is a credential the request role cannot touch', async () => {
    expect(await code(as(nadia, (tx) => tx.query('SELECT id FROM app.bot_pairing_tokens')))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.bot_pairing_tokens SET revoked_at = now()')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.bot_pairing_tokens')))).toBe('42501');
    const live = await sys(async (tx) =>
      (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE revoked_at IS NULL')).rows[0],
    );
    expect(live?.n).toBe(1);
  });

  it('a run is readable by its team and by its asker, and by nobody outside both', async () => {
    const runs = async (p: Persona): Promise<string[]> =>
      as(p, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.bot_runs ORDER BY status')).rows.map((r) => r.status));
    expect(await runs(nadia)).toEqual(['running']); // Engineering: her own run is that team's run
    expect(await runs(rafi)).toEqual(['running']); // Engineering only: the Marketing run is not his
    expect(await runs(sameera)).toEqual(['done']); // her own run in a team she is not on
    expect(await runs(tariq)).toEqual(['done']); // Marketing: the team's run
    expect(await runs(lena)).toEqual([]);
  });

  it('a member starts a run in a team they can read; outside it, or for someone else, refused', async () => {
    const bot = await sys(async (tx) =>
      (await tx.query<{ id: string; team_id: string }>("SELECT id, team_id FROM app.bots WHERE slug = 'release-bot'")).rows[0],
    );
    expect(
      await as(nadia, async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status)
             VALUES ($1, $2, $3, 'conversation', $4, 'running') RETURNING id`,
            [nadia.workspaceId, bot!.id, ENG, nadia.actorId],
          )
        ).rows[0]?.id,
      ),
    ).toEqual(expect.any(String));
    expect(
      await code(
        as(sameera, (tx) =>
          tx.query(
            `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status)
             VALUES ($1, $2, $3, 'conversation', $4, 'running')`,
            [sameera.workspaceId, bot!.id, ENG, sameera.actorId],
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status)
             VALUES ($1, $2, $3, 'conversation', $4, 'running')`,
            [nadia.workspaceId, bot!.id, ENG, rafi.actorId],
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.bot_runs SET status = 'failed'")))).toBe('42501');
  });

  it('run sources read with the run: the team sees them, others do not', async () => {
    const refs = async (p: Persona): Promise<string[]> =>
      as(p, async (tx) =>
        (await tx.query<{ source_ref: string }>('SELECT source_ref FROM app.run_source_log ORDER BY seq')).rows.map((r) => r.source_ref),
      );
    expect(await refs(nadia)).toEqual(['m-1', 'pages/report.md']);
    expect(await refs(rafi)).toEqual(['m-1', 'pages/report.md']);
    expect(await refs(sameera)).toEqual([]);
    expect(await refs(lena)).toEqual([]);
  });

  it('only the run itself appends to its log, through app.run_id', async () => {
    const actor = { ...personaActor(nadia), runId: engRunId as RunId };
    // the run writes its own line ...
    expect(
      await withActor(
        actor,
        async (tx) =>
          (
            await tx.query<{ seq: number }>(
              `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
               VALUES ($1, 2, 'memory', 'bank:team:engineering', 'team') RETURNING seq`,
              [engRunId],
            )
          ).rows[0]?.seq,
        { pool: appPool },
      ),
    ).toBe(2);
    // ... and without its run id on the transaction, nobody of the app role does
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
             VALUES ($1, 3, 'message', 'm-2', 'channel')`,
            [engRunId],
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.run_source_log SET source_ref = 'x'")))).toBe('42501');
  });

  it('a row of each table maps into its shared entity', async () => {
    const run = await sys(async (tx) =>
      (
        await tx.query<BotRunRow>(
          'SELECT id, workspace_id, bot_id, team_id, trigger_type, asker_id, thread_id, status, started_at, ended_at FROM app.bot_runs ORDER BY started_at DESC LIMIT 1',
        )
      ).rows[0],
    );
    const mapped = toBotRun(run!);
    expect(BotRun.parse(mapped)).toEqual(mapped);
    const line = await sys(async (tx) =>
      (
        await tx.query<RunSourceLogRow>(
          'SELECT run_id, seq, source_type, source_ref, scope, created_at FROM app.run_source_log ORDER BY seq LIMIT 1',
        )
      ).rows[0],
    );
    const entry = toRunSourceLogEntry(line!);
    expect(RunSourceLogEntry.parse(entry)).toEqual(entry);
    expect(entry).toMatchObject({ sourceType: 'message', sourceRef: 'm-1', scope: 'channel', seq: 0 });
  });
});
