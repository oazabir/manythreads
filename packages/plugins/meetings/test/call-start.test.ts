import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { CallStartOptionsResponse, InviteToMeetingResponse, ListCallCardsResponse, OpenDmResponse, StartMeetingResponse } from '@manythreads/shared';
import { TEAM_IDS, relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { defaultTitle } from '../src/routes.ts';

// Starting a call from the dialog and asking people to it (P15-25, P15-27; docs/plugins/meetings.md "Starting a call and inviting people"): the start writes the call, its
// card, the invitations and the note-taker in one transaction and asks the media server last, so a refused start writes nothing at all; joining a call that is already
// live invites nobody; "Invite more" asks readers only; the dialog's options say what may be done; and the card names the people asked.

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let w: World;
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'], asr: process.env['MANYTHREADS_FAKE_ASR'] };
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
let notetaker = '';
let plainBot = '';

async function makeBot(slug: string, name: string, triggers: unknown[]): Promise<string> {
  return w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, triggers)
       VALUES ($1, $2, $3, $4, 'Takes notes', 'agent', 'hermes', 'team', $5, 'active', '{"runner": "default"}', $6::jsonb) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering, slug, name, 'a'.repeat(64), JSON.stringify(triggers)],
    );
    await tx.query("INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)", [omar.workspaceId, bot.rows[0]!.id]);
    return bot.rows[0]!.id;
  });
}

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  process.env['MANYTHREADS_FAKE_ASR'] = '1';
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { reconcileMs: 250, flushMs: 500 };
  // many starts in a minute: the start limit is proven in meetings-api.test.ts (MISTAKES P15-21)
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  notetaker = await makeBot('call-note-taker', 'Note-taker', [{ type: 'meeting' }]);
  plainBot = await makeBot('call-plain-bot', 'Plain bot', [{ type: 'mention' }]);
}, 180_000);
afterAll(async () => {
  await w?.close();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOOK];
  restore('MANYTHREADS_MEDIA_PROVIDER', saved.provider);
  restore('MANYTHREADS_FAKE_ASR', saved.asr);
});

