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

const { omar, nadia, rafi, sameera, lena, priya } = personas;

// Who reads and writes what (pnpm test:rls): a voice room is as visible as its channel; whoever may post there starts one (a person, as themself); the people of a
// room are written by themselves only; a room ends through app.meetings_end (the starter, a lead, an admin); the heartbeat is private to its person.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let pub = '';
let priv = '';
const newChannel = (name: string, isPrivate: boolean, members: Persona[]): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
        omar.workspaceId,
        TEAM_IDS.Engineering,
        name,
        'channel',
        isPrivate,
        omar.actorId,
      ])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const startRoom = (p: Persona, channel: string, startedBy: Persona = p): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, $3, $4, $4) RETURNING id', [p.workspaceId, channel, 'Standup', startedBy.actorId])).rows[0]!.id);
const join = (p: Persona, meeting: string, as_: Persona = p): Promise<unknown> =>
  as(p, (tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [meeting, as_.actorId]));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, meetingsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  pub = await newChannel('meet-open', false, []);
  priv = await newChannel('meet-private', true, [nadia, rafi]);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the tables', () => {
  it('pass the RLS harness: forced RLS, a rls: comment, policies for every command, no grant beyond the policies', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('starting a room', () => {
  let room = '';
  it('a person who may post in the channel starts one, as themself', async () => {
    room = await startRoom(nadia, pub);
    const [row] = await q<{ team_id: string; state: string; organizer_id: string }>(nadia, 'SELECT team_id, state, organizer_id FROM app.meetings WHERE id = $1', [room]);
    expect(row).toMatchObject({ team_id: TEAM_IDS.Engineering, state: 'live', organizer_id: nadia.actorId });
  });
  it('is refused for a person outside the team, a guest, and for someone else as the starter', async () => {
    expect(await code(startRoom(sameera, pub))).toBe('42501');
    expect(await code(startRoom(lena, pub))).toBe('42501');
    expect(await code(startRoom(rafi, pub, nadia))).toBe('42501');
  });
  it('a second live room in the same channel is a duplicate, whoever tries; a new one is fine once the first ended', async () => {
    expect(await code(startRoom(rafi, pub))).toBe('23505');
    expect(await code(sys((tx) => tx.query("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, 'x', $3, $3)", [omar.workspaceId, pub, omar.actorId])))).toBe('23505');
  });
  it('a caller cannot choose the state or the settings of a new room', async () => {
    const id = await as(rafi, async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, state, transcription, recording, ended_at, end_reason) VALUES ($1, $2, 'Planning', $3, $4, 'ended', 'server', true, now(), 'person') RETURNING id", [rafi.workspaceId, await newChannel('meet-fresh', false, []), rafi.actorId, omar.actorId])).rows[0]!.id);
    const [row] = await q<{ state: string; transcription: string; recording: boolean; ended_at: Date | null; organizer_id: string }>(rafi, 'SELECT state, transcription, recording, ended_at, organizer_id FROM app.meetings WHERE id = $1', [id]);
    expect(row).toMatchObject({ state: 'live', transcription: 'off', recording: false, ended_at: null, organizer_id: rafi.actorId });
  });
  it('a title is one line', async () => {
    expect(await code(as(nadia, async (tx) => tx.query("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, E'a\\nb', $3, $3)", [nadia.workspaceId, await newChannel('meet-title', false, []), nadia.actorId])))).toBe('23514');
  });
});

describe('who sees a room and its people', () => {
  it('whoever reads the channel; a private channel only to its members, an admin who is not a member included', async () => {
    const room = await startRoom(nadia, priv);
    await join(nadia, room);
    expect((await q(nadia, 'SELECT 1 FROM app.meetings WHERE id = $1', [room])).length).toBe(1);
    expect((await q(rafi, 'SELECT 1 FROM app.meetings WHERE id = $1', [room])).length).toBe(1);
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1', [room])).length).toBe(1);
    for (const outsider of [omar, sameera, lena]) {
      expect((await q(outsider, 'SELECT 1 FROM app.meetings WHERE id = $1', [room])).length, outsider.key).toBe(0);
      expect((await q(outsider, 'SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1', [room])).length, outsider.key).toBe(0);
    }
    expect(await code(join(omar, room))).toBe('42501');
  });
  it('a room of an open channel is read by the team, not by other teams or guests', async () => {
    const [open] = await sys(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.meetings WHERE channel_id = $1 AND state = 'live'", [pub])).rows);
    expect((await q(rafi, 'SELECT 1 FROM app.meetings WHERE id = $1', [open!.id])).length).toBe(1);
    expect((await q(omar, 'SELECT 1 FROM app.meetings WHERE id = $1', [open!.id])).length).toBe(1);
    for (const outsider of [sameera, lena]) expect((await q(outsider, 'SELECT 1 FROM app.meetings WHERE id = $1', [open!.id])).length, outsider.key).toBe(0);
  });
});

describe('the people of a room', () => {
  let room = '';
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('meet-people', false, []));
  });
  it('a person joins as themself, with their name and place copied from the room and the person', async () => {
    await join(nadia, room);
    const [p] = await q<{ person_id: string; display_name: string; team_id: string; left_at: Date | null; consent_transcribe: string }>(nadia, 'SELECT person_id, display_name, team_id, left_at, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1', [room]);
    expect(p).toMatchObject({ person_id: nadia.personId, display_name: 'Nadia', team_id: TEAM_IDS.Engineering, left_at: null, consent_transcribe: 'unasked' });
    // the reader sees the name though `actors` shows them only themself
    const [seen] = await q<{ display_name: string }>(rafi, 'SELECT display_name FROM app.meeting_participants WHERE meeting_id = $1', [room]);
    expect(seen?.display_name).toBe('Nadia');
  });
  it('nobody joins, changes or removes the place of another person', async () => {
    expect(await code(join(rafi, room, nadia))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = $1', [room])))).toBeUndefined();
    expect((await q(nadia, 'SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1 AND left_at IS NULL', [room])).length).toBe(1);
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.meeting_participants SET person_id = $2 WHERE meeting_id = $1', [room, rafi.personId])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.meeting_participants WHERE meeting_id = $1', [room])))).toBe('42501');
  });
  it('the empty-room clock follows the last person', async () => {
    const empty = async (): Promise<Date | null> => (await sys(async (tx) => (await tx.query<{ empty_since: Date | null }>('SELECT empty_since FROM app.meetings WHERE id = $1', [room])).rows[0]!)).empty_since;
    expect(await empty()).toBeNull();
    await join(rafi, room);
    await as(nadia, (tx) => tx.query('UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = $1 AND actor_id = $2', [room, nadia.actorId]));
    expect(await empty()).toBeNull();
    await as(rafi, (tx) => tx.query('UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = $1 AND actor_id = $2', [room, rafi.actorId]));
    expect(await empty()).not.toBeNull();
    await as(nadia, (tx) => tx.query('UPDATE app.meeting_participants SET left_at = NULL WHERE meeting_id = $1 AND actor_id = $2', [room, nadia.actorId]));
    expect(await empty()).toBeNull();
  });
  it('a person who is not on the team cannot be put in the room (a bot or another workspace never is)', async () => {
    const botActor = await sys(async (tx) => {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, 'meet-bot', 'Meet bot', 'Listens', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, 'a'.repeat(64)],
      );
      return (await tx.query<{ id: string }>("INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id])).rows[0]!.id;
    });
    expect(await code(sys((tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [room, botActor])))).toBe('23514');
  });
});

