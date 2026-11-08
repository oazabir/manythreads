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

// Bundle C tables and functions (pnpm test:rls, migration 0003): late lines, line corrections, the note-taker, recording, the notes, shares and the recordings table.

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
  pub = await newChannel('c-open', false, []);
  priv = await newChannel('c-private', true, [nadia, rafi]);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const set = (p: Persona, sqlText: string, values: unknown[]): Promise<unknown> => as(p, (tx) => tx.query(sqlText, values));
const turnOn = async (p: Persona, room: string): Promise<void> => {
  await set(p, "SELECT app.meetings_set_transcription($1, 'on_device')", [room]);
  await set(p, "SELECT app.meetings_set_consent($1, 'yes')", [room]);
};

describe('the new tables pass the RLS harness', () => {
  it('forced RLS, a rls: comment, policies for every command', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

// A room's end time cannot be moved by the app or the system role (the guard trigger), so the test moves it as the database owner with the guard switched off for that statement.
const backdateEnd = async (room: string, seconds: number): Promise<void> => {
  const owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE app.meetings DISABLE TRIGGER meetings_guard');
    await owner.query("UPDATE app.meetings SET ended_at = now() - make_interval(secs => $2) WHERE id = $1", [room, seconds]);
    await owner.query('ALTER TABLE app.meetings ENABLE TRIGGER meetings_guard');
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
};

describe('lines after Leave, and a repeated line', () => {
  let room = '';
  const line = (p: Persona, id: string): Promise<unknown> =>
    set(p, "INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source, client_seg_id) VALUES ($1, $2, 0, 500, 'hello', 'device', $3)", [room, p.actorId, id]);
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('c-late', false, []));
    await join(nadia, room);
    await turnOn(nadia, room);
  });
  it('the same client line id from the same speaker is stored once (a retry is a duplicate)', async () => {
    await line(nadia, 'a1');
    expect(await code(line(nadia, 'a1'))).toBe('23505');
    await line(nadia, 'a2');
  });
  it('a person who left less than two minutes ago still adds a line; after that, and for a ended room after the window, it is refused', async () => {
    await set(nadia, 'UPDATE app.meeting_participants SET left_at = now() - interval \'60 seconds\' WHERE meeting_id = $1', [room]);
    await line(nadia, 'late-1');
    await set(nadia, 'UPDATE app.meeting_participants SET left_at = now() - interval \'300 seconds\' WHERE meeting_id = $1', [room]);
    expect(await code(line(nadia, 'late-2'))).toBe('42501');
  });
  it('a room that ended a minute ago takes a late line; one that ended five minutes ago does not', async () => {
    await set(nadia, 'UPDATE app.meeting_participants SET left_at = NULL WHERE meeting_id = $1', [room]);
    await sys((tx) => tx.query("SELECT app.meetings_end($1, 'person')", [room]));
    await sys((tx) => tx.query('UPDATE app.meeting_participants SET left_at = now() - interval \'30 seconds\' WHERE meeting_id = $1', [room]));
    await backdateEnd(room, 60);
    await line(nadia, 'ended-1');
    await backdateEnd(room, 300);
    expect(await code(line(nadia, 'ended-2'))).toBe('23514');
  });
});

describe('correcting your own line', () => {
  let room = '';
  let own = '';
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('c-fix', false, []));
    await join(nadia, room);
    await join(rafi, room);
    await turnOn(nadia, room);
    await set(rafi, "SELECT app.meetings_set_consent($1, 'no')", [room]);
    own = (await as(nadia, async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source) VALUES ($1, $2, 0, 500, 'helo', 'device') RETURNING id", [room, nadia.actorId])).rows[0]!)).id;
  });
  const fix = async (p: Persona, id: string, text: string): Promise<boolean> => (await q<{ ok: boolean }>(p, 'SELECT app.meetings_correct_segment($1, $2) AS ok', [id, text]))[0]!.ok;
  it('the speaker corrects the words and the line is marked edited; another person cannot', async () => {
    expect(await fix(rafi, own, 'hijack')).toBe(false);
    expect(await fix(nadia, own, 'hello')).toBe(true);
    const [row] = await sys(async (tx) => (await tx.query<{ text: string; edited_at: Date | null }>('SELECT text, edited_at FROM app.meeting_segments WHERE id = $1', [own])).rows);
    expect(row?.text).toBe('hello');
    expect(row?.edited_at).not.toBeNull();
  });
  it('a line is not corrected after 24 hours, with empty words, or once the speaker no longer says yes', async () => {
    expect(await code(as(nadia, (tx) => tx.query("SELECT app.meetings_correct_segment($1, '  ')", [own])))).toBe('23514');
    await sys((tx) => tx.query("UPDATE app.meeting_segments SET created_at = now() - interval '25 hours' WHERE id = $1", [own]));
    expect(await code(as(nadia, (tx) => tx.query("SELECT app.meetings_correct_segment($1, 'late')", [own])))).toBe('23514');
    await sys((tx) => tx.query("UPDATE app.meeting_segments SET created_at = now() WHERE id = $1", [own]));
    await set(nadia, "SELECT app.meetings_set_consent($1, 'no')", [room]);
    expect(await fix(nadia, own, 'never')).toBe(false);
  });
});