let counter = 0;
/** A fresh channel of Engineering (open, or private with the given members), so every test has its own one live call. */
const channel = (isPrivate = false, members: (typeof omar)[] = []): Promise<string> => {
  const name = `cs-${String((counter += 1))}`;
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
const options = (who: typeof omar, channelId: string) => w.call(who, 'GET', `/api/channels/${channelId}/calls/options`);
const inviteMore = (who: typeof omar, meetingId: string, personIds: string[]) => w.call(who, 'POST', `/api/meetings/${meetingId}/invites`, { personIds });
const end = (who: typeof omar, meetingId: string) => w.call(who, 'POST', `/api/meetings/${meetingId}/end`);
const invitedOf = (meetingId: string) =>
  w.system(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.meeting_invites WHERE meeting_id = $1 ORDER BY person_id', [meetingId])).rows.map((r) => r.person_id));
const eventsFor = (type: string, meetingId: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = $1 AND payload->>'meetingId' = $2 ORDER BY id", [type, meetingId])).rows.map((r) => r.payload));
const countIn = (sql: string, args: unknown[]) => w.system(async (tx) => (await tx.query<{ n: number }>(sql, args)).rows[0]!.n);
const sorted = (ids: string[]): string[] => [...ids].sort();
const cards = async (who: typeof omar, ids: string[]) => {
  const res = await w.call(who, 'GET', `/api/meetings/cards?ids=${ids.join(',')}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListCallCardsResponse.parse(res.body).cards;
};
/** Nothing of a call in this channel: no meeting, no card, no invitation, no started event, and the media server was not asked. */
const nothingIn = async (channelId: string, roomsBefore: number): Promise<void> => {
  expect(await countIn('SELECT count(*)::int AS n FROM app.meetings WHERE channel_id = $1', [channelId])).toBe(0);
  expect(await countIn("SELECT count(*)::int AS n FROM app.messages WHERE channel_id = $1 AND meta ? 'meeting'", [channelId])).toBe(0);
  expect(await countIn('SELECT count(*)::int AS n FROM app.meeting_invites WHERE channel_id = $1', [channelId])).toBe(0);
  expect(await countIn("SELECT count(*)::int AS n FROM app.events WHERE type IN ('meetings.meeting.started', 'meetings.invite.sent') AND payload->>'channelId' = $1", [channelId])).toBe(0);
  expect(lastFakeMedia().rooms.size).toBe(roomsBefore);
};

describe('the default title', () => {
  it('names the channel and the time in a channel, and only the time elsewhere', () => {
    const at = new Date('2026-11-20T14:02:30Z');
    expect(defaultTitle(at, { kind: 'channel', name: 'dev' })).toBe('Call · #dev · 14:02');
    expect(defaultTitle(at, { kind: 'dm', name: '' })).toBe('Call · 14:02');
    expect(defaultTitle(at, null)).toBe('Call · 14:02');
  });
});

describe('starting a call with people and a note-taker', () => {
  it('writes the call, the invitations and the note-taker together, says who was asked, and asks nobody again', async () => {
    const ch = await channel();
    const res = await start(nadia, ch, { title: 'Design review', inviteeIds: [rafi.personId, omar.personId, nadia.personId], allowGuests: false, notetakerBotId: notetaker });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = StartMeetingResponse.parse(res.body);
    expect(body.created).toBe(true);
    expect(body.invited).toBe(2);
    expect(body.meeting.notetakerBotId).toBe(notetaker);
    expect(body.meeting.transcription).toBe('server');
    const m = body.meeting.id;
    // the starter is never invited
    expect(await invitedOf(m)).toEqual(sorted([rafi.personId, omar.personId]));
    const sent = await eventsFor('meetings.invite.sent', m);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ invitedBy: nadia.actorId, first: true, channelId: ch });
    expect(sorted(sent[0]!['personIds'] as string[])).toEqual(sorted([rafi.personId, omar.personId]));
    expect(await eventsFor('meetings.notetaker.added', m)).toHaveLength(1);
    // only the starter is in the room and was never asked: no "asked again"
    expect(await eventsFor('meetings.consent.changed', m)).toEqual([]);
    // the line in the call thread says the note-taker is there, not that everyone is asked again
    const said = await eventually(async () => {
      const rows = await w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE thread_root_id = $1 ORDER BY id', [body.meeting.threadRootId])).rows);
      return rows.length > 0 ? rows.map((r) => r.body) : undefined;
    });
    expect(said).toEqual(['Note-taker takes notes in this call. It listens on the server and writes notes for Nadia. Everyone is asked before their voice is written down.']);
    // the card names the people asked
    const [card] = await cards(rafi, [m]);
    // asked in one statement: in the order of their ids
    expect(card!.invited).toEqual({ count: 2, names: ['Omar', 'Rafi'] });
    expect(card!.notetaker?.name).toBe('Note-taker');
    expect((await end(nadia, m)).status).toBe(200);
  });

  it('a start with only a title still works and invites nobody; the title defaults to the channel and the time', async () => {
    const ch = await channel();
    const body = StartMeetingResponse.parse((await start(nadia, ch)).body);
    expect(body.invited).toBe(0);
    const name = await w.system(async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.channels WHERE id = $1', [ch])).rows[0]!.name);
    expect(body.meeting.title).toMatch(new RegExp(`^Call · #${name} · \\d\\d:\\d\\d$`));
    expect(await invitedOf(body.meeting.id)).toEqual([]);
    expect(await eventsFor('meetings.invite.sent', body.meeting.id)).toEqual([]);
    expect((await end(nadia, body.meeting.id)).status).toBe(200);
  });

  it('writes nothing when one person asked cannot read the channel (403), and nothing when the note-taker cannot come (409/403)', async () => {
    const priv = await channel(true, [nadia, rafi]);
    let rooms = lastFakeMedia().rooms.size;
    const refused = await start(nadia, priv, { inviteeIds: [rafi.personId, priya.personId] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('You cannot invite these people to this call.');
    expect(JSON.stringify(refused.body)).not.toContain('read this channel');
    await nothingIn(priv, rooms);

    // a bot that is not a note-taker: 409 with the reason, and the invitations of the same start are not kept either
    rooms = lastFakeMedia().rooms.size;
    const wrongBot = await start(nadia, priv, { inviteeIds: [rafi.personId], notetakerBotId: plainBot });
    expect(wrongBot.status, JSON.stringify(wrongBot.body)).toBe(409);
    expect(JSON.stringify(wrongBot.body)).toContain('This bot cannot be the note-taker');
    await nothingIn(priv, rooms);

    // note-takers switched off for the workspace: 403 with the switch's reason
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { notetakerAllowed: false })).status).toBe(200);
    try {
      rooms = lastFakeMedia().rooms.size;
      const off = await start(nadia, priv, { inviteeIds: [rafi.personId], notetakerBotId: notetaker });
      expect(off.status, JSON.stringify(off.body)).toBe(403);
      expect(JSON.stringify(off.body)).toContain('Note-takers are switched off for this workspace');
      await nothingIn(priv, rooms);
    } finally {
      expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { notetakerAllowed: true })).status).toBe(200);
    }
    // guest links are a boolean (P17-04, test/guest-links.test.ts has the rest)
    expect((await start(nadia, priv, { allowGuests: 'yes' })).status).toBe(400);
    // and the same start without the wrong parts opens
    const ok = await start(nadia, priv, { inviteeIds: [rafi.personId] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await end(nadia, StartMeetingResponse.parse(ok.body).meeting.id)).status).toBe(200);
  });

  it('joining a call that is already going invites nobody and adds no note-taker', async () => {
    const ch = await channel();
    const first = StartMeetingResponse.parse((await start(nadia, ch)).body);
    const second = await start(rafi, ch, { title: 'Another', inviteeIds: [omar.personId], notetakerBotId: notetaker });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const body = StartMeetingResponse.parse(second.body);
    expect(body).toMatchObject({ created: false, invited: 0 });
    expect(body.meeting.id).toBe(first.meeting.id);
    expect(body.meeting.notetakerBotId).toBeNull();
    expect(await invitedOf(first.meeting.id)).toEqual([]);
    expect(await eventsFor('meetings.invite.sent', first.meeting.id)).toEqual([]);
    expect((await end(nadia, first.meeting.id)).status).toBe(200);
  });

  it('a direct message rings everyone instead: the people named are not invited', async () => {
    const dmRes = await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect(dmRes.status, JSON.stringify(dmRes.body)).toBeLessThan(300);
    const dm = OpenDmResponse.parse(dmRes.body).dm.channel.id;
    const body = StartMeetingResponse.parse((await start(nadia, dm, { inviteeIds: [rafi.personId] })).body);
    expect(body.invited).toBe(0);
    expect(body.meeting.title).toMatch(/^Call · \d\d:\d\d$/);
    expect(await invitedOf(body.meeting.id)).toEqual([]);
    expect((await cards(rafi, [body.meeting.id]))[0]!.you.canInvite).toBe(false);
    const more = await inviteMore(nadia, body.meeting.id, [rafi.personId]);
    expect(more.status).toBe(409);
    expect((await end(nadia, body.meeting.id)).status).toBe(200);
  });
});

