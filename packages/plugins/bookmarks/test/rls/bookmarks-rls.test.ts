import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  bookmarksMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
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

const { omar, nadia, rafi, priya, lena } = personas;

// Who reads and writes what (pnpm test:rls, P36-08): bookmarks are private to their person, an admin included; there is no admin or system policy. A person
// bookmarks only for themself and only what they can see now; a bookmark is never changed in place; at most 500 per person, also under a race.

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
let doomedChannel = '';

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

const thread = (p: Persona, channel: string, root: string, who: Persona = p): Promise<unknown> =>
  as(p, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, thread_root_id, channel_id) VALUES ($1, $2, 'thread', $3, $4)", [who.workspaceId, who.personId, root, channel]));
const message = (p: Persona, channel: string, msg: string): Promise<unknown> =>
  as(p, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id) VALUES ($1, $2, 'message', $3, $4)", [p.workspaceId, p.personId, msg, channel]));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, bookmarksMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 6);
  sysPool = createSystemPool(db.systemUrl, 2);
  openChannel = await newChannel('bm-open', false, []);
  openMessage = await newMessage(openChannel);
  privateChannel = await newChannel('bm-private', true, [omar]);
  privateMessage = await newMessage(privateChannel);
  doomedChannel = await newChannel('bm-doomed', false, []);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the bookmarks table passes the RLS harness', () => {
  it('RLS is enabled and forced, with policies and an rls comment; no policy calls a per-row helper; no admin or system policy', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'bookmarks')).toEqual([]);
      const plan = await admin.query("SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.bookmarks'::regclass");
      expect(plan.rows[0]).toEqual({ on: true, forced: true });
      const policies = await admin.query<{ policyname: string }>("SELECT policyname FROM pg_policies WHERE schemaname = 'app' AND tablename = 'bookmarks' ORDER BY 1");
      expect(policies.rows.map((r) => r.policyname)).toEqual(['bookmarks_delete', 'bookmarks_insert', 'bookmarks_select']);
    } finally {
      await admin.end();
    }
  });
});

