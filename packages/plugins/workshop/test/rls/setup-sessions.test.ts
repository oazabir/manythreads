import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
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
  workshopMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P7-02: a setup conversation holds the brief and the helper's whole conversation. Only the person who started it reads or writes it: not a lead, not an admin; the system (the job) does.

const { omar, nadia, priya } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const start = (p: Persona, brief = 'A bot that answers from the manuals'): Promise<string> =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.setup_sessions (workspace_id, team_id, owner_id, brief) VALUES ($1, $2, (SELECT app.actor()), $3) RETURNING id`,
        [p.workspaceId, ENG, brief],
      )
    ).rows[0]!.id,
  );
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.setup_sessions ORDER BY id')).rows.map((r) => r.id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, workshopMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('setup sessions (P7-02)', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'setup_sessions')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('are read by their owner alone: a team member, the team lead and the workspace admin see nothing of them', async () => {
    const mine = await start(nadia);
    expect(await visible(nadia)).toContain(mine);
    expect(await visible(priya)).not.toContain(mine);
    expect(await visible(omar)).not.toContain(mine); // Engineering's lead and the workspace admin
    expect(await sys(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.setup_sessions WHERE id = $1', [mine])).rows.length)).toBe(1);
  });

  it('cannot be made in someone else\'s name', async () => {
    const attempt = as(nadia, (tx) => tx.query(`INSERT INTO app.setup_sessions (workspace_id, team_id, owner_id, brief) VALUES ($1, $2, $3, 'A bot for someone else')`, [nadia.workspaceId, ENG, priya.actorId]));
    expect(await code(attempt)).toBeDefined();
  });

  it('are changed by their owner, never by another person, and are not deleted by the app', async () => {
    const mine = await start(nadia);
    expect(await as(nadia, async (tx) => (await tx.query("UPDATE app.setup_sessions SET status = 'cancelled' WHERE id = $1", [mine])).rowCount)).toBe(1);
    expect(await as(omar, async (tx) => (await tx.query("UPDATE app.setup_sessions SET status = 'asking' WHERE id = $1", [mine])).rowCount)).toBe(0);
    expect(await as(nadia, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.setup_sessions WHERE id = $1', [mine])).rows[0]?.status)).toBe('cancelled');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.setup_sessions WHERE id = $1', [mine])))).toBeDefined();
  });

  it('refuse a status, a brief and a history the shape does not allow', async () => {
    const mine = await start(nadia);
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.setup_sessions SET status = 'done' WHERE id = $1", [mine])))).toBe('23514');
    expect(await code(start(nadia, 'short'))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.setup_sessions SET history = to_jsonb(repeat('x', 500000)) WHERE id = $1`, [mine])))).toBe('23514');
  });
});
