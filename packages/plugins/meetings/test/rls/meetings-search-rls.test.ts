import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import { MeetingsSearchOutput, SearchResponse } from '@manythreads/shared';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  meetingsMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  searchMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { search, searchMeetings } from '../../../search/src/service.ts';
import { searchMeetingLines } from '../../src/search.ts';

const { omar, nadia, rafi, sameera, lena, priya } = personas;

// P15-13 (pnpm test:rls): search over what was said in meetings and over their notes. `app.search_meetings` (search 0007) runs as the caller, so it finds exactly what the meetings
// tables show that caller, and the speaker's yes, the Personal-transcript rule and the filters can only narrow that.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

const newChannel = (name: string, isPrivate: boolean, members: Persona[], team: string | null = TEAM_IDS.Engineering): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [omar.workspaceId, team, name, 'channel', isPrivate, omar.actorId])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const startRoom = (p: Persona, channel: string, title: string): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, $3, $4, $4) RETURNING id', [p.workspaceId, channel, title, p.actorId])).rows[0]!.id);
const join = (p: Persona, room: string): Promise<unknown> => as(p, (tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [room, p.actorId]));
const consent = async (p: Persona, room: string, answer: 'yes' | 'no'): Promise<void> => {
  await as(p, (tx) => tx.query("SELECT app.meetings_set_transcription($1, 'on_device')", [room]));
  await as(p, (tx) => tx.query('SELECT app.meetings_set_consent($1, $2)', [room, answer]));
};
const say = (p: Persona, room: string, text: string, startMs = 1000): Promise<unknown> =>
  as(p, (tx) => tx.query("INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, source) VALUES ($1, $2, $3, $4, $5, 'device')", [room, p.actorId, startMs, startMs + 500, text]));
