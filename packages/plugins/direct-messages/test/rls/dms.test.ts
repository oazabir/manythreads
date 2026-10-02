import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  directMessagesMigrationSource,
  dropTestDatabase,
  explainRlsViolations,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const open = async (p: Persona, ...others: Array<Persona | string>): Promise<{ channel_id: string; created: boolean }> =>
  as(p, async (tx) => (await tx.query<{ channel_id: string; created: boolean }>(
    'SELECT channel_id, created FROM app.dms_get_or_create($1::uuid[])', [others.map((o) => (typeof o === 'string' ? o : o.personId))])).rows[0]!);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, directMessagesMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('app.dms_get_or_create', () => {
  it('passes the RLS harness (the plugin adds no table; the DM rows are the channels plugin\'s)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('makes the channel and its members together, once; the key is the sorted person ids', async () => {
    const first = await open(nadia, rafi);
    expect(first.created).toBe(true);
    expect(await open(rafi, nadia)).toEqual({ channel_id: first.channel_id, created: false });
    const row = (await sys(async (tx) => (await tx.query<{ kind: string; private: boolean; team_id: string | null; name: string; dm_key: string; created_by: string; n: number }>(
      `SELECT c.kind, c.private, c.team_id, c.name, c.dm_key, c.created_by, (SELECT count(*)::int FROM app.channel_members m WHERE m.channel_id = c.id) AS n
         FROM app.channels c WHERE c.id = $1`, [first.channel_id])).rows))[0];
    expect(row).toEqual({ kind: 'dm', private: true, team_id: null, name: '', dm_key: [nadia.personId, rafi.personId].sort().join(','), created_by: nadia.actorId, n: 2 });
  });

  it('a caller cannot make a DM (or anything but a team channel) by writing the table, nor add themself to one', async () => {
    const key = [nadia.personId, sameera.personId].sort().join(',');
    expect(await code(as(nadia, (tx) => tx.query(
      `INSERT INTO app.channels (workspace_id, name, kind, private, dm_key) VALUES ($1, '', 'dm', true, $2)`, [nadia.workspaceId, key])))).toBe('42501');
    const dm = (await open(nadia, rafi)).channel_id;
    expect(await code(as(omar, (tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [dm, omar.personId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.channels_add_member($1, $2)', [dm, omar.personId])))).toBe('42501');
  });

  it('refuses a guest, and a guest or an unknown person as the other side, an empty or oversized list, a suspended person', async () => {
    expect(await code(open(lena, nadia))).toBe('42501');
    expect(await code(open(nadia, lena))).toBe('22023');
    expect(await code(open(nadia, randomUUID()))).toBe('22023');
    expect(await code(open(nadia))).toBe('22023');
    expect(await code(open(nadia, ...Array.from({ length: 9 }, () => randomUUID())))).toBe('22023');
    await sys((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [priya.personId]));
    expect(await code(open(nadia, priya))).toBe('22023');
    expect(await code(open(priya, nadia))).toBe('42501');
    await sys((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [priya.personId]));
    expect(await sys(async (tx) => (await tx.query("SELECT 1 FROM app.channels WHERE kind = 'dm' AND dm_key LIKE '%' || $1 || '%'", [lena.personId])).rows.length)).toBe(0);
  });

  it('refuses a bot, a person of another workspace, and a caller with no actor', async () => {
    const botActor = await sys(async (tx) => (await tx.query<{ id: string }>(
      "INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, randomUUID()])).rows[0]!.id);
    const bot: Actor = { kind: 'bot', id: botActor as Actor['id'], workspaceId: omar.workspaceId };
    expect(await code(withActor(bot, (tx) => tx.query('SELECT * FROM app.dms_get_or_create($1::uuid[])', [[nadia.personId]]), { pool: appPool }))).toBe('42501');
    const other = await sys(async (tx) => {
      const ws = (await tx.query<{ id: string }>("INSERT INTO app.workspaces (slug, name) VALUES ('other', 'Other') RETURNING id")).rows[0]!.id;
      const person = (await tx.query<{ id: string }>(
        "INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Mallory', 'mallory@other.example') RETURNING id", [ws])).rows[0]!.id;
      await tx.query("INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'member')", [ws, person]);
      return person;
    });
    expect(await code(open(nadia, other))).toBe('22023');
    expect(await code(withActor({ kind: 'person', id: randomUUID() as Actor['id'], workspaceId: omar.workspaceId }, (tx) => tx.query('SELECT * FROM app.dms_get_or_create($1::uuid[])', [[nadia.personId]]), { pool: appPool }))).toBe('42501');
  });

  it('a workspace admin who is not a participant sees neither the channel nor its members, and cannot read its messages', async () => {
    const dm = (await open(nadia, rafi)).channel_id;
    await sys((tx) => tx.query(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'secret chat', 'secret chat')`, [omar.workspaceId, dm, nadia.actorId]));
    expect(await as(omar, async (tx) => (await tx.query('SELECT id FROM app.channels WHERE id = $1', [dm])).rows)).toEqual([]);
    expect(await as(omar, async (tx) => (await tx.query('SELECT person_id FROM app.channel_members WHERE channel_id = $1', [dm])).rows)).toEqual([]);
    expect(await as(omar, async (tx) => (await tx.query('SELECT id FROM app.messages WHERE channel_id = $1', [dm])).rows)).toEqual([]);
    expect((await as(rafi, async (tx) => (await tx.query('SELECT id FROM app.messages WHERE channel_id = $1', [dm])).rows)).length).toBe(1);
    expect(await as(omar, async (tx) => (await tx.query("SELECT id FROM app.channels WHERE kind = 'dm'")).rows.length)).toBe(0);
  });

  it('concurrent first opens of one pair converge on one row (ten at once, from both sides)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? open(sameera, omar) : open(omar, sameera))));
    expect(new Set(results.map((r) => r.channel_id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const key = [sameera.personId, omar.personId].sort().join(',');
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.channels WHERE dm_key = $1', [key])).rows.length)).toBe(1);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.channel_members WHERE channel_id = $1', [results[0]!.channel_id])).rows.length)).toBe(2);
  });
});
