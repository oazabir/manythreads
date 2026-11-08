import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  approvalsMigrationSource,
  connectionsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Bundle D, P16-11 (decisions D32 to D34, pnpm test:rls): who may see the people overview, who a leaving person's team and workspace connections move to, that a preview can be
// rolled back, and that after the delete the leaver's own session reads nothing of theirs. The SQL functions are 0006; the rest of the offboarding is the plugin's job.

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const insertConnection = (tx: Tx, f: { team: string | null; slug: string; scope: 'team' | 'person' | 'workspace'; owner: string; kind?: string }): Promise<string> =>
  tx
    .query<{ id: string }>(`INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, $3, $4, $3, $5, $6) RETURNING id`, [omar.workspaceId, f.team, f.slug, f.kind ?? 'email', f.scope, f.owner])
    .then((r) => r.rows[0]!.id);
const oauth = (tx: Tx, connectionId: string, provider: string): Promise<unknown> =>
  tx.query(`INSERT INTO app.connection_oauth (connection_id, workspace_id, provider, scopes, account_label, state) VALUES ($1, $2, $3, ARRAY['calendar'], 'secret@example.test', 'ok')`, [connectionId, omar.workspaceId, provider]);
const start = (personId: string, fallback: string | null) =>
  sys(async (tx) => (await tx.query<{ connection_id: string; scope: string; action: string; new_owner_id: string | null }>('SELECT * FROM app.connections_offboard_start($1, $2)', [personId, fallback])).rows);
const ownerOf = (id: string) => sys(async (tx) => (await tx.query<{ owner_id: string }>('SELECT owner_id FROM app.connections WHERE id = $1', [id])).rows[0]!.owner_id);
const statusOf = (id: string) => sys(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.connections WHERE id = $1', [id])).rows[0]!.status);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource, connectionsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the people overview', () => {
  it('a team lead, a member and a guest get no rows, an admin gets them', async () => {
    const id = await sys(async (tx) => {
      const c = await insertConnection(tx, { team: null, slug: 'priya-ms', scope: 'person', owner: priya.actorId, kind: 'oauth' });
      await oauth(tx, c, 'microsoft');
      return c;
    });
    for (const p of [tariq, nadia, sameera, lena]) expect(await q(p, 'SELECT * FROM app.connections_admin_people()'), p.name).toEqual([]);
    expect((await q<{ connection_id: string }>(omar, 'SELECT connection_id FROM app.connections_admin_people()')).map((r) => r.connection_id)).toEqual([id]);
  });
});

describe('who takes over what', () => {
  it('a team connection goes to the lead of its team, even when another admin is named', async () => {
    const c = await sys((tx) => insertConnection(tx, { team: MKT, slug: 'mkt-a', scope: 'team', owner: priya.actorId }));
    const rows = await start(priya.personId, omar.actorId);
    expect(rows.find((r) => r.connection_id === c)).toMatchObject({ scope: 'team', action: 'moved', new_owner_id: tariq.actorId });
    expect(await ownerOf(c)).toBe(tariq.actorId);
  });

  it('with no other lead it goes to the admin who acted, and a named person who is not an admin is ignored', async () => {
    const c = await sys((tx) => insertConnection(tx, { team: MKT, slug: 'mkt-b', scope: 'team', owner: tariq.actorId }));
    const rows = await start(tariq.personId, rafi.actorId);
    expect(rows.find((r) => r.connection_id === c)).toMatchObject({ action: 'moved', new_owner_id: omar.actorId });
    expect(await ownerOf(c)).toBe(omar.actorId);
  });

  it('the longest-serving lead wins, a lead who left is skipped, and the leaver is never their own successor', async () => {
    // Rafi and Priya become leads of Engineering after Omar; Omar's account is suspended, so the next in line takes it
    await sys(async (tx) => {
      await tx.query(`UPDATE app.team_members SET role = 'lead' WHERE team_id = $1 AND actor_id = ANY($2::uuid[])`, [ENG, [rafi.actorId, priya.actorId]]);
      await tx.query(`UPDATE app.people SET status = 'suspended' WHERE id = $1`, [omar.personId]);
    });
    const c = await sys((tx) => insertConnection(tx, { team: ENG, slug: 'eng-a', scope: 'team', owner: nadia.actorId }));
    const rows = await start(nadia.personId, null);
    const taker = rows.find((r) => r.connection_id === c)!.new_owner_id;
    expect([rafi.actorId, priya.actorId]).toContain(taker);
    expect(taker).not.toBe(omar.actorId);
    expect(taker).not.toBe(nadia.actorId);
    await sys(async (tx) => {
      await tx.query(`UPDATE app.people SET status = 'active' WHERE id = $1`, [omar.personId]);
      await tx.query(`UPDATE app.team_members SET role = 'member' WHERE team_id = $1 AND actor_id = ANY($2::uuid[])`, [ENG, [rafi.actorId, priya.actorId]]);
    });
  });

  it('a workspace connection goes to the longest-serving admin, not to the person leaving', async () => {
    const c = await sys((tx) => insertConnection(tx, { team: null, slug: 'ws-a', scope: 'workspace', owner: nadia.actorId }));
    const rows = await start(nadia.personId, null);
    expect(rows.find((r) => r.connection_id === c)).toMatchObject({ scope: 'workspace', action: 'moved', new_owner_id: omar.actorId });
  });

  it('when nobody can take it, it is switched off and stays where it is', async () => {
    const c = await sys((tx) => insertConnection(tx, { team: null, slug: 'ws-b', scope: 'workspace', owner: omar.actorId }));
    const rows = await start(omar.personId, null);
    expect(rows.find((r) => r.connection_id === c)).toMatchObject({ scope: 'workspace', action: 'disabled', new_owner_id: null });
    expect(await ownerOf(c)).toBe(omar.actorId);
    expect(await statusOf(c)).toBe('disabled');
  });

  it('a person who is not in the workspace changes nothing and answers no rows', async () => {
    expect(await start('00000000-0000-7000-8000-000000000999', omar.actorId)).toEqual([]);
  });
});

