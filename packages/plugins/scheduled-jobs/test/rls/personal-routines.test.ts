import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  gatewayLlmMigrationSource,
  personaActor,
  personas,
  scheduledJobsMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-10 / P20-14: a person's own routines are rows with one owner. The owner reads, changes and deletes them; nobody else reads them (an admin only during a live audited
// open, and then never writes); the bot, the owner and the stop reason are the platform's; twenty at most; a removed bot switches them off instead of deleting them.

const { omar, nadia, rafi, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botId: string;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
let counter = 0;

const insertSql = `INSERT INTO app.scheduled_jobs (workspace_id, owner_person_id, bot_id, name, kind, schedule, contract_path, output_path, enabled, next_run_at, created_by,
                                                  slug, schedule_words, time_zone, output_mode, words, sources)
                   VALUES ($1, $2, $3, 'Morning brief', 'routine', '0 5 * * 1-5', $4, $5, true, now() + interval '1 hour', $6, $7, 'Weekdays at 9:00 AM', 'Asia/Dubai', 'replace', 'Brief me', '{mail}')
                   RETURNING id`;
/** A routine as its owner makes one. */
async function create(p: Persona, slug: string): Promise<string> {
  return as(p, async (tx) => (await tx.query<{ id: string }>(insertSql, [omar.workspaceId, p.personId, botId, `Routines/${slug}/routine.yaml`, `Routines/${slug}/output.md`, p.actorId, slug])).rows[0]!.id);
}
const slugOf = (): string => `brief-${(counter += 1)}`;
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.scheduled_jobs ORDER BY id')).rows.map((r) => r.id));

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, gatewayLlmMigrationSource, scheduledJobsMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  botId = await sys(async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, may_tag, model_aliases)
         VALUES ($1, $2, 'brief-bot', 'Brief bot', 'a probe', 'agent', 'hermes', 'team', $3, 'active', '{}', '{}') RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, 'a'.repeat(64)],
      )
    ).rows[0]!.id,
  );
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the tables', () => {
  it('pass the RLS audit and call no function per row', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['scheduled_jobs', 'scheduled_job_runs', 'routine_person_settings', 'routine_workspace_settings']) {
        expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
      }
    } finally {
      await client.end();
    }
  });
});

