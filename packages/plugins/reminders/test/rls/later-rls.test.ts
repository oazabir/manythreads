import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type MigrationSource, type Tx } from '@manythreads/kernel';
import {
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

const { omar, nadia, rafi, priya } = personas;

const remindersMigrationSource: MigrationSource = {
  namespace: 'reminders',
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

// Who reads and writes what (pnpm test:rls): Later items are private to their person, an admin included. A person saves only a message of a
// channel they can read, changes only the state and the reminder of an item, and has at most 200. The system role (the reminders job) sees all.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let openChannel = '';
let openMessage = '';
let privateChannel = '';
let privateMessage = '';

const newChannel = (name: string, isPrivate: boolean, members: Persona[]): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        'INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [omar.workspaceId, TEAM_IDS.Engineering, name, 'channel', isPrivate, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const newMessage = (channel: string): Promise<string> =>
  sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'x', 'x') RETURNING id", [omar.workspaceId, channel, omar.actorId])).rows[0]!.id);

const save = (p: Persona, channel: string, message: string, who: Persona = p): Promise<unknown> =>
  as(p, (tx) =>
    tx.query('INSERT INTO app.later_items (workspace_id, person_id, message_id, channel_id) VALUES ($1, $2, $3, $4)', [who.workspaceId, who.personId, message, channel]),
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, remindersMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  openChannel = await newChannel('later-open', false, []);
  openMessage = await newMessage(openChannel);
  privateChannel = await newChannel('later-private', true, [omar]);
  privateMessage = await newMessage(privateChannel);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the later_items table passes the RLS harness', () => {
  it('RLS is enabled and forced, with policies and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'later_items')).toEqual([]);
      const plan = await admin.query("SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.later_items'::regclass");
      expect(plan.rows[0]).toEqual({ on: true, forced: true });
    } finally {
      await admin.end();
    }
  });
});

describe('a person saves, reads, changes and removes only their own items', () => {
  it('saves a message of a channel they can read, for themself only', async () => {
    await save(nadia, openChannel, openMessage);
    await save(rafi, openChannel, openMessage);
    expect(await code(save(nadia, openChannel, openMessage, rafi))).toBe('42501');           // for someone else
    expect(await code(save(nadia, openChannel, openMessage))).toBe('23505');                 // twice
  });

  it('a channel they cannot read cannot be saved', async () => {
    expect(await code(save(nadia, privateChannel, privateMessage))).toBe('42501');
    await save(omar, privateChannel, privateMessage);                                         // a member can
  });

  it('reads their own rows only; an admin sees nobody else\'s', async () => {
    expect((await q<{ person_id: string }>(nadia, 'SELECT person_id FROM app.later_items')).map((r) => r.person_id)).toEqual([nadia.personId]);
    expect((await q<{ person_id: string }>(rafi, 'SELECT person_id FROM app.later_items')).map((r) => r.person_id)).toEqual([rafi.personId]);
    expect((await q<{ person_id: string }>(omar, 'SELECT person_id FROM app.later_items')).map((r) => r.person_id)).toEqual([omar.personId]);
    expect(await q(priya, 'SELECT 1 FROM app.later_items')).toEqual([]);
  });

  it('marks its own item done and moves its reminder, never anybody else\'s', async () => {
    const own = await as(nadia, (tx) => tx.query("UPDATE app.later_items SET state = 'done', done_at = now(), remind_at = now() + interval '1 hour' WHERE person_id = $1 RETURNING id", [nadia.personId]));
    expect(own.rows).toHaveLength(1);
    const other = await as(nadia, (tx) => tx.query("UPDATE app.later_items SET state = 'done', done_at = now() WHERE person_id = $1 RETURNING id", [rafi.personId]));
    expect(other.rows).toHaveLength(0);
    expect((await q<{ state: string }>(rafi, 'SELECT state FROM app.later_items'))[0]!.state).toBe('open');
  });

  it('an item cannot be moved to another person, message or channel; a done item needs its time and an open one has none', async () => {
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.later_items SET person_id = $1 WHERE person_id = $2', [rafi.personId, nadia.personId])))).toBeDefined();
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.later_items SET message_id = uuidv7() WHERE person_id = $1', [nadia.personId])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.later_items SET channel_id = $1 WHERE person_id = $2', [privateChannel, nadia.personId])))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query("UPDATE app.later_items SET state = 'done' WHERE person_id = $1", [rafi.personId])))).toBe('23514');
  });

  it('removes only its own item', async () => {
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.later_items WHERE person_id = $1 RETURNING id', [rafi.personId]))).rows).toHaveLength(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.later_items WHERE person_id = $1 RETURNING id', [nadia.personId]))).rows).toHaveLength(1);
  });
});

describe('the system role (the reminders job)', () => {
  it('reads every row and may set what a person may not', async () => {
    expect((await sys((tx) => tx.query('SELECT person_id FROM app.later_items'))).rows.length).toBeGreaterThanOrEqual(2);
    const res = await sys((tx) => tx.query("UPDATE app.later_items SET fired_at = now() WHERE person_id = $1 RETURNING id", [rafi.personId]));
    expect(res.rows).toHaveLength(1);
  });
});

describe('the limit of 200 per person', () => {
  it('refuses the 201st with a sentence, and counts per person', async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.later_items (workspace_id, person_id, message_id, channel_id)
         SELECT $1::uuid, $2::uuid, uuidv7(), $3::uuid FROM generate_series(1, 199)`,
        [priya.workspaceId, priya.personId, openChannel],
      ),
    );
    await save(priya, openChannel, openMessage);                                              // the 200th
    const err = await as(priya, (tx) => tx.query('INSERT INTO app.later_items (workspace_id, person_id, message_id, channel_id) VALUES ($1, $2, uuidv7(), $3)', [priya.workspaceId, priya.personId, openChannel])).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('200 saved items');
    await save(nadia, openChannel, openMessage);                                              // somebody else is not affected
  });
});

describe('a deleted channel takes its items with it; a purged message leaves the item', () => {
  it('drops items with the channel, keeps them without the message', async () => {
    const ch = await newChannel('later-short', false, []);
    const msg = await newMessage(ch);
    await save(rafi, ch, msg);
    await sys((tx) => tx.query('DELETE FROM app.messages WHERE id = $1', [msg]));
    expect((await q(rafi, 'SELECT 1 FROM app.later_items WHERE channel_id = $1', [ch])).length).toBe(1);
    // channels are deleted by the owner role only (nothing in the app deletes a channel), so the cascade is checked as the owner
    const owner = testClient({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      expect((await owner.query('DELETE FROM app.channels WHERE id = $1', [ch])).rowCount).toBe(1);
    } finally {
      await owner.end();
    }
    expect(await q(rafi, 'SELECT 1 FROM app.later_items WHERE channel_id = $1', [ch])).toEqual([]);
  });
});