const notes = (room: string, organizer: Persona, location: 'repo' | 'channel_files' | 'personal', md: string, saved = false): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, notes_md, status, saved_at, saved_by, saved_path)
       VALUES ($1, $2, $3, $4, $5, 'written', ${saved ? 'now()' : 'NULL'}, ${saved ? '$3' : 'NULL'}, ${saved ? "'meetings/2026/11/x'" : 'NULL'})`,
      [room, omar.workspaceId, organizer.actorId, location, md],
    ),
  );

const found = (p: Persona, text: string, teamId: string | null = null) => as(p, (tx) => searchMeetings(tx, text, teamId, 20));
const titles = (hits: { title: string }[]): string[] => [...new Set(hits.map((h) => h.title))].sort();

let open = '';
let priv = '';
let roomOpen = '';
let roomPriv = '';
let roomPersonal = '';
let roomDecline = '';

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, repoGitMigrationSource, meetingsMigrationSource, searchMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  open = await newChannel('m-open', false, []);
  priv = await newChannel('m-private', true, [nadia, rafi]);

  // an open-channel call: Nadia and Rafi spoke (both said yes), with notes in the team's repo
  roomOpen = await startRoom(nadia, open, 'Release standup');
  await join(nadia, roomOpen);
  await join(rafi, roomOpen);
  await consent(nadia, roomOpen, 'yes');
  await consent(rafi, roomOpen, 'yes');
  await say(nadia, roomOpen, 'we will hold the canary rollout until quokkaplan lands', 4000);
  await say(rafi, roomOpen, 'agreed, the pagerduty rotation stays with zebraquartz', 9000);
  await say(nadia, roomOpen, `${'filler words about the weather and lunch '.repeat(12)}then the marmalade migration is scheduled for friday ${'and more filler words afterwards '.repeat(10)}`, 20_000);
  await notes(roomOpen, nadia, 'repo', '## Decisions\n\nHold the canary until the **quokkaplan** fix ships.\n');

  // a private-channel call, notes in the channel's Files
  roomPriv = await startRoom(nadia, priv, 'Leads sync');
  await join(nadia, roomPriv);
  await consent(nadia, roomPriv, 'yes');
  await say(nadia, roomPriv, 'the salary banding spreadsheet is called flamingoledger', 2000);
  await notes(roomPriv, nadia, 'channel_files', 'Private notes about flamingoledger and the reorg.');

  // a note-taker's meeting: its notes are in Nadia's Personal space, not saved
  roomPersonal = await startRoom(nadia, await newChannel('m-open-2', false, []), 'Planning with the note-taker');
  await join(nadia, roomPersonal);
  await join(rafi, roomPersonal);
  await consent(nadia, roomPersonal, 'yes');
  await consent(rafi, roomPersonal, 'yes');
  await say(rafi, roomPersonal, 'the pelicanbudget is two hundred', 3000);
  await notes(roomPersonal, nadia, 'personal', 'Personal notes: pelicanbudget is two hundred.');

  // a call where Priya declined and Rafi said yes and was then asked again
  roomDecline = await startRoom(nadia, await newChannel('m-open-3', false, []), 'Retro with a decliner');
  await join(nadia, roomDecline);
  await join(priya, roomDecline);
  await join(rafi, roomDecline);
  await consent(nadia, roomDecline, 'yes');
  await consent(rafi, roomDecline, 'yes');
  await consent(priya, roomDecline, 'no');
  await say(priya, roomDecline, 'toucanmarker should never be searchable', 1000);
  await say(rafi, roomDecline, 'ibismarker was said by somebody who then stopped consenting', 2000);
  await say(nadia, roomDecline, 'narwhalmarker was said by a person who said yes', 3000);
  await sys((tx) => tx.query("UPDATE app.meeting_participants SET consent_transcribe = 'unasked' WHERE meeting_id = $1 AND actor_id = $2", [roomDecline, rafi.actorId]));
}, 180_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('a line of an open-channel call', () => {
  it('is found by the people who may read the channel, with the speaker, the time and the room', async () => {
    for (const p of [nadia, rafi, priya]) {
      const hits = await found(p, 'quokkaplan');
      const line = hits.find((h) => h.where === 'transcript');
      expect(line, p.key).toMatchObject({ meetingId: roomOpen, title: 'Release standup', speakerName: 'Nadia', atMs: 4000 });
      expect(line?.channel?.id).toBe(open);
      expect(line?.snippet).toContain('quokkaplan');
    }
  });

  it('is found by a typo of the word, best match first', async () => {
    const hits = await found(rafi, 'zebraquarts');
    expect(hits[0]).toMatchObject({ meetingId: roomOpen, speakerName: 'Rafi', atMs: 9000 });
  });

  it('shows a few words around the match of a long line, not the whole line', async () => {
    const hits = await found(nadia, 'marmalade');
    const line = hits.find((h) => h.where === 'transcript')!;
    expect(line.snippet.length).toBeLessThanOrEqual(240);
    expect(line.snippet).toContain('marmalade');
  });

  it('is not found by a person with no access to that channel: another team, a guest', async () => {
    expect(await found(sameera, 'quokkaplan')).toEqual([]);
    expect(await found(lena, 'quokkaplan')).toEqual([]);
  });

  it('a text of under two characters finds nothing', async () => {
    expect(await found(nadia, 'q')).toEqual([]);
    expect(await found(nadia, '   ')).toEqual([]);
  });
});

describe('the notes of a meeting', () => {
  it('are found in the same search, marked as notes, with time 0', async () => {
    const hits = await found(priya, 'quokkaplan');
    expect(hits.map((h) => h.where).sort()).toEqual(['notes', 'transcript']);
    expect(hits.find((h) => h.where === 'notes')).toMatchObject({ meetingId: roomOpen, atMs: 0, speakerId: null, speakerName: null });
  });
});

describe('a private call', () => {
  it('is found by its members (line and notes) and by nobody else', async () => {
    const mine = await found(rafi, 'flamingoledger');
    expect(mine.map((h) => h.where).sort()).toEqual(['notes', 'transcript']);
    expect(titles(mine)).toEqual(['Leads sync']);
    expect(await found(priya, 'flamingoledger')).toEqual([]);
    expect(await found(sameera, 'flamingoledger')).toEqual([]);
    expect(await found(lena, 'flamingoledger')).toEqual([]);
  });

  it('is not found once a member is taken out of the channel', async () => {
    await sys((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [priv, rafi.personId]));
    expect(await found(rafi, 'flamingoledger')).toEqual([]);
    expect((await found(nadia, 'flamingoledger')).length).toBe(2);
    await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [priv, rafi.personId]));
  });
});

describe('who said yes', () => {
  it('a person who declined leaves no words to find; the person who said yes is found', async () => {
    expect(await found(nadia, 'toucanmarker')).toEqual([]);
    expect(await found(priya, 'toucanmarker')).toEqual([]);
    expect(titles(await found(priya, 'narwhalmarker'))).toEqual(['Retro with a decliner']);
  });

  it('a speaker whose answer is no longer yes is not found, even for a line stored while it was', async () => {
    const stored = await sys(async (tx) => (await tx.query<{ text: string }>('SELECT text FROM app.meeting_segments WHERE meeting_id = $1 AND speaker_id = $2', [roomDecline, rafi.actorId])).rows[0]!.text);
    expect(stored).toContain('ibismarker');
    expect(await found(nadia, 'ibismarker')).toEqual([]);
    expect(await found(rafi, 'ibismarker')).toEqual([]);
  });
});

describe('a note-taker meeting whose notes are in the organizer’s Personal space', () => {
  it('is found by the organizer, line and notes', async () => {
    const hits = await found(nadia, 'pelicanbudget');
    expect(hits.map((h) => h.where).sort()).toEqual(['notes', 'transcript']);
  });

  it('is not found by a person who spoke in it or by anybody who can read the channel', async () => {
    expect(await found(rafi, 'pelicanbudget')).toEqual([]);
    expect(await found(priya, 'pelicanbudget')).toEqual([]);
  });

  it('is found by the channel’s readers once the organizer saves it to the team', async () => {
    await sys((tx) => tx.query("UPDATE app.meeting_notes SET saved_at = now(), saved_by = organizer_id, saved_path = 'meetings/2026/11/plan' WHERE meeting_id = $1", [roomPersonal]));
    const hits = await found(rafi, 'pelicanbudget');
    // the line is the room's again; the notes row is still a Personal copy, which only its organizer's own reads (others read it through the notes route)
    expect(hits.map((h) => h.where)).toEqual(['transcript']);
    await sys((tx) => tx.query("UPDATE app.meeting_notes SET saved_at = NULL, saved_by = NULL, saved_path = NULL WHERE meeting_id = $1", [roomPersonal]));
  });

  it('a room with a note-taker and no notes row yet is the organizer’s alone', async () => {
    const room = await startRoom(nadia, await newChannel('m-open-4', false, []), 'Live with the note-taker');
    await join(nadia, room);
    await join(rafi, room);
    await consent(nadia, room, 'yes');
    await consent(rafi, room, 'yes');
    await say(rafi, room, 'gannetmarker is the live word', 1500);
    expect(titles(await found(priya, 'gannetmarker'))).toEqual(['Live with the note-taker']);
    // the note-taker is named through the room's own function, as the route does; the bot is an active bot of the team
    const bot = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
             VALUES ($1, $2, 'note-taker-s7', 'note-taker-s7', 'Takes notes', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
            [omar.workspaceId, TEAM_IDS.Engineering, 'b'.repeat(64)],
          )
        ).rows[0]!.id,
    );
    await as(nadia, (tx) => tx.query('SELECT app.meetings_set_notetaker($1, $2)', [room, bot]));
    // adding the note-taker asks everybody again; they say yes again
    for (const p of [nadia, rafi]) await as(p, (tx) => tx.query("SELECT app.meetings_set_consent($1, 'yes')", [room]));
    expect(await found(priya, 'gannetmarker')).toEqual([]);
    expect(titles(await found(nadia, 'gannetmarker'))).toEqual(['Live with the note-taker']);
  });
});

describe('filters only narrow', () => {
  it('a team that is not the meeting’s finds nothing; its own team finds it', async () => {
    expect(await found(nadia, 'quokkaplan', TEAM_IDS.Marketing)).toEqual([]);
    expect((await found(nadia, 'quokkaplan', TEAM_IDS.Engineering)).length).toBe(2);
  });

  it('from: keeps the lines the person spoke and leaves the notes out; in: keeps the channel', async () => {
    const byNadia = await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { from: [nadia.actorId] }));
    expect(byNadia.map((h) => h.where)).toEqual(['transcript']);
    expect(await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { from: [rafi.actorId] }))).toEqual([]);
    expect(await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { from: [] }))).toEqual([]);
    expect((await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { in: [open] }))).length).toBe(2);
    expect(await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { in: [priv] }))).toEqual([]);
  });

  it('after: and before: bound the meeting’s start', async () => {
    expect(await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { after: '2999-01-01T00:00:00Z' }))).toEqual([]);
    expect((await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 20, { before: '2999-01-01T00:00:00Z' }))).length).toBe(2);
  });

  it('the limit holds', async () => {
    const hits = await as(nadia, (tx) => searchMeetings(tx, 'quokkaplan', null, 1));
    expect(hits.length).toBe(1);
  });
});

describe('GET /api/search, kind meetings', () => {
  it('the response carries the meetings list and says whether there was more', async () => {
    const res = SearchResponse.parse(await as(priya, (tx) => search(tx, { q: 'quokkaplan', scope: 'all', limit: 20 })));
    expect(res.meetings.map((h) => h.where).sort()).toEqual(['notes', 'transcript']);
    expect(res.more.meetings).toBe(false);
    const only = await as(priya, (tx) => search(tx, { q: 'quokkaplan', scope: 'meetings', limit: 20 }));
    expect(only.messages).toEqual([]);
    expect(only.meetings.length).toBe(2);
    const one = await as(priya, (tx) => search(tx, { q: 'quokkaplan', scope: 'meetings', limit: 1 }));
    expect(one.meetings.length).toBe(1);
    expect(one.more.meetings).toBe(true);
  });

  it('a private meeting’s line is not in Priya’s answer; is in a member’s', async () => {
    const hers = await as(priya, (tx) => search(tx, { q: 'flamingoledger', scope: 'all', limit: 20 }));
    expect(hers.meetings).toEqual([]);
    const theirs = await as(rafi, (tx) => search(tx, { q: 'flamingoledger', scope: 'all', limit: 20 }));
    expect(theirs.meetings.length).toBe(2);
  });

  it('has: and is: words leave meetings out, a box of only filter words finds none', async () => {
    expect((await as(nadia, (tx) => search(tx, { q: 'quokkaplan has:link', scope: 'all', limit: 20 }))).meetings).toEqual([]);
    expect((await as(nadia, (tx) => search(tx, { q: 'from:nadia', scope: 'all', limit: 20 }))).meetings).toEqual([]);
  });
});

describe('the meetings.search capability', () => {
  it('answers the hits a person’s own search gets, in the capability’s shape', async () => {
    const out = MeetingsSearchOutput.parse(await as(priya, (tx) => searchMeetingLines(tx, { query: 'quokkaplan', limit: 8 })));
    expect(out.hits.map((h) => h.where).sort()).toEqual(['notes', 'transcript']);
    const line = out.hits.find((h) => h.where === 'transcript')!;
    expect(line).toMatchObject({ meetingId: roomOpen, title: 'Release standup', teamId: TEAM_IDS.Engineering, channelId: open, atMs: 4000, speakerName: 'Nadia' });
    expect(line.snippet.length).toBeLessThanOrEqual(300);
  });

  it('answers nothing for what the asker may not read, and holds a run to a team', async () => {
    expect((await as(priya, (tx) => searchMeetingLines(tx, { query: 'flamingoledger', limit: 8 }))).hits).toEqual([]);
    expect((await as(priya, (tx) => searchMeetingLines(tx, { query: 'pelicanbudget', limit: 8 }))).hits).toEqual([]);
    expect((await as(nadia, (tx) => searchMeetingLines(tx, { query: 'quokkaplan', limit: 8, teamId: TEAM_IDS.Marketing }))).hits).toEqual([]);
  });
});
