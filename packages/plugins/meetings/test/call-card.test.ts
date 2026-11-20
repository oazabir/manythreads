import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { ListCallCardsResponse, ListMessagesResponse, StartMeetingResponse } from '@manythreads/shared';
import { relaxedRateLimiter, testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// The call card (P15-26, docs/plugins/meetings.md "The call card"): a new call posts one start message stamped with `meta.meeting`, never linked or notified, and the same
// message stays the card through join and end; video is refused before anything is written; a start whose card cannot be written fails whole and leaves no media room; and
// `GET /api/meetings/cards` answers only the calls the caller can read, with the notes link only for a reader of the notes once they are written.

const { omar, nadia, rafi, sameera } = personas;

let w: World;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  // many starts in a minute: the start limit is proven in meetings-api.test.ts (MISTAKES P15-21)
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

let counter = 0;
/** A fresh channel of Engineering (open, or private with the given members), so every test has its own one live call. */
const channel = (isPrivate = false, members: (typeof omar)[] = []): Promise<string> => {
  const name = `cc-${String((counter += 1))}`;
  return w.system(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        "INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) SELECT $1, t.id, $2, 'channel', $3, $4 FROM app.teams t WHERE t.slug = 'engineering' RETURNING id",
        [omar.workspaceId, name, isPrivate, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
};
const start = (who: typeof omar, channelId: string, body: unknown = {}) => w.call(who, 'POST', `/api/channels/${channelId}/meetings`, body);
const cards = async (who: typeof omar, ids: string[]) => {
  const res = await w.call(who, 'GET', `/api/meetings/cards?ids=${ids.join(',')}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListCallCardsResponse.parse(res.body).cards;
};
const stamped = (channelId: string) =>
  w.system(
    async (tx) =>
      (await tx.query<{ id: string; body: string; meta: Record<string, unknown> }>("SELECT id, body, meta FROM app.messages WHERE channel_id = $1 AND meta ? 'meeting' ORDER BY id", [channelId])).rows,
  );
const liveRooms = (channelId: string) =>
  w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.meetings WHERE channel_id = $1 AND state = 'live'", [channelId])).rows[0]!.n);
/** SQL as the database owner: a test-only trigger, switched on and off around one test. */
const owner = async (sql: string): Promise<void> => {
  const admin = testClient({ connectionString: w.server.db.ownerUrl });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
};

describe('starting a call posts its card', () => {
  it('one stamped top-level message, written once, that names and notifies nobody; the call thread is that message', async () => {
    const ch = await channel();
    const res = await start(nadia, ch, { title: 'Design review with @rafi' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const room = StartMeetingResponse.parse(res.body);
    expect(room.meeting.kind).toBe('audio');
    const rows = await stamped(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Started a call: Design review with @rafi');
    expect(rows[0]!.meta).toEqual({ meeting: { meetingId: room.meeting.id } });
    expect(room.meeting.threadRootId).toBe(rows[0]!.id);
    // skipRefs: the @name in the title is not a mention
    const mentions = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [rows[0]!.id])).rows.length);
    expect(mentions).toBe(0);
    // the shared message schema keeps the stamp, so the web sees it
    const msg = await w.call(rafi, 'GET', `/api/channels/${ch}/messages`);
    expect(msg.status).toBe(200);
    const list = ListMessagesResponse.parse(msg.body).items;
    expect(list.find((m) => m.id === rows[0]!.id)?.meta.meeting).toEqual({ meetingId: room.meeting.id });
    const started = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.meeting.started' AND payload->>'meetingId' = $1", [room.meeting.id])).rows);
    expect(started.map((e) => e.payload['kind'])).toEqual(['audio']);
  });

  it('is the same message after others join and after the call ends: nothing else is stamped and the text is never rewritten', async () => {
    const ch = await channel();
    const room = StartMeetingResponse.parse((await start(nadia, ch)).body);
    const before = await stamped(ch);
    expect(StartMeetingResponse.parse((await start(rafi, ch)).body).created).toBe(false);
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(200);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/end`)).status).toBe(200);
    expect(await stamped(ch)).toEqual(before);
  });

  it('refuses video with 409 and writes nothing', async () => {
    const ch = await channel();
    const roomsBefore = lastFakeMedia().rooms.size;
    const res = await start(nadia, ch, { kind: 'video', title: 'Face to face' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Video calls are not available yet');
    expect(await liveRooms(ch)).toBe(0);
    expect(await stamped(ch)).toEqual([]);
    expect(lastFakeMedia().rooms.size).toBe(roomsBefore);
    // the older page's body (title only) and an explicit audio both still start
    expect((await start(nadia, ch, { kind: 'audio' })).status).toBe(200);
  });

  it('a card that cannot be written fails the start with a plain reason and leaves no room, no event and no media room', async () => {
    const ch = await channel();
    await owner(`CREATE FUNCTION app.test_refuse_call_card() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$;
                 CREATE TRIGGER test_refuse_call_card BEFORE INSERT ON app.messages FOR EACH ROW WHEN (NEW.meta ? 'meeting') EXECUTE FUNCTION app.test_refuse_call_card();`);
    try {
      const roomsBefore = lastFakeMedia().rooms.size;
      const eventsBefore = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'meetings.meeting.started'")).rows[0]!.n);
      const res = await start(nadia, ch);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain('The call could not start');
      expect(await liveRooms(ch)).toBe(0);
      expect(lastFakeMedia().rooms.size).toBe(roomsBefore);
      const eventsAfter = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'meetings.meeting.started'")).rows[0]!.n);
      expect(eventsAfter).toBe(eventsBefore);
    } finally {
      await owner('DROP TRIGGER test_refuse_call_card ON app.messages; DROP FUNCTION app.test_refuse_call_card();');
    }
    expect((await start(nadia, ch)).status).toBe(200);
  });
});

