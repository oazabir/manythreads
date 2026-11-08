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
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Bundle D, connections 0006 (pnpm test:rls): the usage counter is the system's alone, the bump is content-blind and stays in the caller's workspace, the owner of a team or workspace
// connection moves only by the platform and only to someone who can answer for it, the admin people list is for admins, and the offboarding step is refused to the application role.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;

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
const oauth = (tx: Tx, connectionId: string, provider: string, state = 'ok'): Promise<unknown> =>
  tx.query(`INSERT INTO app.connection_oauth (connection_id, workspace_id, provider, scopes, account_label, state) VALUES ($1, $2, $3, ARRAY['calendar'], 'secret@example.test', $4)`, [connectionId, omar.workspaceId, provider, state]);

const conn = { nadiaGoogle: '', rafiMs: '', engMail: '', wsMail: '' };

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource, connectionsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    conn.nadiaGoogle = await insertConnection(tx, { team: null, slug: 'nadia-google', scope: 'person', owner: nadia.actorId, kind: 'oauth' });
    await oauth(tx, conn.nadiaGoogle, 'google');
    conn.rafiMs = await insertConnection(tx, { team: null, slug: 'rafi-ms', scope: 'person', owner: rafi.actorId, kind: 'oauth' });
    await oauth(tx, conn.rafiMs, 'microsoft', 'needs_reconnect');
    conn.engMail = await insertConnection(tx, { team: ENG, slug: 'eng-mail', scope: 'team', owner: nadia.actorId });
    conn.wsMail = await insertConnection(tx, { team: null, slug: 'ws-mail', scope: 'workspace', owner: nadia.actorId });
  });
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('connection_usage_daily', () => {
  it('forced RLS, a system rls: comment and no privilege for the application role', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const [row] = (
        await admin.query<{ force: boolean; comment: string; priv: boolean }>(
          `SELECT c.relforcerowsecurity AS force, obj_description(c.oid) AS comment, has_table_privilege('manythreads_app', c.oid, 'SELECT') AS priv
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'connection_usage_daily'`,
        )
      ).rows;
      expect(row).toMatchObject({ force: true, priv: false });
      expect(row!.comment).toMatch(/^rls: system/);
    } finally {
      await admin.end();
    }
  });

  it('no person can read or write it, an admin included', async () => {
    for (const p of [omar, nadia, sameera, lena]) {
      expect(await code(q(p, 'SELECT * FROM app.connection_usage_daily')), p.name).toBe('42501');
      expect(await code(q(p, "INSERT INTO app.connection_usage_daily (workspace_id, connection_id, provider, day) VALUES ($1, $2, 'google', current_date)", [omar.workspaceId, conn.nadiaGoogle])), p.name).toBe('42501');
    }
  });

  it('the bump counts a call and a failure, once per day row, with nothing else kept', async () => {
    await q(nadia, 'SELECT app.connection_usage_bump($1, true)', [conn.nadiaGoogle]);
    await q(nadia, 'SELECT app.connection_usage_bump($1, true)', [conn.nadiaGoogle]);
    await q(nadia, 'SELECT app.connection_usage_bump($1, false)', [conn.nadiaGoogle]);
    const rows = await sys(async (tx) => (await tx.query<{ provider: string; calls: number; failures: number }>('SELECT provider, calls, failures FROM app.connection_usage_daily WHERE connection_id = $1', [conn.nadiaGoogle])).rows);
    expect(rows).toEqual([{ provider: 'google', calls: 3, failures: 1 }]);
  });

  it('the provider of a non-oauth connection is its kind; an unknown connection changes nothing', async () => {
    await q(nadia, 'SELECT app.connection_usage_bump($1, true)', [conn.engMail]);
    await q(nadia, 'SELECT app.connection_usage_bump($1, true)', ['00000000-0000-7000-8000-000000000000']);
    const rows = await sys(async (tx) => (await tx.query<{ provider: string }>('SELECT provider FROM app.connection_usage_daily WHERE connection_id = $1', [conn.engMail])).rows);
    expect(rows).toEqual([{ provider: 'email' }]);
    const n = await sys(async (tx) => (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.connection_usage_daily')).rows[0]!.n);
    expect(n).toBe('2');
  });
});