describe('POST /api/meetings/:meetingId/invites', () => {
  it('asks readers only, the whole list or nothing; leaves out the people asked before; says so with first: false', async () => {
    const priv = await channel(true, [nadia, rafi, priya]);
    const m = StartMeetingResponse.parse((await start(nadia, priv, { inviteeIds: [rafi.personId] })).body).meeting.id;
    // Priya reads the channel, Sameera does not: the whole list is refused
    const refused = await inviteMore(rafi, m, [priya.personId, sameera.personId]);
    expect(refused.status).toBe(403);
    expect(await invitedOf(m)).toEqual([rafi.personId]);
    // Rafi (asked, not the starter) asks Priya and himself: only Priya is new
    const ok = await inviteMore(rafi, m, [priya.personId, rafi.personId]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(InviteToMeetingResponse.parse(ok.body).invited).toEqual([priya.personId]);
    const again = InviteToMeetingResponse.parse((await inviteMore(nadia, m, [priya.personId])).body);
    expect(again.invited).toEqual([]);
    const sent = await eventsFor('meetings.invite.sent', m);
    expect(sent.map((e) => e['first'])).toEqual([true, false]);
    expect(sent[1]).toMatchObject({ invitedBy: rafi.actorId, personIds: [priya.personId] });
    // a stranger to the channel finds no call; someone who may not post cannot ask
    expect((await inviteMore(sameera, m, [rafi.personId])).status).toBe(404);
    expect((await inviteMore(omar, m, [rafi.personId])).status).toBe(404);
    // an empty list is not a request
    expect((await inviteMore(nadia, m, [])).status).toBe(400);
    // ended: nobody can be asked
    expect((await end(nadia, m)).status).toBe(200);
    expect((await inviteMore(nadia, m, [priya.personId])).status).toBe(409);
    expect((await cards(rafi, [m]))[0]!.invited).toEqual({ count: 2, names: ['Rafi', 'Priya'] });
  });
});

describe('GET /api/channels/:channelId/calls/options', () => {
  it('offers a member the readers (the caller first), the note-taker, the default title, and guest links', async () => {
    const priv = await channel(true, [nadia, rafi, priya]);
    const res = await options(nadia, priv);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = CallStartOptionsResponse.parse(res.body);
    expect(o).toMatchObject({ canStart: true, reason: null, directMessage: false, live: null, guestLinks: { available: true, reason: null } });
    expect(o.defaultTitle).toMatch(/^Call · #cs-\d+ · \d\d:\d\d$/);
    expect(o.people[0]).toEqual({ personId: nadia.personId, displayName: 'Nadia', you: true });
    expect(sorted(o.people.map((p) => p.personId))).toEqual(sorted([nadia.personId, rafi.personId, priya.personId]));
    expect(o.people.filter((p) => p.you)).toHaveLength(1);
    expect(o.notetaker).toMatchObject({ available: true, reason: null, defaultBotId: notetaker });
    expect(o.notetaker.bots.map((b) => b.name)).toEqual(['Note-taker']);
    expect(o.peopleTotal).toBe(3);

    // narrowed on the server by the start of a word of the name or of the handle (the e-mail address); the caller always stays first
    const narrowed = async (q: string) => CallStartOptionsResponse.parse((await w.call(nadia, 'GET', `/api/channels/${priv}/calls/options?q=${encodeURIComponent(q)}`)).body);
    const byName = await narrowed('Ra');
    expect(byName.people.map((p) => p.displayName)).toEqual(['Nadia', 'Rafi']);
    expect(byName.peopleTotal).toBe(2);
    expect((await narrowed(priya.email.slice(0, 3))).people.map((p) => p.displayName)).toEqual(['Nadia', 'Priya']);
    // LIKE signs are only letters here
    expect((await narrowed('%')).people.map((p) => p.displayName)).toEqual(['Nadia']);
    expect((await w.call(nadia, 'GET', `/api/channels/${priv}/calls/options?q=${'x'.repeat(81)}`)).status).toBe(400);

    // with a call going, the dialog is told which one
    const m = StartMeetingResponse.parse((await start(rafi, priv, { title: 'Going' })).body).meeting.id;
    expect(CallStartOptionsResponse.parse((await options(nadia, priv)).body).live).toEqual({ meetingId: m, title: 'Going' });
    expect((await end(rafi, m)).status).toBe(200);

    // note-takers off: still offered, with the reason
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { notetakerAllowed: false })).status).toBe(200);
    try {
      const off = CallStartOptionsResponse.parse((await options(nadia, priv)).body).notetaker;
      expect(off.available).toBe(false);
      expect(off.reason).toContain('Note-takers are switched off for this workspace');
    } finally {
      expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { notetakerAllowed: true })).status).toBe(200);
    }
  });

  it('a person who may not post, or a guest who may only read, gets canStart false with a reason and nobody listed', async () => {
    const priv = await channel(true, [nadia]);
    const stranger = CallStartOptionsResponse.parse((await options(sameera, priv)).body);
    expect(stranger).toMatchObject({ canStart: false, reason: 'You cannot start a call in this channel', people: [], peopleTotal: 0, live: null });
    const open = await channel();
    await w.system((tx) =>
      tx.query("INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')", [omar.workspaceId, open, lena.personId]),
    );
    const guest = await options(lena, open);
    expect(guest.status, JSON.stringify(guest.body)).toBe(200);
    expect(CallStartOptionsResponse.parse(guest.body)).toMatchObject({ canStart: false, reason: 'Guests cannot start a call here', people: [] });
    // and starting is refused the same way
    expect((await start(lena, open)).status).toBe(403);
  });
});