describe('a person bookmarks, reads and removes only their own', () => {
  it('bookmarks a thread and a message of a channel they can read, for themself only, once each', async () => {
    await thread(nadia, openChannel, openMessage);
    await message(nadia, openChannel, openMessage);
    await thread(rafi, openChannel, openMessage);
    expect(await code(thread(nadia, openChannel, openMessage, rafi))).toBe('42501'); // for someone else
    expect(await code(thread(nadia, openChannel, openMessage))).toBe('23505'); // twice
    expect(await code(message(nadia, openChannel, openMessage))).toBe('23505');
  });

  it('a channel they cannot read cannot be bookmarked; a member can', async () => {
    expect(await code(thread(nadia, privateChannel, privateMessage))).toBe('42501');
    expect(await code(message(nadia, privateChannel, privateMessage))).toBe('42501');
    expect(await code(message(lena, openChannel, openMessage))).toBe('42501'); // a guest with no grant
    await message(omar, privateChannel, privateMessage);
  });

  it('a file they cannot see, or a team they cannot read, is refused', async () => {
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, file_id) VALUES ($1, $2, 'file', uuidv7())", [nadia.workspaceId, nadia.personId])))).toBe('42501');
    expect(
      await code(as(priya, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, team_id, path) VALUES ($1, $2, 'repo_file', $3, 'README.md')", [priya.workspaceId, priya.personId, TEAM_IDS['Customer support']]))),
    ).toBe('42501');
    // a team the person reads
    await as(nadia, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, team_id, path) VALUES ($1, $2, 'repo_file', $3, 'docs/a.md')", [nadia.workspaceId, nadia.personId, TEAM_IDS.Engineering]));
  });

  it('each kind fills only its own columns', async () => {
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, channel_id) VALUES ($1, $2, 'thread', $3)", [nadia.workspaceId, nadia.personId, openChannel])))).toBe('23514');
    expect(
      await code(as(nadia, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id, path) VALUES ($1, $2, 'message', uuidv7(), $3, 'x')", [nadia.workspaceId, nadia.personId, openChannel]))),
    ).toBe('23514');
    // an unknown kind: the insert policy refuses it first (WITH CHECK runs before the table's CHECK), and the CHECK holds for the owner role too
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id) VALUES ($1, $2, 'pin', uuidv7(), $3)", [nadia.workspaceId, nadia.personId, openChannel])))).toBe('42501');
    const owner = testClient({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      expect(await code(owner.query("INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id) VALUES ($1, $2, 'pin', uuidv7(), $3)", [nadia.workspaceId, nadia.personId, openChannel]))).toBe('23514');
    } finally {
      await owner.end();
    }
  });

  it('reads their own rows only; an admin sees nobody else\'s', async () => {
    expect(new Set((await q<{ person_id: string }>(nadia, 'SELECT person_id FROM app.bookmarks')).map((r) => r.person_id))).toEqual(new Set([nadia.personId]));
    expect((await q<{ person_id: string }>(rafi, 'SELECT person_id FROM app.bookmarks')).map((r) => r.person_id)).toEqual([rafi.personId]);
    expect((await q<{ person_id: string }>(omar, 'SELECT person_id FROM app.bookmarks')).map((r) => r.person_id)).toEqual([omar.personId]);
    expect(await q(priya, 'SELECT 1 FROM app.bookmarks')).toEqual([]);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.bookmarks')).rows)).toEqual([]);
  });

  it('a bookmark is never changed, by its owner or anyone', async () => {
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.bookmarks SET created_at = now() WHERE person_id = $1', [nadia.personId])))).toBeDefined();
    const owner = testClient({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      expect(await code(owner.query('UPDATE app.bookmarks SET created_at = now()'))).toBe('23514');
    } finally {
      await owner.end();
    }
  });

  it('removes only its own', async () => {
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.bookmarks WHERE person_id = $1 RETURNING id', [rafi.personId]))).rows).toHaveLength(0);
    expect((await as(nadia, (tx) => tx.query("DELETE FROM app.bookmarks WHERE person_id = $1 AND kind = 'repo_file' RETURNING id", [nadia.personId]))).rows).toHaveLength(1);
  });
});

describe('cascades', () => {
  it('a deleted channel takes its bookmarks with it', async () => {
    const msg = await newMessage(doomedChannel);
    await message(rafi, doomedChannel, msg);
    expect(await q(rafi, 'SELECT 1 FROM app.bookmarks WHERE channel_id = $1', [doomedChannel])).toHaveLength(1);
    const owner = testClient({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      // nothing in the app deletes a channel, so the owner role does (MISTAKES P14-04)
      expect((await owner.query('DELETE FROM app.channels WHERE id = $1', [doomedChannel])).rowCount).toBe(1);
    } finally {
      await owner.end();
    }
    expect(await q(rafi, 'SELECT 1 FROM app.bookmarks WHERE channel_id = $1', [doomedChannel])).toHaveLength(0);
  });
});

describe('the limit of 500 per person', () => {
  it('refuses the 501st with a sentence, counts per person, and holds under a race', async () => {
    // 498 rows through the person's own role, then two racing inserts for the last two places and a third that must fail
    await as(priya, (tx) =>
      tx.query(
        `INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id)
         SELECT $1::uuid, $2::uuid, 'message', uuidv7(), $3::uuid FROM generate_series(1, 498)`,
        [priya.workspaceId, priya.personId, openChannel],
      ),
    );
    const one = (): Promise<string | undefined> => code(message(priya, openChannel, crypto.randomUUID()));
    const results = await Promise.all([one(), one(), one()]);
    expect(results.filter((r) => r === undefined)).toHaveLength(2);
    expect(results.filter((r) => r === '23514')).toHaveLength(1);
    expect((await q<{ n: number }>(priya, 'SELECT count(*)::int AS n FROM app.bookmarks'))[0]!.n).toBe(500);
    const err = await message(priya, openChannel, crypto.randomUUID()).then(() => null, (e: Error) => e.message);
    expect(err).toBe('You have 500 bookmarks. Remove some first.');
    // another person is not counted against her
    await message(rafi, openChannel, crypto.randomUUID());
  });
});