describe('the owner of a team or workspace connection', () => {
  it('no person, an admin included, moves an owner', async () => {
    expect(await code(q(omar, 'UPDATE app.connections SET owner_id = $2 WHERE id = $1', [conn.engMail, omar.actorId]))).toBeDefined();
    await code(q(nadia, 'UPDATE app.connections SET owner_id = $2 WHERE id = $1', [conn.engMail, omar.actorId]));
    expect((await q<{ owner_id: string }>(nadia, 'SELECT owner_id FROM app.connections WHERE id = $1', [conn.engMail]))[0]!.owner_id).toBe(nadia.actorId);
  });

  it('the platform moves a team connection to a lead of the team or an admin, and to nobody else', async () => {
    await sys(async (tx) => {
      const mine = await insertConnection(tx, { team: ENG, slug: 'eng-moving', scope: 'team', owner: nadia.actorId });
      await tx.query('SAVEPOINT a');
      await expect(tx.query('UPDATE app.connections SET owner_id = $2 WHERE id = $1', [mine, sameera.actorId])).rejects.toMatchObject({ code: '42501' });
      await tx.query('ROLLBACK TO a');
      await tx.query('SAVEPOINT b');
      await expect(tx.query('UPDATE app.connections SET owner_id = $2 WHERE id = $1', [mine, rafi.actorId])).rejects.toMatchObject({ code: '42501' });
      await tx.query('ROLLBACK TO b');
      await tx.query('UPDATE app.connections SET owner_id = $2 WHERE id = $1', [mine, omar.actorId]);
      expect((await tx.query<{ owner_id: string }>('SELECT owner_id FROM app.connections WHERE id = $1', [mine])).rows[0]!.owner_id).toBe(omar.actorId);
    });
  });

  it('a person connection stays with its person even for the platform', async () => {
    await sys(async (tx) => {
      await expect(tx.query('UPDATE app.connections SET owner_id = $2 WHERE id = $1', [conn.nadiaGoogle, omar.actorId])).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('the admin people list', () => {
  it('an admin sees one row per person sign-in, never an address; anyone else sees nothing', async () => {
    const rows = await q<Record<string, unknown>>(omar, 'SELECT * FROM app.connections_admin_people()');
    expect(rows.map((r) => `${String(r.provider)}:${String(r.state)}`).sort()).toEqual(['google:ok', 'microsoft:needs_reconnect']);
    expect(JSON.stringify(rows)).not.toContain('secret@example.test');
    expect(rows.find((r) => r.provider === 'google')).toMatchObject({ display_name: nadia.name });
    for (const p of [nadia, tariq, sameera, lena]) expect(await q(p, 'SELECT * FROM app.connections_admin_people()'), p.name).toEqual([]);
  });

  it('last used shows the newest day with a counted call', async () => {
    const rows = await q<{ provider: string; last_used_on: Date | null }>(omar, 'SELECT provider, last_used_on FROM app.connections_admin_people()');
    expect(rows.find((r) => r.provider === 'google')!.last_used_on).not.toBeNull();
    expect(rows.find((r) => r.provider === 'microsoft')!.last_used_on).toBeNull();
  });
});

describe('resolving a typed name', () => {
  it('finds people who share a team, not the caller, never a guest; a guest caller gets nothing', async () => {
    const rows = await q<{ person_id: string }>(nadia, 'SELECT * FROM app.connections_resolve_people($1)', [[rafi.name]]);
    expect(rows.map((r) => r.person_id)).toContain(rafi.personId);
    const self = await q<{ person_id: string }>(nadia, 'SELECT * FROM app.connections_resolve_people($1)', [[nadia.name]]);
    expect(self.map((r) => r.person_id)).not.toContain(nadia.personId);
    const guest = await q(lena, 'SELECT * FROM app.connections_resolve_people($1)', [['nadia']]);
    expect(guest).toEqual([]);
    const asked = await q<{ person_id: string }>(nadia, 'SELECT * FROM app.connections_resolve_people($1)', [['lena']]);
    expect(asked.map((r) => r.person_id)).not.toContain(lena.personId);
  });
});

describe('the offboarding step', () => {
  it('is refused to every person and to the application role, an admin included', async () => {
    for (const p of [omar, nadia, sameera, lena]) expect(await code(q(p, 'SELECT * FROM app.connections_offboard_start($1)', [rafi.personId])), p.name).toBe('42501');
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const [row] = (await admin.query<{ app: boolean; sys: boolean }>("SELECT has_function_privilege('manythreads_app', 'app.connections_offboard_start(uuid, uuid)', 'EXECUTE') AS app, has_function_privilege('manythreads_system', 'app.connections_offboard_start(uuid, uuid)', 'EXECUTE') AS sys")).rows;
      expect(row).toEqual({ app: false, sys: true });
    } finally {
      await admin.end();
    }
  });

  it('the platform switches the leaving person\'s own connections off and moves their team and workspace ones to a lead or an admin', async () => {
    const rafiBefore = await sys(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.connections WHERE id = $1', [conn.rafiMs])).rows[0]?.status);
    const rows = await sys(async (tx) =>
      (await tx.query<{ connection_id: string; scope: string; action: string; new_owner_id: string | null }>('SELECT * FROM app.connections_offboard_start($1, NULL)', [nadia.personId])).rows,
    );
    const byId = new Map(rows.map((r) => [r.connection_id, r]));
    expect(byId.get(conn.nadiaGoogle)).toMatchObject({ scope: 'person', action: 'disabled', new_owner_id: null });
    expect(byId.get(conn.engMail)).toMatchObject({ scope: 'team', action: 'moved' });
    expect(byId.get(conn.wsMail)).toMatchObject({ scope: 'workspace', action: 'moved', new_owner_id: omar.actorId });
    const after = await sys(async (tx) => (await tx.query<{ id: string; status: string; owner_id: string }>('SELECT id, status, owner_id FROM app.connections WHERE id = ANY($1)', [[conn.nadiaGoogle, conn.engMail, conn.wsMail]])).rows);
    expect(after.find((r) => r.id === conn.nadiaGoogle)).toMatchObject({ status: 'disabled', owner_id: nadia.actorId });
    for (const id of [conn.engMail, conn.wsMail]) expect(after.find((r) => r.id === id)!.owner_id).not.toBe(nadia.actorId);
    // the rafi sign-in is untouched
    expect(after.find((r) => r.id === conn.rafiMs)).toBeUndefined();
    expect(rafiBefore).toBeDefined();
    const rafiRow = await sys(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.connections WHERE id = $1', [conn.rafiMs])).rows[0]);
    expect(rafiRow!.status).toBe(rafiBefore);
  });
});
