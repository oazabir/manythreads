import { readFileSync } from 'node:fs';
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

const { omar, nadia, rafi } = personas;

// The call card's stamp (meetings 0007, P15-26): `meta.meeting` on a message is accepted only on a call's own top-level start message, written by the person who started the
// call while it is live and before it has one; one card per call; the call's thread starts only at its stamped message; and the stamp given to the start messages written
// before 0007 goes to real start messages only.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const newChannel = (name: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', false, $4) RETURNING id", [
          omar.workspaceId,
          TEAM_IDS.Engineering,
          name,
          omar.actorId,
        ])
      ).rows[0]!.id,
  );
const startRoom = (p: Persona, channel: string): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, 'Standup', $3, $3) RETURNING id", [p.workspaceId, channel, p.actorId])).rows[0]!.id);
const stamp = (meetingId: string): Record<string, unknown> => ({ meeting: { meetingId } });
/** A message written straight into the table as `p` (no route, no provider): what a person could try with the database alone. */
const post = (p: Persona, channel: string, meta: unknown = {}, threadRootId: string | null = null, body = 'Started a call: Standup'): Promise<string> =>
  as(
    p,
    async (tx) =>
      (
        await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta, thread_root_id) VALUES ($1, $2, $3, $4, $4, $5::jsonb, $6) RETURNING id', [
          p.workspaceId,
          channel,
          p.actorId,
          body,
          JSON.stringify(meta),
          threadRootId,
        ])
      ).rows[0]!.id,
  );
const setThread = (p: Persona, meetingId: string, rootId: string | null): Promise<unknown> =>
  as(p, (tx) => tx.query('UPDATE app.meetings SET thread_root_id = $2 WHERE id = $1', [meetingId, rootId]));
const threadOf = async (meetingId: string): Promise<string | null> =>
  sys(async (tx) => (await tx.query<{ thread_root_id: string | null }>('SELECT thread_root_id FROM app.meetings WHERE id = $1', [meetingId])).rows[0]!.thread_root_id);
const metaOf = async (messageId: string): Promise<Record<string, unknown>> =>
  sys(async (tx) => (await tx.query<{ meta: Record<string, unknown> }>('SELECT meta FROM app.messages WHERE id = $1', [messageId])).rows[0]!.meta);

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

describe('the tables', () => {
  it('still pass the RLS harness', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
  it('a new call is audio unless the row says otherwise, and its kind is fixed afterwards', async () => {
    const room = await startRoom(nadia, await newChannel('cc-kind'));
    expect((await sys(async (tx) => (await tx.query<{ kind: string }>('SELECT kind FROM app.meetings WHERE id = $1', [room])).rows[0]))?.kind).toBe('audio');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meetings SET kind = 'video' WHERE id = $1", [room])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.meetings SET kind = 'screen' WHERE id = $1", [room])))).toBe('23514');
  });
});

describe('the stamp on a start message', () => {
  let ch = '';
  let other = '';
  let room = '';
  beforeAll(async () => {
    ch = await newChannel('cc-stamp');
    other = await newChannel('cc-other');
    room = await startRoom(nadia, ch);
  });

  it('is refused on someone else’s call, even to a plain person writing straight into the table (42501)', async () => {
    expect(await code(post(rafi, ch, stamp(room)))).toBe('42501');
  });
  it('is refused in another channel, on a reply, and with a shape that is not exactly { meetingId: uuid }', async () => {
    expect(await code(post(nadia, other, stamp(room)))).toBe('42501');
    const plain = await post(nadia, ch, {}, null, 'hello');
    expect(await code(post(nadia, ch, stamp(room), plain))).toBe('42501');
    expect(await code(post(nadia, ch, { meeting: { meetingId: 'not-a-uuid' } }))).toBe('23514');
    expect(await code(post(nadia, ch, { meeting: { meetingId: room, title: 'x' } }))).toBe('23514');
    expect(await code(post(nadia, ch, { meeting: room }))).toBe('23514');
    // a call that does not exist (or that the caller cannot read) is the same refusal as someone else's
    expect(await code(post(nadia, ch, stamp('00000000-0000-7000-8000-00000000abcd')))).toBe('42501');
  });
  it('is taken on the starter’s own top-level message of the live call, once: the call then has its card and a second is refused', async () => {
    const card = await post(nadia, ch, stamp(room));
    await setThread(nadia, room, card);
    expect(await threadOf(room)).toBe(card);
    expect(await metaOf(card)).toEqual(stamp(room));
    // the call has its start message now: the trigger refuses another, and the unique index refuses one the system role writes
    expect(await code(post(nadia, ch, stamp(room)))).toBe('42501');
    expect(
      await code(sys((tx) => tx.query("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, 'x', 'x', $4::jsonb)", [omar.workspaceId, ch, nadia.actorId, JSON.stringify(stamp(room))]))),
    ).toBe('23505');
  });
  it('is refused on an ended call', async () => {
    const ch2 = await newChannel('cc-ended');
    const ended = await startRoom(nadia, ch2);
    await as(nadia, (tx) => tx.query("SELECT app.meetings_end($1, 'person')", [ended]));
    expect(await code(post(nadia, ch2, stamp(ended)))).toBe('42501');
  });
  it('an ordinary message never runs the check', async () => {
    expect(await code(post(rafi, ch, {}, null, 'just talking'))).toBeUndefined();
  });
  it('a caller cannot add the stamp to a message afterwards', async () => {
    const ch3 = await newChannel('cc-late');
    const later = await startRoom(nadia, ch3);
    const msg = await post(nadia, ch3, {}, null, 'Started a call: Standup');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.messages SET meta = meta || $2::jsonb WHERE id = $1", [msg, JSON.stringify(stamp(later))])))).toBe('42501');
  });
});