describe('GET /api/meetings/cards', () => {
  it('answers the calls the caller can read, with who is in them and what the caller may do; a call they cannot read is left out', async () => {
    const open = await channel();
    const priv = await channel(true, [nadia, rafi]);
    const a = StartMeetingResponse.parse((await start(nadia, open, { title: 'Open call' })).body).meeting;
    const b = StartMeetingResponse.parse((await start(nadia, priv, { title: 'Private call' })).body).meeting;
    expect((await w.call(rafi, 'POST', `/api/meetings/${a.id}/join`)).status).toBe(200);

    const forNadia = await cards(nadia, [a.id, b.id]);
    expect(forNadia.map((c) => c.meetingId).sort()).toEqual([a.id, b.id].sort());
    const card = forNadia.find((c) => c.meetingId === a.id)!;
    expect(card).toMatchObject({
      kind: 'audio',
      title: 'Open call',
      state: 'live',
      startedBy: nadia.actorId,
      starterName: 'Nadia',
      endedAt: null,
      durationSeconds: null,
      presentCount: 2,
      joinedCount: 2,
      invited: { count: 0, names: [] },
      notetaker: null,
      you: { joined: true, canEnd: true, canInvite: true },
      notesLink: null,
    });
    expect(card.present.map((p) => p.displayName)).toEqual(['Nadia', 'Rafi']);

    // Omar (the lead) is not a member of the private channel: only the open call comes back; he may end it but is not in it
    const forOmar = await cards(omar, [a.id, b.id]);
    expect(forOmar.map((c) => c.meetingId)).toEqual([a.id]);
    expect(forOmar[0]!.you).toEqual({ joined: false, canEnd: true, canInvite: true });
    // Rafi is in the call but did not start it and is no lead
    expect((await cards(rafi, [a.id])).map((c) => c.you)).toEqual([{ joined: true, canEnd: false, canInvite: true }]);
    // another team reads neither
    expect(await cards(sameera, [a.id, b.id])).toEqual([]);
    // an id that is not a call is simply not there; a list that is not ids is refused
    expect(await cards(nadia, ['00000000-0000-7000-8000-00000000beef'])).toEqual([]);
    expect((await w.call(nadia, 'GET', '/api/meetings/cards?ids=nope')).status).toBe(400);
    expect((await w.call(nadia, 'GET', '/api/meetings/cards')).status).toBe(400);

    // ended: the length is known, nobody is present, the joined count stays, and nothing may be done
    expect((await w.call(nadia, 'POST', `/api/meetings/${a.id}/end`)).status).toBe(200);
    const ended = (await cards(rafi, [a.id]))[0]!;
    expect(ended).toMatchObject({ state: 'ended', presentCount: 0, present: [], joinedCount: 2, you: { joined: false, canEnd: false, canInvite: false } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('gives the notes link only to a reader of the notes, and only once they are written', async () => {
    const ch = await channel();
    const room = StartMeetingResponse.parse((await start(nadia, ch, { title: 'Notes call' })).body).meeting;
    expect((await w.call(rafi, 'POST', `/api/meetings/${room.id}/join`)).status).toBe(200);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.id}/end`)).status).toBe(200);
    const note = (location: string, status: string) =>
      w.system((tx) =>
        tx.query(
          `INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, status) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (meeting_id) DO UPDATE SET location = EXCLUDED.location, status = EXCLUDED.status`,
          [room.id, omar.workspaceId, nadia.actorId, location, status],
        ),
      );
    const link = `/t/engineering/meetings/${room.id}`;
    // not written yet: nobody gets a link
    await note('repo', 'pending');
    expect((await cards(rafi, [room.id]))[0]!.notesLink).toBeNull();
    // written for the team: every reader of the channel
    await note('repo', 'written');
    expect((await cards(rafi, [room.id]))[0]!.notesLink).toBe(link);
    expect((await cards(omar, [room.id]))[0]!.notesLink).toBe(link);
    // the organizer's Personal copy (a note-taker's): the organizer reads it, Rafi still sees the card but gets no link
    await note('personal', 'written');
    expect((await cards(nadia, [room.id]))[0]!.notesLink).toBe(link);
    const forRafi = (await cards(rafi, [room.id]))[0]!;
    expect(forRafi.meetingId).toBe(room.id);
    expect(forRafi.notesLink).toBeNull();
  });
});