describe('the note-taker', () => {
  let room = '';
  let bot = '';
  let foreignBot = '';
  const newBot = (slug: string, team: string | null, status = 'active'): Promise<string> =>
    sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
           VALUES ($1, $2, $3, $3, 'Takes notes', 'agent', 'hermes', 'team', $4, $5, '{"runner": "default"}') RETURNING id`,
          [omar.workspaceId, team, slug, 'b'.repeat(64), status],
        )
      ).rows[0]!.id,
    );
  const add = (p: Persona, botId: string | null): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.meetings_set_notetaker($1, $2)', [room, botId]));
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('c-taker', false, []));
    await join(nadia, room);
    bot = await newBot('note-bot', TEAM_IDS.Engineering);
    foreignBot = await newBot('other-bot', TEAM_IDS.Engineering, 'disabled');
  });
  it('someone outside the room, and an inactive bot, cannot be added; a person in the room adds an active bot of the team', async () => {
    expect(await code(add(rafi, bot))).toBe('42501');
    expect(await code(add(nadia, foreignBot))).toBe('23514');
    await add(nadia, bot);
    const [row] = await sys(async (tx) => (await tx.query<{ notetaker_bot_id: string; notetaker_by: string; transcription: string }>('SELECT notetaker_bot_id, notetaker_by, transcription FROM app.meetings WHERE id = $1', [room])).rows);
    expect(row).toMatchObject({ notetaker_bot_id: bot, notetaker_by: nadia.actorId, transcription: 'server' });
  });
  it('asks everybody present again, and a room has one note-taker', async () => {
    const [p] = await sys(async (tx) => (await tx.query<{ consent_transcribe: string }>('SELECT consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1', [room])).rows);
    expect(p?.consent_transcribe).toBe('unasked');
    const other = await newBot('second-bot', TEAM_IDS.Engineering);
    expect(await code(add(nadia, other))).toBe('23514');
  });
  it('is removed by the person who added it or a lead, not by another member', async () => {
    await join(rafi, room);
    expect(await code(add(rafi, null))).toBe('42501');
    await add(nadia, null);
    expect((await sys(async (tx) => (await tx.query<{ notetaker_bot_id: string | null }>('SELECT notetaker_bot_id FROM app.meetings WHERE id = $1', [room])).rows))[0]?.notetaker_bot_id).toBeNull();
  });
});

describe('recording', () => {
  let room = '';
  const rec = (p: Persona, on: boolean): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.meetings_set_recording($1, $2)', [room, on]));
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('c-rec', false, []));
    await join(nadia, room);
    await join(rafi, room);
  });
  it('is refused while the workspace switch is off, and for a person outside the room', async () => {
    expect(await code(rec(nadia, true))).toBe('23514');
    await as(omar, (tx) => tx.query("INSERT INTO app.meeting_settings (workspace_id, recording_cap, updated_by) VALUES ($1, 'on', $2) ON CONFLICT (workspace_id) DO UPDATE SET recording_cap = 'on'", [omar.workspaceId, omar.actorId]));
    expect(await code(rec(sameera, true))).toBe('42501');
    await rec(nadia, true);
    expect((await sys(async (tx) => (await tx.query<{ recording: boolean; recording_by: string }>('SELECT recording, recording_by FROM app.meetings WHERE id = $1', [room])).rows))[0]).toMatchObject({ recording: true, recording_by: nadia.actorId });
  });
  it('is turned off by the person who turned it on, a lead or the starter; not by another member', async () => {
    expect(await code(rec(rafi, false))).toBe('42501');
    await rec(nadia, false);
    expect((await sys(async (tx) => (await tx.query<{ recording: boolean }>('SELECT recording FROM app.meetings WHERE id = $1', [room])).rows))[0]?.recording).toBe(false);
  });
});

describe('notes and who reads them', () => {
  let room = '';
  let privRoom = '';
  let personal = '';
  const note = (meeting: string, location: string): Promise<unknown> =>
    sys((tx) => tx.query("INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, status, notes_md) VALUES ($1, $2, $3, $4, 'written', 'notes') ", [meeting, omar.workspaceId, omar.actorId, location]));
  const canRead = async (p: Persona, meeting: string): Promise<boolean> => (await q<{ ok: boolean }>(p, 'SELECT app.meetings_can_read_notes($1) AS ok', [meeting]))[0]!.ok;
  beforeAll(async () => {
    room = await startRoom(nadia, pub);
    privRoom = await startRoom(nadia, priv);
    personal = await startRoom(nadia, await newChannel('c-personal', false, []));
    await note(room, 'repo');
    await note(privRoom, 'channel_files');
    await note(personal, 'personal');
  });
  it('only the system role writes notes; the organizer fills the organizer from the room, not from the caller', async () => {
    expect(await code(set(nadia, "INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location) VALUES ($1, $2, $3, 'repo')", [room, nadia.workspaceId, nadia.actorId]))).toBe('42501');
    expect((await sys(async (tx) => (await tx.query<{ organizer_id: string; team_id: string }>('SELECT organizer_id, team_id FROM app.meeting_notes WHERE meeting_id = $1', [room])).rows))[0]).toMatchObject({ organizer_id: nadia.actorId, team_id: TEAM_IDS.Engineering });
    expect(await code(set(nadia, "UPDATE app.meeting_notes SET notes_md = 'x'", []))).toBe('42501');
    expect((await sys(async (tx) => (await tx.query<{ notes_md: string }>('SELECT notes_md FROM app.meeting_notes WHERE meeting_id = $1', [room])).rows))[0]?.notes_md).toBe('notes');
  });
  it('notes of an open channel are read by the team, not by other teams or guests', async () => {
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1', [room])).length).toBe(1);
    for (const outsider of [sameera, lena]) {
      expect((await q(outsider, 'SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1', [room])).length, outsider.key).toBe(0);
      expect(await canRead(outsider, room), outsider.key).toBe(false);
    }
    expect(await canRead(rafi, room)).toBe(true);
  });
  it('notes of a private channel are read by its members only, an admin who is not a member included', async () => {
    expect(await canRead(rafi, privRoom)).toBe(true);
    for (const outsider of [omar, sameera, lena]) {
      expect((await q(outsider, 'SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1', [privRoom])).length, outsider.key).toBe(0);
      expect(await canRead(outsider, privRoom), outsider.key).toBe(false);
    }
  });
  it('a Personal copy is the organizer\'s alone, until it is saved to the team', async () => {
    expect((await q(nadia, 'SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1', [personal])).length).toBe(1);
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1', [personal])).length).toBe(0);
    expect(await canRead(rafi, personal)).toBe(false);
    await sys((tx) => tx.query("UPDATE app.meeting_notes SET saved_at = now(), saved_by = $2, saved_path = 'meetings/2026/11/03-1000-x' WHERE meeting_id = $1", [personal, nadia.actorId]));
    expect(await canRead(rafi, personal)).toBe(true);
    expect(await canRead(sameera, personal)).toBe(false);
  });
  it('a saved path and a saved time come together', async () => {
    expect(await code(sys((tx) => tx.query("UPDATE app.meeting_notes SET saved_at = NULL WHERE meeting_id = $1", [personal])))).toBe('23514');
  });
});

describe('shares', () => {
  let room = '';
  let shareChannel = '';
  const share = (p: Persona, meeting: string, kind: 'person' | 'channel', target: string): Promise<unknown> =>
    set(
      p,
      kind === 'person'
        ? "INSERT INTO app.meeting_shares (meeting_id, grantee_kind, grantee_person_id, created_by) VALUES ($1, 'person', $2, $3)"
        : "INSERT INTO app.meeting_shares (meeting_id, grantee_kind, grantee_channel_id, created_by) VALUES ($1, 'channel', $2, $3)",
      [meeting, target, p.actorId],
    );
  beforeAll(async () => {
    room = await startRoom(nadia, await newChannel('c-share', false, []));
    shareChannel = await newChannel('c-share-target', true, [priya]);
    await sys((tx) => tx.query("INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, status) VALUES ($1, $2, $3, 'personal', 'written')", [room, omar.workspaceId, nadia.actorId]));
  });
  it('only the organizer shares; the grantee and the organizer see the grant, nobody else', async () => {
    expect(await code(share(rafi, room, 'person', priya.personId))).toBe('42501');
    await share(nadia, room, 'person', priya.personId);
    expect((await q(nadia, 'SELECT 1 FROM app.meeting_shares WHERE meeting_id = $1', [room])).length).toBe(1);
    expect((await q(priya, 'SELECT 1 FROM app.meeting_shares WHERE meeting_id = $1', [room])).length).toBe(1);
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_shares WHERE meeting_id = $1', [room])).length).toBe(0);
  });
  it('the same person twice is a duplicate; a person of another workspace is refused', async () => {
    expect(await code(share(nadia, room, 'person', priya.personId))).toBe('23505');
    expect(await code(share(nadia, room, 'person', '0190a000-0000-7000-8000-00000000dead'))).toBeDefined();
  });
  it('a share only ever moves from live to revoked, by the organizer', async () => {
    expect(await code(set(rafi, 'UPDATE app.meeting_shares SET revoked_at = now() WHERE meeting_id = $1', [room]))).toBeUndefined();
    expect((await q(nadia, 'SELECT 1 FROM app.meeting_shares WHERE meeting_id = $1 AND revoked_at IS NULL', [room])).length).toBe(1);
    expect(await code(set(nadia, "UPDATE app.meeting_shares SET grantee_kind = 'channel' WHERE meeting_id = $1", [room]))).toBe('42501');
    await set(nadia, 'UPDATE app.meeting_shares SET revoked_at = now() WHERE meeting_id = $1', [room]);
    expect(await code(set(nadia, 'UPDATE app.meeting_shares SET revoked_at = NULL WHERE meeting_id = $1', [room]))).toBe('23514');
    expect(await code(set(nadia, 'DELETE FROM app.meeting_shares WHERE meeting_id = $1', [room]))).toBe('42501');
  });
  it('a share to a person lets them read a Personal copy only while it is live and they still read the room\'s place; a channel share reaches that channel\'s readers', async () => {
    const readable = async (p: Persona): Promise<boolean> => (await q<{ ok: boolean }>(p, 'SELECT app.meetings_can_read_notes($1) AS ok', [room]))[0]!.ok;
    expect(await readable(priya)).toBe(false); // revoked above
    await share(nadia, room, 'channel', shareChannel);
    expect(await readable(priya)).toBe(true);
    expect(await readable(rafi)).toBe(false);
  });
});

describe('recordings', () => {
  it('are read by whoever reads the room and written by the system role only', async () => {
    const room = await startRoom(nadia, await newChannel('c-recfiles', true, [nadia, rafi]));
    expect(await code(set(nadia, 'INSERT INTO app.meeting_recordings (meeting_id, workspace_id, actor_id) VALUES ($1, $2, $3)', [room, nadia.workspaceId, nadia.actorId]))).toBe('42501');
    await sys((tx) => tx.query('INSERT INTO app.meeting_recordings (meeting_id, workspace_id, actor_id) VALUES ($1, $2, $3)', [room, omar.workspaceId, nadia.actorId]));
    expect((await q(rafi, 'SELECT 1 FROM app.meeting_recordings WHERE meeting_id = $1', [room])).length).toBe(1);
    for (const outsider of [omar, sameera, lena]) expect((await q(outsider, 'SELECT 1 FROM app.meeting_recordings WHERE meeting_id = $1', [room])).length, outsider.key).toBe(0);
    expect(await code(sys((tx) => tx.query("UPDATE app.meeting_recordings SET stopped_at = now() WHERE meeting_id = $1", [room])))).toBe('23514');
  });
});