describe('reading', () => {
  it('shows a routine to its owner alone: not a teammate, not the lead of the bot’s team, not a guest', async () => {
    const mine = await create(nadia, slugOf());
    expect(await visible(nadia)).toContain(mine);
    for (const other of [rafi, omar, lena]) expect(await visible(other), other.key).not.toContain(mine);
  });

  it('shows an admin the routine during a live audited open, and lets the admin change none of it', async () => {
    const target = await create(rafi, slugOf());
    await as(omar, (tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [rafi.personId, 'support request']));
    expect(await visible(omar)).toContain(target);
    const changed = await as(omar, (tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = false WHERE id = $1`, [target]));
    expect(changed.rowCount).toBe(0);
    const removed = await as(omar, (tx) => tx.query(`DELETE FROM app.scheduled_jobs WHERE id = $1`, [target]));
    expect(removed.rowCount).toBe(0);
  });

  it('shows the firings of a routine to its owner only', async () => {
    const job = await create(nadia, slugOf());
    const run = await as(nadia, async (tx) => (await tx.query<{ id: string }>('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])).rows[0]!);
    expect(run.id).toBeTruthy();
    const readRuns = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.scheduled_job_runs WHERE scheduled_job_id = $1', [job])).rowCount ?? 0);
    expect(await readRuns(nadia)).toBe(1);
    expect(await readRuns(rafi)).toBe(0);
    expect(await readRuns(omar)).toBe(0);
  });
});

describe('writing', () => {
  it('lets a person make a routine only for themself, with their own actor', async () => {
    const insert = (p: Persona, over: { owner?: string; creator?: string; slug?: string }): Promise<unknown> =>
      as(p, (tx) => tx.query(insertSql, [omar.workspaceId, over.owner ?? p.personId, botId, 'Routines/x/routine.yaml', 'Routines/x/output.md', over.creator ?? p.actorId, over.slug ?? slugOf()]));
    expect(await code(insert(nadia, { owner: rafi.personId }))).toBe('42501');
    expect(await code(insert(nadia, { creator: rafi.actorId }))).toBe('42501');
    expect(await code(insert(lena, {}))).toBe('42501');
    expect(await code(insert(nadia, {}))).toBeUndefined();
  });

  it('keeps a routine to one owner or one team, and a personal one whole', async () => {
    const bad = (sql: string, params: unknown[]): Promise<string | undefined> => code(sys((tx) => tx.query(sql, params)));
    // both a team and an owner
    expect(
      await bad(
        `INSERT INTO app.scheduled_jobs (workspace_id, team_id, owner_person_id, bot_id, name, kind, schedule, contract_path, output_path, created_by, slug, schedule_words, time_zone, output_mode)
         VALUES ($1, $2, $3, $4, 'x', 'routine', '0 5 * * *', 'a/b', 'c/d', $5, 'x1', 'w', 'UTC', 'replace')`,
        [omar.workspaceId, TEAM_IDS.Engineering, nadia.personId, botId, nadia.actorId],
      ),
    ).toBe('23514');
    // a personal one that is not a routine
    expect(
      await bad(
        `INSERT INTO app.scheduled_jobs (workspace_id, owner_person_id, bot_id, name, kind, schedule, created_by) VALUES ($1, $2, $3, 'x', 'heartbeat', '0 5 * * *', $4)`,
        [omar.workspaceId, nadia.personId, botId, nadia.actorId],
      ),
    ).toBe('23514');
  });

  it('makes the asker the owner and lets nobody write it', async () => {
    const id = await create(nadia, slugOf());
    const row = await sys(async (tx) => (await tx.query<{ owner_person_id: string; asker_person_id: string }>('SELECT owner_person_id, asker_person_id FROM app.scheduled_jobs WHERE id = $1', [id])).rows[0]!);
    expect(row.asker_person_id).toBe(row.owner_person_id);
    expect(await code(sys((tx) => tx.query('UPDATE app.scheduled_jobs SET asker_person_id = $2 WHERE id = $1', [id, rafi.personId])))).toBe('428C9');
  });

  it('lets the owner change what a routine says, turn it off and on, and delete it', async () => {
    const id = await create(nadia, slugOf());
    const updated = await as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET words = 'Brief me at nine', enabled = false, next_run_at = NULL WHERE id = $1`, [id]));
    expect(updated.rowCount).toBe(1);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.scheduled_jobs WHERE id = $1', [id]))).rowCount).toBe(1);
  });

  it('does not let anyone else change or delete it', async () => {
    const id = await create(nadia, slugOf());
    for (const other of [rafi, omar]) {
      expect((await as(other, (tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = false WHERE id = $1`, [id]))).rowCount, other.key).toBe(0);
      expect((await as(other, (tx) => tx.query('DELETE FROM app.scheduled_jobs WHERE id = $1', [id]))).rowCount, other.key).toBe(0);
    }
  });

  it('does not let the owner move a routine to another owner, another bot, or another folder', async () => {
    const id = await create(nadia, slugOf());
    const update = (set: string, v: unknown): Promise<string | undefined> => code(as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET ${set} WHERE id = $1`, [id, v])));
    expect(await update('owner_person_id = $2', rafi.personId)).toBeDefined();
    expect(await update('slug = $2', 'other-folder')).toBe('42501');
    expect(await update('bot_id = $2', null)).toBeDefined();
  });

  it('lets only the platform stop a routine, and lets the owner clear the stop by turning it on', async () => {
    const id = await create(nadia, slugOf());
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = false, stopped_reason = 'spend_cap', stopped_at = now() WHERE id = $1`, [id])))).toBe('42501');
    await sys((tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = false, next_run_at = NULL, stopped_reason = 'spend_cap', stopped_at = now() WHERE id = $1`, [id]));
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET stop_told_at = now() WHERE id = $1`, [id])))).toBe('42501');
    // a stopped routine that is on is refused by the table itself
    expect(await code(sys((tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = true WHERE id = $1`, [id])))).toBe('23514');
    const cleared = await as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = true, stopped_reason = NULL, stopped_at = NULL, next_run_at = now() + interval '1 hour' WHERE id = $1`, [id]));
    expect(cleared.rowCount).toBe(1);
  });

  it('allows one folder name once per person, and twenty routines at most', async () => {
    const slug = slugOf();
    await create(rafi, slug);
    expect(await code(create(rafi, slug))).toBe('23505');
    // rafi has two now; fill to twenty and refuse the 21st
    const have = (await sys(async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.scheduled_jobs WHERE owner_person_id = $1', [rafi.personId])).rows[0]!.n)) as unknown as number;
    for (let i = Number(have); i < 20; i += 1) await create(rafi, slugOf());
    expect(await code(create(rafi, slugOf()))).toBe('23514');
    // another person is not held to rafi's count
    expect(await code(create(nadia, slugOf()))).toBeUndefined();
  });
});

describe('a removed bot', () => {
  it('switches its personal routines off with the reason bot_gone instead of deleting them', async () => {
    const other = await sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, may_tag, model_aliases)
           VALUES ($1, $2, 'short-lived', 'Short lived', 'a probe', 'agent', 'hermes', 'team', $3, 'active', '{}', '{}') RETURNING id`,
          [omar.workspaceId, TEAM_IDS.Engineering, 'b'.repeat(64)],
        )
      ).rows[0]!.id,
    );
    const slug = slugOf();
    const id = await as(nadia, async (tx) => (await tx.query<{ id: string }>(insertSql, [omar.workspaceId, nadia.personId, other, `Routines/${slug}/routine.yaml`, `Routines/${slug}/output.md`, nadia.actorId, slug])).rows[0]!.id);
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [other]));
    const row = await sys(async (tx) => (await tx.query<{ bot_id: string | null; enabled: boolean; stopped_reason: string | null; next_run_at: Date | null }>('SELECT * FROM app.scheduled_jobs WHERE id = $1', [id])).rows[0]);
    expect(row).toMatchObject({ bot_id: null, enabled: false, stopped_reason: 'bot_gone', next_run_at: null });
    // and it cannot be turned on without a bot
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.scheduled_jobs SET enabled = true, stopped_reason = NULL, stopped_at = NULL WHERE id = $1`, [id])))).toBeDefined();
  });
});

describe('the settings', () => {
  it('are a person’s own: nobody else, an admin included, reads their time zone or quiet hours', async () => {
    await as(nadia, (tx) => tx.query(`INSERT INTO app.routine_person_settings (person_id, workspace_id, time_zone, quiet_from, quiet_to) VALUES ($1, $2, 'Asia/Dubai', '22:00', '07:00')`, [nadia.personId, omar.workspaceId]));
    const read = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.routine_person_settings WHERE person_id = $1', [nadia.personId])).rowCount ?? 0);
    expect(await read(nadia)).toBe(1);
    for (const other of [rafi, omar]) expect(await read(other), other.key).toBe(0);
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.routine_person_settings (person_id, workspace_id) VALUES ($1, $2)`, [nadia.personId, omar.workspaceId])))).toBe('42501');
  });

  it('need two different quiet-hour times, given together', async () => {
    const put = (from: string | null, to: string | null): Promise<string | undefined> =>
      code(as(rafi, (tx) => tx.query(`INSERT INTO app.routine_person_settings (person_id, workspace_id, quiet_from, quiet_to) VALUES ($1, $2, $3, $4) ON CONFLICT (person_id) DO UPDATE SET quiet_from = $3, quiet_to = $4`, [rafi.personId, omar.workspaceId, from, to])));
    expect(await put('22:00', '22:00')).toBe('23514');
    expect(await put('22:00', null)).toBe('23514');
    expect(await put('25:00', '07:00')).toBe('23514');
    expect(await put('22:00', '07:00')).toBeUndefined();
  });

  it('keeps the spending allowance readable by the workspace and changeable by an admin only', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.routine_workspace_settings (workspace_id, monthly_cap_usd) VALUES ($1, 50)`, [omar.workspaceId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.routine_workspace_settings (workspace_id, monthly_cap_usd, updated_by) VALUES ($1, 12.5, $2)`, [omar.workspaceId, omar.actorId])))).toBeUndefined();
    expect(await as(nadia, async (tx) => (await tx.query<{ monthly_cap_usd: string }>('SELECT monthly_cap_usd FROM app.routine_workspace_settings')).rows[0]?.monthly_cap_usd)).toBe('12.50');
    expect((await as(nadia, (tx) => tx.query(`UPDATE app.routine_workspace_settings SET monthly_cap_usd = 99`))).rowCount).toBe(0);
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.routine_workspace_settings SET monthly_cap_usd = -1`)))).toBe('23514');
  });
});

describe('what a person spent', () => {
  it('sums the gateway lines of the runs of their routines, and answers only to the person', async () => {
    const job = await create(nadia, slugOf());
    const runId = (await import('node:crypto')).randomUUID();
    await sys(async (tx) => {
      const fired = (await tx.query<{ id: string }>('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])).rows[0]!;
      await tx.query('UPDATE app.scheduled_job_runs SET run_id = $2 WHERE id = $1', [fired.id, runId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, run_id, alias, cost_usd) VALUES ($1, $2, 'fast', 0.4), ($1, $2, 'smart', 0.35)`, [omar.workspaceId, runId]);
    });
    const spent = (p: Persona, whose: Persona): Promise<string> =>
      as(p, async (tx) => (await tx.query<{ s: string }>(`SELECT app.routine_spend_month($1, date_trunc('month', now())) AS s`, [whose.personId])).rows[0]!.s);
    expect(Number(await spent(nadia, nadia))).toBeCloseTo(0.75, 5);
    expect(await code(spent(omar, nadia))).toBe('42501');
  });
});