describe('ending a room', () => {
  it('the starter, a lead of the team and an admin end it; another member, an outsider and the app role without the function cannot', async () => {
    const channel = await newChannel('meet-end', false, []);
    const room = await startRoom(nadia, channel);
    await join(nadia, room);
    expect(await code(as(rafi, (tx) => tx.query("SELECT app.meetings_end($1, 'person')", [room])))).toBe('42501');
    expect(await code(as(sameera, (tx) => tx.query("SELECT app.meetings_end($1, 'person')", [room])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query("UPDATE app.meetings SET state = 'ended', ended_at = now(), end_reason = 'person' WHERE id = $1", [room])))).toBeUndefined();
    expect((await sys(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.meetings WHERE id = $1', [room])).rows[0]!)).state).toBe('live');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meetings SET title = 'renamed' WHERE id = $1", [room])))).toBe('23514');
    // the lead of the team, who did not start it
    const [ended] = await q<{ ended: boolean }>(omar, "SELECT app.meetings_end($1, 'person') AS ended", [room]);
    expect(ended?.ended).toBe(true);
    const [row] = await sys(async (tx) => (await tx.query<{ state: string; ended_by: string; end_reason: string }>('SELECT state, ended_by, end_reason FROM app.meetings WHERE id = $1', [room])).rows);
    expect(row).toMatchObject({ state: 'ended', ended_by: omar.actorId, end_reason: 'person' });
    // everyone in it is marked as gone, and the room takes no one and does not end twice
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1 AND left_at IS NULL', [room])).rows)).length).toBe(0);
    expect(await code(join(rafi, room))).toBe('23514');
    expect((await q<{ ended: boolean }>(nadia, "SELECT app.meetings_end($1, 'person') AS ended", [room]))[0]?.ended).toBe(false);
    // an ended room does not come back
    expect(await code(sys((tx) => tx.query("UPDATE app.meetings SET state = 'live', ended_at = NULL, end_reason = NULL WHERE id = $1", [room])))).toBe('23514');
  });
  it('the system role ends an empty room with no one as the closer', async () => {
    const room = await startRoom(nadia, await newChannel('meet-empty', false, []));
    const ended = (await sys(async (tx) => (await tx.query<{ ended: boolean }>("SELECT app.meetings_end($1, 'empty') AS ended", [room])).rows[0]!)).ended;
    expect(ended).toBe(true);
    const [row] = await sys(async (tx) => (await tx.query<{ ended_by: string | null; end_reason: string }>('SELECT ended_by, end_reason FROM app.meetings WHERE id = $1', [room])).rows);
    expect(row).toMatchObject({ ended_by: null, end_reason: 'empty' });
  });
});

describe('transcript lines and the heartbeat', () => {
  let room = '';
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('meet-words', false, []));
    await join(nadia, room);
    // a line is only taken while the room's transcription is on, and has words only from a person who said yes
    await as(nadia, (tx) => tx.query("SELECT app.meetings_set_transcription($1, 'on_device')", [room]));
    await as(nadia, (tx) => tx.query("SELECT app.meetings_set_consent($1, 'yes')", [room]));
  });
  const segment = (p: Persona, speaker: Persona = p, source = 'device'): Promise<unknown> =>
    as(p, (tx) => tx.query("INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source) VALUES ($1, $2, 0, 1000, 'hello', $3)", [room, speaker.actorId, source]));
  it('a person in the room writes their own lines; nobody else does, and a line is never changed', async () => {
    await segment(nadia);
    expect(await code(segment(rafi))).toBe('42501');
    expect(await code(segment(nadia, rafi))).toBe('42501');
    expect(await code(segment(nadia, nadia, 'server'))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_segments SET text = 'x' WHERE meeting_id = $1", [room])))).toBe('42501');
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1', [room])).length).toBe(1);
    expect((await q(sameera, 'SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1', [room])).length).toBe(0);
  });
  it('the heartbeat is the person\'s own and nobody else can read it', async () => {
    await as(nadia, (tx) => tx.query('INSERT INTO app.meeting_presence (meeting_id, actor_id) VALUES ($1, $2)', [room, nadia.actorId]));
    expect(await code(as(rafi, (tx) => tx.query('INSERT INTO app.meeting_presence (meeting_id, actor_id) VALUES ($1, $2)', [room, nadia.actorId])))).toBe('42501');
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_presence WHERE meeting_id = $1', [room])).length).toBe(0);
    expect((await q(nadia, 'SELECT 1 FROM app.meeting_presence WHERE meeting_id = $1', [room])).length).toBe(1);
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.meeting_presence WHERE meeting_id = $1', [room])).rows)).length).toBe(1);
  });
  it('the heartbeat table is UNLOGGED', async () => {
    const [row] = await sys(async (tx) => (await tx.query<{ relpersistence: string }>("SELECT relpersistence FROM pg_class WHERE oid = 'app.meeting_presence'::regclass")).rows);
    expect(row?.relpersistence).toBe('u');
  });
});

describe('consent: transcription on or off, a person\'s answer, and words only from a yes', () => {
  let room = '';
  let channel = '';
  const words = (p: Persona, text = 'hello', speaker: Persona = p): Promise<unknown> =>
    as(p, (tx) => tx.query("INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source) VALUES ($1, $2, 0, 500, $3, 'device')", [room, speaker.actorId, text]));
  const stored = (): Promise<{ speaker_id: string; text: string }[]> =>
    sys(async (tx) => (await tx.query<{ speaker_id: string; text: string }>('SELECT speaker_id, text FROM app.meeting_segments WHERE meeting_id = $1', [room])).rows);
  const mode = (p: Persona, m: string): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.meetings_set_transcription($1, $2)', [room, m]));
  const answer = (p: Persona, a: string): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.meetings_set_consent($1, $2)', [room, a]));
  beforeAll(async () => {
    channel = await newChannel('meet-consent', false, []);
    room = await startRoom(nadia, channel);
    await join(nadia, room);
    await join(rafi, room);
  });

  it('takes no line while transcription is off', async () => {
    expect(await code(words(nadia))).toBe('23514');
  });
  it('is turned on by a person in the room, and not by one who is outside it; turning it on asks everybody again', async () => {
    expect(await code(mode(sameera, 'on_device'))).toBe('42501'); // not in the room
    expect(await code(mode(lena, 'on_device'))).toBe('42501');
    await answer(rafi, 'yes');
    await mode(rafi, 'on_device');
    const [row] = await sys(async (tx) => (await tx.query<{ transcription: string; transcription_by: string }>('SELECT transcription, transcription_by FROM app.meetings WHERE id = $1', [room])).rows);
    expect(row).toMatchObject({ transcription: 'on_device', transcription_by: rafi.actorId });
    const asked = await sys(async (tx) => (await tx.query<{ consent_transcribe: string }>('SELECT consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1', [room])).rows);
    expect(asked.every((r) => r.consent_transcribe === 'unasked')).toBe(true);
  });
  it('turns off for the person who turned it on or the starter, not for another person present, and cannot change mode while on', async () => {
    expect(await code(mode(nadia, 'server'))).toBe('23514');
    await join(priya, room);
    expect(await code(mode(priya, 'off'))).toBe('42501');
    await mode(nadia, 'off'); // the starter
    await mode(rafi, 'on_device');
    expect(await code(mode(priya, 'off'))).toBe('42501');
    await mode(rafi, 'off'); // the person who turned it on
    await mode(rafi, 'on_device');
  });
  it('stores the words of a yes and only the times of anyone else', async () => {
    await answer(nadia, 'yes');
    await words(nadia, 'on the record');
    await words(rafi, 'before answering'); // rafi was asked again and has not answered
    await answer(rafi, 'no');
    await words(rafi, 'after saying no');
    const rows = await stored();
    expect(rows.find((r) => r.speaker_id === nadia.actorId)?.text).toBe('on the record');
    expect(rows.filter((r) => r.speaker_id === rafi.actorId).map((r) => r.text)).toEqual(['', '']);
  });
  it('blanks the words already stored when a person answers no, and keeps the times', async () => {
    await answer(nadia, 'no');
    const rows = await stored();
    expect(rows.filter((r) => r.speaker_id === nadia.actorId).every((r) => r.text === '')).toBe(true);
    expect(rows.length).toBe(3);
  });
  it('lets a person answer only for themself, only while they are in the room, and only yes or no', async () => {
    expect(await code(answer(nadia, 'unasked'))).toBe('23514');
    expect(await code(answer(sameera, 'yes'))).toBe('42501');
    expect(await code(sys((tx) => tx.query("SELECT app.meetings_set_consent($1, 'yes')", [room])))).toBe('42501');
    // the table itself lets a person change their own row and nobody else's (the function above is what blanks words; the reader also judges by the current answer)
    const others = await as(nadia, (tx) => tx.query("UPDATE app.meeting_participants SET consent_transcribe = 'yes' WHERE meeting_id = $1 AND actor_id = $2", [room, rafi.actorId]));
    expect(others.rowCount).toBe(0);
  });
  it('turns off and then takes no more lines; the system role may still store lines (the server fallback)', async () => {
    await mode(nadia, 'off');
    expect(await code(words(nadia))).toBe('23514');
  });
});

describe('the workspace switch (meeting_settings)', () => {
  it('passes for the admin to write and everybody in the workspace to read, and the member cannot write', async () => {
    expect(await code(as(omar, (tx) => tx.query("INSERT INTO app.meeting_settings (workspace_id, transcribe_cap, updated_by) VALUES ($1, 'server', $2)", [omar.workspaceId, omar.actorId])))).toBeUndefined();
    expect((await q(nadia, 'SELECT transcribe_cap FROM app.meeting_settings'))[0]).toMatchObject({ transcribe_cap: 'server' });
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_settings SET transcribe_cap = 'off'")))).toBeUndefined(); // zero rows, no error: RLS hides the row from the write
    expect((await q(nadia, 'SELECT transcribe_cap FROM app.meeting_settings'))[0]).toMatchObject({ transcribe_cap: 'server' });
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.meeting_settings (workspace_id, transcribe_cap) VALUES ($1, 'off')", [nadia.workspaceId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.meeting_settings SET transcribe_cap = 'sideways'")))).toBe('23514');
    await as(omar, (tx) => tx.query("UPDATE app.meeting_settings SET transcribe_cap = 'off', updated_at = now()"));
    expect((await q(rafi, 'SELECT transcribe_cap FROM app.meeting_settings'))[0]).toMatchObject({ transcribe_cap: 'off' });
  });
});