describe('the preview', () => {
  it('runs the real step inside a savepoint and leaves everything as it was', async () => {
    const c = await sys(async (tx) => {
      const id = await insertConnection(tx, { team: null, slug: 'rafi-google', scope: 'person', owner: rafi.actorId, kind: 'oauth' });
      await oauth(tx, id, 'google');
      await tx.query(`UPDATE app.connections SET status = 'enabled' WHERE id = $1`, [id]);
      return id;
    });
    const seen = await sys(async (tx) => {
      await tx.query('SAVEPOINT offboard_preview');
      const rows = (await tx.query<{ connection_id: string; action: string }>('SELECT * FROM app.connections_offboard_start($1, $2)', [rafi.personId, omar.actorId])).rows;
      await tx.query('ROLLBACK TO SAVEPOINT offboard_preview');
      await tx.query('RELEASE SAVEPOINT offboard_preview');
      return rows;
    });
    expect(seen.find((r) => r.connection_id === c)).toMatchObject({ action: 'disabled' });
    expect(await statusOf(c)).toBe('enabled');
  });
});

describe('after the delete', () => {
  it('the leaver’s own session reads nothing of theirs, and the overview lists nothing of theirs', async () => {
    const c = await sys(async (tx) => {
      const id = await insertConnection(tx, { team: null, slug: 'sameera-ms', scope: 'person', owner: sameera.actorId, kind: 'oauth' });
      await oauth(tx, id, 'microsoft');
      await tx.query('SELECT app.connection_usage_bump($1, true)', [id]);
      return id;
    });
    expect(await q(sameera, 'SELECT id FROM app.connections WHERE id = $1', [c])).toHaveLength(1);
    await start(sameera.personId, omar.actorId);
    // the job deletes everything in one transaction
    await sys(async (tx) => {
      await tx.query('DELETE FROM app.connections WHERE id = $1', [c]);
    });
    expect(await q(sameera, 'SELECT id FROM app.connections WHERE owner_id = $1', [sameera.actorId])).toEqual([]);
    expect(await q(sameera, 'SELECT connection_id FROM app.connection_oauth')).toEqual([]);
    expect(await code(q(sameera, 'SELECT 1 FROM app.connection_secrets'))).toBe('42501');
    expect(await code(q(sameera, 'SELECT 1 FROM app.connection_usage_daily'))).toBe('42501');
    const left = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT (SELECT count(*) FROM app.connection_usage_daily WHERE connection_id = $1)::int AS n', [c])).rows[0]!.n);
    expect(left).toBe(0);
    expect((await q<{ connection_id: string }>(omar, 'SELECT connection_id FROM app.connections_admin_people()')).map((r) => r.connection_id)).not.toContain(c);
  });
});
