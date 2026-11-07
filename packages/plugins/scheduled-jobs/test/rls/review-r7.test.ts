import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  gatewayLlmMigrationSource,
  personaActor,
  personas,
  scheduledJobsMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-R7: review findings on the routines tables and their firing door.

const { omar, nadia, rafi } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botId: string;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const insertSql = `INSERT INTO app.scheduled_jobs (workspace_id, owner_person_id, bot_id, name, kind, schedule, contract_path, output_path, enabled, next_run_at, created_by,
                                                  slug, schedule_words, time_zone, output_mode, words, sources)
                   VALUES ($1, $2, $3, 'Morning brief', 'routine', '0 5 * * 1-5', $4, $5, true, now() + interval '1 hour', $6, $7, 'Weekdays at 9:00 AM', 'Asia/Dubai', 'replace', 'Brief me', '{mail}')
                   RETURNING id`;

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

describe('the firing door', () => {
  it('refuses a person who is not the owner of the routine (the owner check must not be skipped inside the definer function)', async () => {
    const job = await as(nadia, async (tx) => (await tx.query<{ id: string }>(insertSql, [omar.workspaceId, nadia.personId, botId, 'Routines/fire/routine.yaml', 'Routines/fire/output.md', nadia.actorId, 'fire'])).rows[0]!.id);
    // another member, and an admin, cannot file a firing for somebody else's routine
    expect(await code(as(rafi, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBe('42501');
    // the owner can
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBeUndefined();
    // and the refused calls left no firing behind: only the owner's one is there
    const runs = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.scheduled_job_runs WHERE scheduled_job_id = $1', [job])).rowCount);
    expect(runs).toBe(1);
  });

  it('lets the system (the tick job logs in as the system role) fire a routine of anybody, which is how the schedule runs', async () => {
    const job = await as(nadia, async (tx) => (await tx.query<{ id: string }>(insertSql, [omar.workspaceId, nadia.personId, botId, 'Routines/sys/routine.yaml', 'Routines/sys/output.md', nadia.actorId, 'sys-fire'])).rows[0]!.id);
    const fired = await sys((tx) => tx.query<{ owner_person_id: string; status: string }>('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job]));
    expect(fired.rows).toHaveLength(1);
    expect(fired.rows[0]).toMatchObject({ owner_person_id: nadia.personId, status: 'queued' });
  });

  it('keeps the team check for a team job: a lead of the team fires it, a plain member does not', async () => {
    // a team heartbeat has no owner; who may fire it is decided by the "manage" right on the team (Omar leads Engineering, Nadia and Rafi are members)
    const job = await sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.scheduled_jobs (workspace_id, team_id, bot_id, name, kind, schedule, enabled, next_run_at, created_by)
           VALUES ($1, $2, $3, 'Team pulse', 'heartbeat', '0 5 * * 1-5', true, now() + interval '1 hour', $4) RETURNING id`,
          [omar.workspaceId, TEAM_IDS.Engineering, botId, omar.actorId],
        )
      ).rows[0]!.id,
    );
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)', [job])))).toBeUndefined();
  });

  it('says there is no such job for an id that is not one, before any check of the caller', async () => {
    expect(await code(as(nadia, (tx) => tx.query("SELECT * FROM app.scheduled_jobs_fire('00000000-0000-4000-8000-000000000000', now(), NULL, NULL)")))).toBe('P0002');
  });
});
