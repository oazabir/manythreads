import { createHash, randomBytes } from 'node:crypto';
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
  meetingsMigrationSource,
  personaActor,
  personas,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, lena } = personas;

// Guest links (meetings 0012, P17-04). `app.meeting_guest_links` and `app.meeting_guests` are read by whoever can read the call's channel, never with the hashes
// (a column grant leaves them out); nobody writes them but the definers and the system role. `app.meetings_make_guest_link` takes a person of the workspace who is
// not a workspace guest and may post in the channel, a live call with links on (or the starter's first link); `app.meetings_guest_knock` runs only for the system
// role (the guest's public routes); `app.meetings_decide_guest` takes someone in the call. A caller cannot start a call with links on, and the end closes them.

const NIL = '00000000-0000-0000-0000-000000000000';
let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const anonymous = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withActor({ kind: 'person', id: NIL, workspaceId: NIL } as never, fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const hash = (): Buffer => createHash('sha256').update(randomBytes(32)).digest();

let counter = 0;
/** An open channel of Engineering with a live call that `people` are in (the first started it). */
async function callWith(people: Persona[]): Promise<{ meeting: string; channel: string }> {
  const channel = await sys(async (tx) =>
    (
      await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', false, $4) RETURNING id", [
        omar.workspaceId,
        TEAM_IDS.Engineering,
        `guests-${String((counter += 1))}`,
        omar.actorId,
      ])
    ).rows[0]!.id,
  );
  const starter = people[0]!;
  const meeting = await as(starter, async (tx) =>
    (
      // a caller asking for guest links on at the insert gets them off (the first link turns them on)
      await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, allow_guests) VALUES ($1, $2, 'Review', $3, $3, true) RETURNING id", [
        starter.workspaceId,
        channel,
        starter.actorId,
      ])
    ).rows[0]!.id,
  );
  for (const p of people) await as(p, (tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [meeting, p.actorId]));
  return { meeting, channel };
}
const makeLink = (p: Persona, meeting: string, turnOn: boolean, h: Buffer = hash()) =>
  as(p, async (tx) => (await tx.query<{ link_id: string }>('SELECT link_id FROM app.meetings_make_guest_link($1::uuid, $2::bytea, $3::boolean)', [meeting, h, turnOn])).rows[0]!.link_id);
const knockAs = (h: Buffer, name = 'Ana') =>
  sys(async (tx) => (await tx.query<{ guest_id: string }>('SELECT guest_id FROM app.meetings_guest_knock($1::bytea, $2, $3::bytea)', [h, name, hash()])).rows[0]!.guest_id);