describe('the call thread', () => {
  it('starts only at the message stamped with this call, set once by the starter; going back to nothing (a deleted message) stays allowed', async () => {
    const ch = await newChannel('cc-thread');
    const room = await startRoom(nadia, ch);
    const plain = await post(nadia, ch, {}, null, 'Started a voice room: Standup');
    expect(await code(setThread(nadia, room, plain))).toBe('42501');
    // another call's card is not this call's
    const ch2 = await newChannel('cc-thread-2');
    const room2 = await startRoom(nadia, ch2);
    const card2 = await post(nadia, ch2, stamp(room2));
    expect(await code(setThread(nadia, room, card2))).toBe('42501');
    const card = await post(nadia, ch, stamp(room));
    expect(await code(setThread(nadia, room, card))).toBeUndefined();
    // once set it does not move to another message
    expect(await code(setThread(nadia, room, plain))).toBe('42501');
    // the foreign key's ON DELETE SET NULL runs as the table owner: removing the message leaves the call without a thread, and is not refused
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      await admin.query('DELETE FROM app.messages WHERE id = $1', [card]);
    } finally {
      await admin.end();
    }
    expect(await threadOf(room)).toBeNull();
  });
});

describe('the start messages written before 0007', () => {
  it('get the stamp only when they are the starter’s own top-level "Started a voice room:" message in the call’s channel', async () => {
    const ch = await newChannel('cc-legacy');
    const ch2 = await newChannel('cc-legacy-2');
    // legacy rows as the system role (the old guard let these shapes in)
    const seeded = await sys(async (tx) => {
      const msg = async (channel: string, author: string, body: string, threadRootId: string | null = null): Promise<string> =>
        (
          await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id', [
            omar.workspaceId,
            channel,
            author,
            body,
            threadRootId,
          ])
        ).rows[0]!.id;
      const meeting = async (channel: string, starter: string, root: string): Promise<string> =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, state, ended_at, end_reason, thread_root_id)
             VALUES ($1, $2, 'Old call', $3, $3, 'ended', now(), 'person', $4) RETURNING id`,
            [omar.workspaceId, channel, starter, root],
          )
        ).rows[0]!.id;
      const real = await msg(ch, nadia.actorId, 'Started a voice room: Old call');
      const realRoom = await meeting(ch, nadia.actorId, real);
      const notTheStarters = await msg(ch, rafi.actorId, 'Started a voice room: Old call');
      const notTheStartersRoom = await meeting(ch, nadia.actorId, notTheStarters);
      const otherWords = await msg(ch, nadia.actorId, 'Lunch at noon?');
      const otherWordsRoom = await meeting(ch, nadia.actorId, otherWords);
      const reply = await msg(ch, nadia.actorId, 'Started a voice room: Old call', real);
      const replyRoom = await meeting(ch, nadia.actorId, reply);
      const elsewhere = await msg(ch2, nadia.actorId, 'Started a voice room: Old call');
      const elsewhereRoom = await meeting(ch, nadia.actorId, elsewhere);
      // two meetings at one message: stamped once, for the earlier meeting
      const shared = await msg(ch, nadia.actorId, 'Started a voice room: Old call');
      const sharedFirst = await meeting(ch, nadia.actorId, shared);
      await meeting(ch, nadia.actorId, shared);
      return { real, realRoom, notTheStarters, notTheStartersRoom, otherWords, otherWordsRoom, reply, replyRoom, elsewhere, elsewhereRoom, shared, sharedFirst };
    });
    const file = readFileSync(new URL('../../migrations/0007_call_card.sql', import.meta.url), 'utf8');
    const block = file.slice(file.indexOf('-- legacy-begin') + '-- legacy-begin'.length, file.indexOf('-- legacy-end'));
    expect(block).toContain('SET ROLE manythreads_system');
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      await admin.query(block);
      // running it again changes nothing (a stamped message is left alone)
      await admin.query(block);
    } finally {
      await admin.end();
    }
    expect(await metaOf(seeded.real)).toEqual(stamp(seeded.realRoom));
    expect(await metaOf(seeded.shared)).toEqual(stamp(seeded.sharedFirst));
    for (const id of [seeded.notTheStarters, seeded.otherWords, seeded.reply, seeded.elsewhere]) expect(await metaOf(id)).toEqual({});
    // the update is meta only: no version of the message was kept, so nothing reads as edited
    const versions = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_versions WHERE message_id = $1', [seeded.real])).rows[0]!.n);
    expect(versions).toBe(0);
  });
});