const decideAs = (p: Persona, meeting: string, guest: string, d: string) =>
  as(p, async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.meetings_decide_guest($1::uuid, $2::uuid, $3)', [meeting, guest, d])).rows[0]!.state);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, meetingsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('guest links and guests', () => {
  it('pass the RLS harness, and every definer is owned by the system role with a fixed search_path and no PUBLIC execute', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      const fns = (
        await admin.query<{ name: string; owner: string; definer: boolean; config: string[] | null; public_exec: boolean }>(
          `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.proname IN ('meetings_make_guest_link', 'meetings_revoke_guest_links', 'meetings_guest_knock', 'meetings_decide_guest', 'meetings_guests_on_end')
            ORDER BY p.proname`,
        )
      ).rows;
      expect(fns.map((f) => f.name)).toEqual(['meetings_decide_guest', 'meetings_guest_knock', 'meetings_guests_on_end', 'meetings_make_guest_link', 'meetings_revoke_guest_links']);
      for (const f of fns) {
        expect(f.owner, f.name).toBe('manythreads_system');
        expect(f.definer, f.name).toBe(true);
        expect(f.config?.some((c) => c.startsWith('search_path=')), f.name).toBe(true);
      }
      for (const f of fns.filter((x) => x.name !== 'meetings_guests_on_end')) expect(f.public_exec, f.name).toBe(false);
      const forced = (await admin.query<{ relname: string; forced: boolean }>("SELECT relname, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('meeting_guest_links', 'meeting_guests', 'meeting_guest_presence') ORDER BY relname")).rows;
      expect(forced).toEqual([
        { relname: 'meeting_guest_links', forced: true },
        { relname: 'meeting_guest_presence', forced: true },
        { relname: 'meeting_guests', forced: true },
      ]);
      // the app role may read the rows but not the hashes, and nothing of the heartbeat
      const rights = (
        await admin.query<{ link_hash: boolean; link_id: boolean; cred: boolean; name: boolean; presence: boolean; knock: boolean }>(
          `SELECT has_column_privilege('manythreads_app', 'app.meeting_guest_links', 'token_hash', 'SELECT') AS link_hash,
                  has_column_privilege('manythreads_app', 'app.meeting_guest_links', 'id', 'SELECT') AS link_id,
                  has_column_privilege('manythreads_app', 'app.meeting_guests', 'credential_hash', 'SELECT') AS cred,
                  has_column_privilege('manythreads_app', 'app.meeting_guests', 'display_name', 'SELECT') AS name,
                  has_table_privilege('manythreads_app', 'app.meeting_guest_presence', 'SELECT') AS presence,
                  has_function_privilege('manythreads_app', 'app.meetings_guest_knock(bytea, text, bytea)', 'EXECUTE') AS knock`,
        )
      ).rows[0];
      expect(rights).toEqual({ link_hash: false, link_id: true, cred: false, name: true, presence: false, knock: false });
    } finally {
      await admin.end();
    }
  });

  it('a caller cannot start a call with links on; the starter\'s first link turns them on, and only then may others make links', async () => {
    const { meeting } = await callWith([nadia, rafi]);
    expect(await sys(async (tx) => (await tx.query<{ on: boolean }>('SELECT allow_guests AS on FROM app.meetings WHERE id = $1', [meeting])).rows[0]!.on)).toBe(false);
    // someone else cannot turn them on, and links that are off make no link
    expect(await code(makeLink(rafi, meeting, true))).toBe('23514');
    expect(await code(makeLink(rafi, meeting, false))).toBe('23514');
    // nor can a caller flip the column
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.meetings SET allow_guests = true WHERE id = $1', [meeting])))).toBe('23514');
    await makeLink(nadia, meeting, true);
    await makeLink(rafi, meeting, false);
    // the starter's switch works once: after the first link, links are on, and turning them off keeps them off
    await as(nadia, (tx) => tx.query('SELECT * FROM app.meetings_revoke_guest_links($1::uuid)', [meeting]));
    expect(await code(makeLink(nadia, meeting, true))).toBe('23514');
  });

  it('readers of the channel see the links and guests without the hashes; others, the anonymous actor and a workspace guest see nothing', async () => {
    const { meeting } = await callWith([nadia]);
    const h = hash();
    await makeLink(nadia, meeting, true, h);
    await knockAs(h);
    const count = (p: Persona | null, table: string) =>
      (p ? (fn: (tx: Tx) => Promise<number>) => as(p, fn) : anonymous)(async (tx) => (await tx.query(`SELECT id FROM app.${table} WHERE meeting_id = $1`, [meeting])).rows.length);
    expect(await count(rafi, 'meeting_guest_links')).toBe(1);
    expect(await count(rafi, 'meeting_guests')).toBe(1);
    for (const p of [sameera, lena, null]) {
      expect(await count(p, 'meeting_guest_links'), p?.key ?? 'anonymous').toBe(0);
      expect(await count(p, 'meeting_guests'), p?.key ?? 'anonymous').toBe(0);
    }
    expect(await code(as(rafi, (tx) => tx.query('SELECT token_hash FROM app.meeting_guest_links WHERE meeting_id = $1', [meeting])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('SELECT credential_hash FROM app.meeting_guests WHERE meeting_id = $1', [meeting])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('SELECT * FROM app.meeting_guests WHERE meeting_id = $1', [meeting])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('SELECT * FROM app.meeting_guest_presence')))).toBe('42501');
  });

  it('nobody writes the tables directly', async () => {
    const { meeting, channel } = await callWith([nadia]);
    const h = hash();
    const link = await makeLink(nadia, meeting, true, h);
    const guest = await knockAs(h);
    expect(
      await code(as(nadia, (tx) => tx.query("INSERT INTO app.meeting_guest_links (meeting_id, channel_id, workspace_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')", [meeting, channel, nadia.workspaceId, hash(), nadia.actorId]))),
    ).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.meeting_guest_links SET uses = 0 WHERE id = $1', [link])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_guests SET state = 'admitted' WHERE id = $1", [guest])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.meeting_guests WHERE id = $1', [guest])))).toBe('42501');
    // the knock is the system role's only
    expect(await code(as(nadia, (tx) => tx.query("SELECT * FROM app.meetings_guest_knock($1::bytea, 'Ana', $2::bytea)", [h, hash()])))).toBe('42501');
    // a system session makes no link and decides nothing (there is no person behind it)
    expect(await code(sys((tx) => tx.query('SELECT * FROM app.meetings_make_guest_link($1::uuid, $2::bytea, false)', [meeting, hash()])))).toBe('42501');
    expect(await code(sys((tx) => tx.query("SELECT * FROM app.meetings_decide_guest($1::uuid, $2::uuid, 'admit')", [meeting, guest])))).toBe('42501');
  });

  it('a workspace guest and a reader outside the call cannot make links or let anyone in; the first answer wins; the end closes everything', async () => {
    const { meeting } = await callWith([nadia, rafi]);
    expect(await code(makeLink(lena, meeting, false))).toBe('P0002');
    const h = hash();
    await makeLink(nadia, meeting, true, h);
    const a = await knockAs(h, 'Ana');
    const b = await knockAs(h, 'Ben');
    // omar can read the channel but is not in the call
    expect(await code(decideAs(omar, meeting, a, 'admit'))).toBe('42501');
    expect(await decideAs(rafi, meeting, a, 'admit')).toBe('admitted');
    expect(await code(decideAs(nadia, meeting, a, 'deny'))).toBe('23514');
    expect(await decideAs(nadia, meeting, b, 'deny')).toBe('denied');
    // a dead link knocks no more: unknown, used up, revoked
    expect(await code(knockAs(hash()))).toBe('P0002');
    await sys((tx) => tx.query('UPDATE app.meeting_guest_links SET max_uses = uses WHERE meeting_id = $1', [meeting]));
    expect(await code(knockAs(h))).toBe('P0002');
    await sys((tx) => tx.query('SELECT app.meetings_end($1::uuid, $2)', [meeting, 'empty']));
    const after = await sys(async (tx) => ({
      guests: (await tx.query<{ state: string }>('SELECT state FROM app.meeting_guests WHERE meeting_id = $1 ORDER BY asked_at, id', [meeting])).rows.map((r) => r.state),
      links: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meeting_guest_links WHERE meeting_id = $1 AND revoked_at IS NULL', [meeting])).rows[0]!.n,
    }));
    expect(after).toEqual({ guests: ['left', 'denied'], links: 0 });
  });

  it('a name with control or direction characters is refused by the table, and at most 10 guests wait per call', async () => {
    const { meeting } = await callWith([nadia]);
    const h = hash();
    await makeLink(nadia, meeting, true, h);
    expect(await code(knockAs(h, 'Ana‮'))).toBe('23514');
    expect(await code(knockAs(h, 'x'.repeat(61)))).toBe('23514');
    for (let i = 0; i < 10; i++) await knockAs(h, `G${i}`);
    expect(await code(knockAs(h, 'Late'))).toBe('54000');
  });
});
