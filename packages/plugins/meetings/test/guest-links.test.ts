import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { signFakeWebhook } from '@manythreads/sdk';
import {
  CallStartOptionsResponse,
  GUEST_LINK_GONE,
  GuestLinkPeekResponse,
  GuestSessionResponse,
  GuestTokenResponse,
  MEETING_LOBBY_PUSH,
  MakeGuestLinkResponse,
  MeetingLobbyResponse,
  MeetingSummary,
  StartMeetingResponse,
  ListCallCardsResponse,
} from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { guestsIn } from '../src/memory.ts';
import { loadPresent, recordableNow } from '../src/recording.ts';

// Guest links and the waiting room (P17-04; docs/plans/guest-links.md, docs/plugins/meetings.md "Guest links"), through the real routes with the fake media server
// and a clock the test moves (the address lock and the per-address counters read it; the database decides a knock's ten minutes by its own clock). Who may make
// links, the switch, a direct message; knock, wait, let in, token; turn away and take out, then refused; the cookie after each and after the end; an expired, used-up,
// turned-off and unknown link all the same 404; the waiting room's caps; the room size; the Origin check and the cookie's flags; the webhook; no session route
// answers the guest's cookie; recording and memory count an admitted guest.

const { omar, nadia, rafi, priya, lena } = personas;
const ORIGIN = 'http://localhost:3000';
const clock = { t: Date.now() };
let w: World;
let listen: pg.Client;
const pushed: Array<{ personId: string; type: string; payload: Record<string, unknown> }> = [];
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'] };

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter(), now: () => new Date(clock.t) });
  await ensureChannels(w);
  listen = new pg.Client({ connectionString: w.server.db.systemUrl });
  await listen.connect();
  listen.on('notification', (n) => {
    if (n.payload) pushed.push(JSON.parse(n.payload) as (typeof pushed)[number]);
  });
  await listen.query('LISTEN manythreads_realtime');
}, 180_000);
afterAll(async () => {
  await listen?.end().catch(() => undefined);
  await w?.close();
  if (saved.provider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = saved.provider;
});

/** Lets the address lock and the per-address counters pass (each test may refuse a few secrets on purpose). */
const rest = (): void => void (clock.t += 16 * 60_000);

type Who = typeof omar;
let counter = 0;
async function channel(opts: { private?: boolean } = {}): Promise<string> {
  const name = `guests-${String((counter += 1))}`;
  return w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          "INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) SELECT $1, t.id, $2, 'channel', $4, $3 FROM app.teams t WHERE t.slug = 'engineering' RETURNING id",
          [omar.workspaceId, name, omar.actorId, opts.private === true],
        )
      ).rows[0]!.id,
  );
}
/** A live call with guest links on, started by `starter` (who gets the first link), with `others` in it too. */
async function guestCall(starter: Who, others: Who[] = [], opts: { private?: boolean } = {}): Promise<{ meetingId: string; channelId: string; url: string; token: string }> {
  rest();
  const channelId = await channel(opts);
  if (opts.private) for (const p of [starter, ...others]) await w.system((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, p.personId]));
  const res = await w.call(starter, 'POST', `/api/channels/${channelId}/meetings`, { title: 'Design review', allowGuests: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const started = StartMeetingResponse.parse(res.body);
  expect(started.meeting.allowGuests).toBe(true);
  expect(started.guestLink).not.toBeNull();
  for (const p of others) expect((await w.call(p, 'POST', `/api/meetings/${started.meeting.id}/join`)).status).toBe(200);
  const url = started.guestLink!.url;
  return { meetingId: started.meeting.id, channelId, url, token: url.slice(url.lastIndexOf('/') + 1) };
}

type Raw = { status: number; body: unknown; headers: Headers };
async function raw(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null; actor?: Who } = {}): Promise<Raw> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.origin !== null) headers['origin'] = opts.origin ?? ORIGIN;
  if (opts.actor) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: opts.actor.actorId, workspaceId: opts.actor.workspaceId });
  const res = await fetch(`${w.server.url}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, headers: res.headers };
}
const peek = (token: string) => raw('POST', '/api/guest-links/peek', { body: { token } });
/** Knocks with a name; returns the answer and the cookie the server set (`mt_guest=<id>.<secret>`). */
async function knock(token: string, name = 'Ana', opts: { origin?: string | null } = {}): Promise<Raw & { cookie: string; guestId: string }> {
  const res = await raw('POST', '/api/guest-links/knock', { body: { token, displayName: name }, ...(opts.origin !== undefined ? { origin: opts.origin } : {}) });
  const set = res.headers.get('set-cookie') ?? '';
  const cookie = set.split(';')[0] ?? '';
  return { ...res, cookie, guestId: cookie.replace(/^mt_guest=/, '').split('.')[0] ?? '' };
}
const session = (cookie: string) => raw('GET', '/api/guest/session', { cookie, origin: null });
const token = (cookie: string) => raw('POST', '/api/guest/token', { cookie });
const decide = (who: Who, meetingId: string, guestId: string, d: 'admit' | 'deny' | 'remove') => w.call(who, 'POST', `/api/meetings/${meetingId}/guests/${guestId}/${d}`);
const stateOf = async (cookie: string) => GuestSessionResponse.parse((await session(cookie)).body).state;
const eventsFor = (type: string, meetingId: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = $1 AND payload->>'meetingId' = $2 ORDER BY id", [type, meetingId])).rows.map((r) => r.payload));

describe('making links', () => {
  it('the start dialog offers the switch; a start with it on returns the first link once, and a peek shows the title and the workspace only', async () => {
    const ch = await channel();
    const options = CallStartOptionsResponse.parse((await w.call(nadia, 'GET', `/api/channels/${ch}/calls/options`)).body);
    expect(options.guestLinks).toEqual({ available: true, reason: null });
    const { meetingId, url, token: t } = await guestCall(nadia);
    expect(url).toMatch(/^http:\/\/localhost:3000\/join\/g\/[A-Za-z0-9_-]{43}$/);
    const p = await peek(t);
    expect(p.status).toBe(200);
    expect(p.headers.get('cache-control')).toBe('no-store');
    const body = GuestLinkPeekResponse.parse(p.body);
    expect(body).toMatchObject({ state: 'open', title: 'Design review', kind: 'audio', transcribing: false, notetaker: false });
    // the channel, the people and their ids are never in the answer
    expect(JSON.stringify(p.body)).not.toMatch(/guests-\d|Nadia|engineering|[0-9a-f]{8}-[0-9a-f]{4}-/);
    // only the hash is kept
    const stored = await w.system(async (tx) => (await tx.query<{ hash: Buffer }>('SELECT token_hash AS hash FROM app.meeting_guest_links WHERE meeting_id = $1', [meetingId])).rows);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hash.toString('base64url')).not.toBe(t);
    const created = await eventsFor('meetings.guest_link.created', meetingId);
    expect(created).toEqual([expect.objectContaining({ createdBy: nadia.actorId })]);
    expect(JSON.stringify(created)).not.toContain(t);
  });

  it('any reader who may post makes a link of their own; a call without links on, a direct message and the switch off refuse', async () => {
    const { meetingId } = await guestCall(nadia, [rafi]);
    const mine = await w.call(rafi, 'POST', `/api/meetings/${meetingId}/guest-links`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(MakeGuestLinkResponse.parse(mine.body).url).toContain('/join/g/');
    // a call started without the switch makes no link, not even for its starter afterwards
    const plain = StartMeetingResponse.parse((await w.call(nadia, 'POST', `/api/channels/${await channel()}/meetings`, { title: 'Plain' })).body);
    expect(plain.guestLink).toBeNull();
    expect((await w.call(nadia, 'POST', `/api/meetings/${plain.meeting.id}/guest-links`)).status).toBe(409);
    // a direct message: the start with the switch is refused whole
    const dm = await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect(dm.status, JSON.stringify(dm.body)).toBeLessThan(300);
    const dmId = (dm.body as { dm: { channel: { id: string } } }).dm.channel.id;
    {
      const refused = await w.call(nadia, 'POST', `/api/channels/${dmId}/meetings`, { allowGuests: true });
      expect(refused.status).toBe(409);
      const dmOptions = CallStartOptionsResponse.parse((await w.call(nadia, 'GET', `/api/channels/${dmId}/calls/options`)).body);
      expect(dmOptions.guestLinks.available).toBe(false);
    }
    // the workspace switch
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { guestLinksAllowed: false })).status).toBe(200);
    try {
      expect((await w.call(rafi, 'POST', `/api/meetings/${meetingId}/guest-links`)).status).toBe(409);
      const ch = await channel();
      expect(CallStartOptionsResponse.parse((await w.call(nadia, 'GET', `/api/channels/${ch}/calls/options`)).body).guestLinks.available).toBe(false);
      expect((await w.call(nadia, 'POST', `/api/channels/${ch}/meetings`, { allowGuests: true })).status).toBe(409);
    } finally {
      expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { guestLinksAllowed: true })).status).toBe(200);
    }
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('a title the server wrote names the channel: a guest sees it without the channel', async () => {
    rest();
    const ch = await channel();
    const started = StartMeetingResponse.parse((await w.call(nadia, 'POST', `/api/channels/${ch}/meetings`, { allowGuests: true })).body);
    expect(started.meeting.title).toMatch(/^Call · #guests-\d+ · \d\d:\d\d$/);
    const t = started.guestLink!.url.slice(started.guestLink!.url.lastIndexOf('/') + 1);
    const p = GuestLinkPeekResponse.parse((await peek(t)).body);
    expect(p.title).toMatch(/^Call · \d\d:\d\d$/);
    const k = await knock(t, 'Ana');
    expect(GuestSessionResponse.parse((await session(k.cookie)).body).title).toBe(p.title);
    await w.call(nadia, 'POST', `/api/meetings/${started.meeting.id}/end`);
  });

  it('a private channel has links too (its readers make them)', async () => {
    const { meetingId, token: t } = await guestCall(nadia, [], { private: true });
    expect((await peek(t)).status).toBe(200);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('the waiting room', () => {
  it('a knock needs the site\'s Origin; it sets a cookie for /api/guest only and waits; the people in the call see the name, nobody else does', async () => {
    const { meetingId, token: t } = await guestCall(nadia, [rafi]);
    expect((await knock(t, 'Ana', { origin: null })).status).toBe(403);
    expect((await knock(t, 'Ana', { origin: 'https://evil.example' })).status).toBe(403);
    const k = await knock(t, '  Ana‮  ');
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    const set = k.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^mt_guest=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; /);
    expect(set).toContain('Path=/api/guest;');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).not.toContain('Secure'); // the test site is plain http; an https site adds it
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)?.[1]);
    expect(maxAge).toBeGreaterThan(11 * 3600);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);
    expect(await stateOf(k.cookie)).toBe('waiting');
    const lobby = MeetingLobbyResponse.parse((await w.call(rafi, 'GET', `/api/meetings/${meetingId}/lobby`)).body);
    expect(lobby.waiting.map((g) => g.displayName)).toEqual(['Ana']);
    // a reader of the channel who is not in the call is not told who knocks
    expect((await w.call(priya, 'GET', `/api/meetings/${meetingId}/lobby`)).status).toBe(403);
    const lobbyPushes = await eventually(async () => {
      const got = pushed.filter((p) => p.type === MEETING_LOBBY_PUSH && p.payload['meetingId'] === meetingId);
      return got.length >= 2 ? got : undefined;
    }, 5_000, 'the lobby push');
    expect(new Set(lobbyPushes.map((p) => p.personId))).toEqual(new Set([nadia.personId, rafi.personId]));
    // the credential is stored as a hash; the event carries ids only
    const asked = await eventsFor('meetings.guest.asked', meetingId);
    expect(asked).toEqual([expect.objectContaining({ guestId: k.guestId })]);
    expect(JSON.stringify(asked)).not.toContain('Ana');
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('let in: a token for the one room, microphone and camera only, ten minutes; the room shows "(guest)"; recording pauses and memory is held', async () => {
    const { meetingId, token: t } = await guestCall(nadia, [rafi]);
    const k = await knock(t, 'Ana');
    expect((await token(k.cookie)).status).toBe(403);
    const admitted = await decide(rafi, meetingId, k.guestId, 'admit');
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    // whoever answers first wins
    expect((await decide(nadia, meetingId, k.guestId, 'admit')).status).toBe(409);
    expect(await stateOf(k.cookie)).toBe('admitted');
    const tok = await token(k.cookie);
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const body = GuestTokenResponse.parse(tok.body);
    expect(body.join.identity).toBe(`guest:${k.guestId}`);
    expect(body.join.roomName).toBe(meetingId);
    expect(Date.parse(body.join.expiresAt) - clock.t).toBeLessThanOrEqual(600_000);
    expect(body.people.map((p) => p.displayName).sort()).toEqual(['Ana (guest)', 'Nadia', 'Rafi'].sort());
    expect(JSON.stringify(body.people)).not.toMatch(/@|avatar/);
    const minted = lastFakeMedia().tokens.filter((x) => x.identity === `guest:${k.guestId}`);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ kind: 'guest', room: meetingId, displayName: 'Ana (guest)', grants: { canPublish: true, canSubscribe: true, sources: ['microphone', 'camera'] } });
    expect(minted[0]!.grants.listenOnly).toBeUndefined();
    expect(lastFakeMedia().decode(body.join.token)).toMatchObject({ identity: `guest:${k.guestId}`, room: meetingId, canPublish: true, listenOnly: false, sources: ['microphone', 'camera'] });
    // the members' page names the guest
    const summary = MeetingSummary.parse((await w.call(rafi, 'GET', `/api/meetings/${meetingId}`)).body);
    expect(summary.guests).toEqual([{ id: k.guestId, identity: `guest:${k.guestId}`, displayName: 'Ana' }]);
    const cards = ListCallCardsResponse.parse((await w.call(priya, 'GET', `/api/meetings/cards?ids=${meetingId}`)).body);
    expect(cards.cards[0]!.guests).toMatchObject({ on: true, inCall: 1 });
    // recording: an admitted guest is present with no yes, so nobody is recorded; memory: the call is held for a lead
    const present = await w.system((tx) => loadPresent(tx, meetingId));
    expect(present.find((p) => p.actorId === `guest:${k.guestId}`)).toMatchObject({ name: 'Ana (guest)', yes: false });
    expect(recordableNow(true, present.map((p) => ({ ...p, yes: p.actorId.startsWith('guest:') ? false : true })))).toEqual([]);
    const m = await w.system(async (tx) => (await tx.query<{ id: string; team_id: string; workspace_id: string }>('SELECT id, team_id, workspace_id FROM app.meetings WHERE id = $1', [meetingId])).rows[0]!);
    expect(await w.system((tx) => guestsIn(tx, m))).toContain('Ana (guest)');
    expect((await eventsFor('meetings.guest.admitted', meetingId)).map((e) => e['decidedBy'])).toEqual([rafi.actorId]);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('turned away or taken out: the cookie gets no token, and taking out drops the media identity', async () => {
    const { meetingId, token: t } = await guestCall(nadia, [rafi]);
    const a = await knock(t, 'Ana');
    const b = await knock(t, 'Ben');
    expect((await decide(rafi, meetingId, a.guestId, 'deny')).status).toBe(200);
    expect((await decide(nadia, meetingId, a.guestId, 'deny')).status).toBe(409);
    expect(await stateOf(a.cookie)).toBe('denied');
    expect((await token(a.cookie)).status).toBe(403);
    expect((await decide(nadia, meetingId, b.guestId, 'admit')).status).toBe(200);
    expect((await token(b.cookie)).status).toBe(200);
    expect((await decide(rafi, meetingId, b.guestId, 'remove')).status).toBe(200);
    expect(lastFakeMedia().kicked).toContainEqual({ room: meetingId, identity: `guest:${b.guestId}` });
    expect(await stateOf(b.cookie)).toBe('removed');
    expect((await token(b.cookie)).status).toBe(403);
    expect((await raw('POST', '/api/guest/heartbeat', { cookie: b.cookie })).status).toBe(409);
    // someone not in the call decides nothing
    const c = await knock(t, 'Cleo');
    expect((await decide(priya, meetingId, c.guestId, 'admit')).status).toBe(403);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('the end of the call: guests gone, links off, the cookie says ended and gets no token', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const a = await knock(t, 'Ana');
    const b = await knock(t, 'Ben');
    expect((await decide(nadia, meetingId, a.guestId, 'admit')).status).toBe(200);
    expect((await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`)).status).toBe(200);
    expect(await stateOf(a.cookie)).toBe('ended');
    expect(await stateOf(b.cookie)).toBe('ended');
    expect((await token(a.cookie)).status).toBe(409);
    expect((await peek(t)).status).toBe(404);
    const left = await eventsFor('meetings.guest.left', meetingId);
    expect(left.map((e) => [e['guestId'], e['how']])).toEqual(expect.arrayContaining([[a.guestId, 'ended'], [b.guestId, 'expired']]));
    expect((await eventsFor('meetings.guest_link.revoked', meetingId))[0]).toMatchObject({ reason: 'ended', revokedBy: null });
  });

  it('a knock nobody answered in ten minutes lapses', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const a = await knock(t, 'Ana');
    await w.system((tx) => tx.query("UPDATE app.meeting_guests SET asked_at = now() - interval '11 minutes' WHERE id = $1", [a.guestId]));
    expect(await stateOf(a.cookie)).toBe('expired');
    expect((await decide(nadia, meetingId, a.guestId, 'admit')).status).toBe(409);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('dead links all look the same', () => {
  it('unknown, malformed, expired, used up and turned off answer the same 404 to a peek and to a knock', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const unknown = 'A'.repeat(43);
    const answers = [await peek(unknown), await peek('short'), await knock(unknown)];
    // used up
    await w.system((tx) => tx.query('UPDATE app.meeting_guest_links SET max_uses = 1, uses = 1 WHERE meeting_id = $1', [meetingId]));
    answers.push(await peek(t), await knock(t));
    // expired
    await w.system((tx) => tx.query("UPDATE app.meeting_guest_links SET max_uses = 50, uses = 0, created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' WHERE meeting_id = $1", [meetingId]));
    answers.push(await peek(t));
    // turned off by the starter (a reader who is not starter, lead or admin may not)
    await w.system((tx) => tx.query("UPDATE app.meeting_guest_links SET created_at = now(), expires_at = now() + interval '1 hour' WHERE meeting_id = $1", [meetingId]));
    expect((await peek(t)).status).toBe(200);
    expect((await w.call(rafi, 'DELETE', `/api/meetings/${meetingId}/guest-links`)).status).toBe(403);
    const off = await w.call(nadia, 'DELETE', `/api/meetings/${meetingId}/guest-links`);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toEqual({ revoked: 1 });
    answers.push(await peek(t), await knock(t));
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect((a.body as { error: { message: string } }).error.message).toBe(GUEST_LINK_GONE);
    }
    // turning links off keeps the call's switch off: no new link either
    expect((await w.call(nadia, 'POST', `/api/meetings/${meetingId}/guest-links`)).status).toBe(409);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('the secret travels in a body only: the old address shapes are not routes, and no answer, event or audit row repeats it', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    expect((await raw('GET', `/api/guest-links/${t}`, { origin: null })).status).toBe(404);
    expect((await raw('POST', `/api/guest-links/${t}/knock`, { body: { displayName: 'Ana' } })).status).toBe(404);
    const k = await knock(t, 'Ana');
    const answers = [await peek(t), k, await peek('A'.repeat(43))];
    for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(t);
    const rows = await w.system(async (tx) => ({
      events: (await tx.query<{ payload: unknown }>("SELECT payload FROM app.events WHERE payload->>'meetingId' = $1", [meetingId])).rows,
      audit: (await tx.query<{ r: unknown }>("SELECT to_jsonb(a) AS r FROM app.audit_events a WHERE to_jsonb(a)::text LIKE '%' || $1 || '%'", [meetingId])).rows,
    }));
    expect(JSON.stringify(rows)).not.toContain(t);
    expect(JSON.stringify(rows)).not.toContain(k.cookie.split('.')[1]!);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('refused secrets from one address lock it out for 15 minutes; a wrong-shaped one is not counted', async () => {
    rest();
    for (let i = 0; i < 5; i++) expect((await peek('short')).status).toBe(404);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await peek(`${'B'.repeat(42)}${String.fromCharCode(65 + i)}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
    // a forged cookie counts the same way: the lock already holds
    expect((await session(`mt_guest=00000000-0000-7000-8000-000000000001.${'C'.repeat(43)}`)).status).toBe(429);
    rest();
    expect((await session(`mt_guest=00000000-0000-7000-8000-000000000001.${'C'.repeat(43)}`)).status).toBe(401);
    expect((await session('mt_guest=nonsense')).status).toBe(401);
    expect((await session('')).status).toBe(401);
  });
});

describe('caps', () => {
  it('at most 3 knocks from one address per call, 10 waiting per call, and a full room refuses a guest', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const mine = [];
    for (let i = 0; i < 3; i++) {
      const k = await knock(t, `G${i}`);
      expect(k.status).toBe(201);
      mine.push(k.guestId);
    }
    // three waiting from one address: the next waits until one of them is answered
    const fourth = await knock(t, 'G3');
    expect(fourth.status).toBe(429);
    expect((fourth.body as { error: { message: string } }).error.message).toContain('waiting to join this call from your network');
    expect((await decide(nadia, meetingId, mine[0]!, 'deny')).status).toBe(200);
    // the refused knock used up nothing: one answered, so one more may wait
    expect((await knock(t, 'G3')).status).toBe(201);
    expect((await knock(t, 'G4')).status).toBe(429);
    expect((await decide(nadia, meetingId, mine[1]!, 'deny')).status).toBe(200);
    rest();
    // seven more waiting (made as the system) fill the waiting room to 10 (two of this address are still waiting)
    await w.system(async (tx) => {
      const link = (await tx.query<{ id: string; channel_id: string; team_id: string; workspace_id: string }>('SELECT id, channel_id, team_id, workspace_id FROM app.meeting_guest_links WHERE meeting_id = $1', [meetingId])).rows[0]!;
      for (let i = 0; i < 8; i++) {
        await tx.query(
          "INSERT INTO app.meeting_guests (link_id, meeting_id, channel_id, team_id, workspace_id, display_name, credential_hash) VALUES ($1, $2::uuid, $3, $4, $5, $6::text, sha256(convert_to($6::text || $2::uuid::text, 'UTF8')))",
          [link.id, meetingId, link.channel_id, link.team_id, link.workspace_id, `W${i}`],
        );
      }
    });
    const full = await knock(t, 'Late');
    expect(full.status).toBe(429);
    expect((full.body as { error: { message: string } }).error.message).toContain('waiting room of this call is full');
    expect(Number(full.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // a knock the database refused counts nothing against the address: with room again, this address may still wait once more
    const lobbyNow = MeetingLobbyResponse.parse((await w.call(nadia, 'GET', `/api/meetings/${meetingId}/lobby`)).body).waiting;
    expect(lobbyNow).toHaveLength(10);
    expect((await decide(nadia, meetingId, lobbyNow.find((g) => g.displayName === 'W0')!.id, 'deny')).status).toBe(200);
    expect((await knock(t, 'Late')).status).toBe(201);
    // the room size counts a guest let in like a person
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { roomCap: 2 })).status).toBe(200);
    try {
      const waiting = MeetingLobbyResponse.parse((await w.call(nadia, 'GET', `/api/meetings/${meetingId}/lobby`)).body).waiting;
      expect((await decide(nadia, meetingId, waiting[0]!.id, 'admit')).status).toBe(200);
      const second = await decide(nadia, meetingId, waiting[1]!.id, 'admit');
      expect(second.status).toBe(409);
      expect((second.body as { error: { message: string } }).error.message).toBe('The call is full');
      expect((await w.call(rafi, 'POST', `/api/meetings/${meetingId}/join`)).status).toBe(409);
    } finally {
      expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { roomCap: 25 })).status).toBe(200);
    }
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('who is told of a knock', () => {
  it('a workspace guest in the call sees neither the waiting room nor its push, and may not decide', async () => {
    const { meetingId, channelId, token: t } = await guestCall(nadia);
    await w.system((tx) =>
      tx.query("INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING", [
        lena.workspaceId,
        channelId,
        lena.personId,
      ]),
    );
    const joined = await w.call(lena, 'POST', `/api/meetings/${meetingId}/join`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const before = pushed.length;
    const k = await knock(t, 'Ana');
    await eventually(async () => (pushed.slice(before).some((p) => p.type === MEETING_LOBBY_PUSH && p.personId === nadia.personId) ? true : undefined), 5_000, 'the push to Nadia');
    expect(pushed.slice(before).filter((p) => p.type === MEETING_LOBBY_PUSH && p.personId === lena.personId)).toEqual([]);
    expect((await w.call(lena, 'GET', `/api/meetings/${meetingId}/lobby`)).status).toBe(403);
    expect((await decide(lena, meetingId, k.guestId, 'admit')).status).toBe(403);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('the sweep', () => {
  const sweep = () => w.system((tx) => tx.query("INSERT INTO app.jobs (queue, payload, run_at) VALUES ('meetings.sweep', '{}'::jsonb, now())"));
  const back = (guestId: string, interval: string) =>
    w.system(async (tx) => {
      await tx.query(`UPDATE app.meeting_guest_presence SET seen_at = now() - interval '${interval}' WHERE guest_id = $1`, [guestId]);
      await tx.query(`UPDATE app.meeting_guests SET asked_at = least(asked_at, now() - interval '${interval}'), decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE now() - interval '${interval}' END WHERE id = $1`, [guestId]);
    });
  const dbState = (id: string) => w.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.meeting_guests WHERE id = $1', [id])).rows[0]!.state);

  it('a hidden tab is not a gone guest: a waiting page silent two minutes still waits, one silent four minutes is expired, and the call is told', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const quiet = await knock(t, 'Ana');
    const gone = await knock(t, 'Ben');
    await back(quiet.guestId, '2 minutes');
    await back(gone.guestId, '4 minutes');
    const before = pushed.length;
    await sweep();
    await eventually(async () => ((await dbState(gone.guestId)) === 'expired' ? true : undefined), 15_000, 'the sweep to expire the silent knock');
    expect(await dbState(quiet.guestId)).toBe('waiting');
    await eventually(async () => (pushed.slice(before).some((p) => p.type === MEETING_LOBBY_PUSH && p.payload['meetingId'] === meetingId) ? true : undefined), 5_000, 'the lobby push of the sweep');
    expect((await eventsFor('meetings.guest.left', meetingId)).map((e) => [e['guestId'], e['how']])).toEqual([[gone.guestId, 'expired']]);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('a guest in the call silent three minutes is dropped from the media room and the room is told', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const k = await knock(t, 'Ana');
    expect((await decide(nadia, meetingId, k.guestId, 'admit')).status).toBe(200);
    await back(k.guestId, '4 minutes');
    const before = pushed.length;
    await sweep();
    await eventually(async () => ((await dbState(k.guestId)) === 'left' ? true : undefined), 15_000, 'the sweep to drop the silent guest');
    expect(lastFakeMedia().kicked).toContainEqual({ room: meetingId, identity: `guest:${k.guestId}` });
    await eventually(async () => (pushed.slice(before).some((p) => p.type === 'meeting.changed' && p.payload['meetingId'] === meetingId) ? true : undefined), 5_000, 'the room push of the sweep');
    expect((await eventsFor('meetings.guest.left', meetingId)).map((e) => e['how'])).toEqual(['dropped']);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('a guest reaches one call and nothing else', () => {
  it('no session route answers the guest\'s cookie', async () => {
    const { meetingId, channelId, token: t } = await guestCall(nadia);
    const k = await knock(t, 'Ana');
    expect((await decide(nadia, meetingId, k.guestId, 'admit')).status).toBe(200);
    for (const path of [`/api/channels/${channelId}/messages`, `/api/meetings/${meetingId}`, `/api/meetings/${meetingId}/lobby`, '/api/teams/engineering/channels', '/api/dms']) {
      const res = await raw('GET', path, { cookie: k.cookie, origin: null });
      expect(res.status, path).toBe(401);
    }
    expect((await raw('POST', `/api/meetings/${meetingId}/guests/${k.guestId}/admit`, { cookie: k.cookie })).status).toBe(401);
    expect((await raw('POST', `/api/meetings/${meetingId}/guest-links`, { cookie: k.cookie })).status).toBe(401);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('the webhook drops a guest identity that was not let in; one let in may drop and come back with the same cookie', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const a = await knock(t, 'Ana');
    const b = await knock(t, 'Ben');
    expect((await decide(nadia, meetingId, b.guestId, 'admit')).status).toBe(200);
    const send = (body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      return fetch(`${w.server.url}/api/meetings/media-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': signFakeWebhook(text) }, body: text });
    };
    expect((await send({ id: 'g1', kind: 'participant_joined', room: meetingId, identity: `guest:${a.guestId}` })).status).toBe(200);
    expect(lastFakeMedia().kicked).toContainEqual({ room: meetingId, identity: `guest:${a.guestId}` });
    const kicks = lastFakeMedia().kicked.length;
    expect((await send({ id: 'g2', kind: 'participant_joined', room: meetingId, identity: `guest:${b.guestId}` })).status).toBe(200);
    expect(lastFakeMedia().kicked.length).toBe(kicks);
    // a reload or a lost connection: the media server says the guest left, and the guest is still let in, gets a new token and is not dropped when they return
    expect((await send({ id: 'g3', kind: 'participant_left', room: meetingId, identity: `guest:${b.guestId}` })).status).toBe(200);
    expect(await stateOf(b.cookie)).toBe('admitted');
    expect((await token(b.cookie)).status).toBe(200);
    const kicks2 = lastFakeMedia().kicked.length;
    expect((await send({ id: 'g4', kind: 'participant_joined', room: meetingId, identity: `guest:${b.guestId}` })).status).toBe(200);
    expect(lastFakeMedia().kicked.length).toBe(kicks2);
    expect(await eventsFor('meetings.guest.left', meetingId)).toEqual([]);
    // a guest never keeps a call alive and is never a participant
    expect((await w.system((tx) => tx.query('SELECT 1 FROM app.meeting_participants WHERE actor_id::text LIKE $1', ['%guest%']))).rows).toEqual([]);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('leaving clears the cookie and tells the people in the call', async () => {
    const { meetingId, token: t } = await guestCall(nadia);
    const a = await knock(t, 'Ana');
    const out = await raw('POST', '/api/guest/leave', { cookie: a.cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await stateOf(a.cookie)).toBe('left');
    expect(MeetingLobbyResponse.parse((await w.call(nadia, 'GET', `/api/meetings/${meetingId}/lobby`)).body).waiting).toEqual([]);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

// ---- step 2: a guest's own transcription, and the list of links with Turn off for each ------------------------------------------------------------------------
describe('a guest says yes or no to "Transcribe my voice?"', () => {
  const consent = (cookie: string, transcribe: 'yes' | 'no', origin?: string | null) => raw('POST', '/api/guest/consent', { cookie, body: { transcribe }, ...(origin !== undefined ? { origin } : {}) });
  const say = (cookie: string, segments: Array<{ clientSegId: string; startMs: number; endMs: number; text: string; final: boolean }>) => raw('POST', '/api/guest/segments', { cookie, body: { segments } });
  const line = (id: string, text: string, startMs = 1000, final = true) => ({ clientSegId: id, startMs, endMs: startMs + 900, text, final });
  const transcribeRoom = (who: Who, meetingId: string, mode: 'on_device' | 'off') => w.call(who, 'PUT', `/api/meetings/${meetingId}/transcription`, { mode });
  async function admittedGuest(name = 'Ana'): Promise<{ meetingId: string; cookie: string; guestId: string }> {
    const { meetingId, token: t } = await guestCall(nadia, [rafi]);
    const k = await knock(t, name);
    expect((await decide(rafi, meetingId, k.guestId, 'admit')).status).toBe(200);
    return { meetingId, cookie: k.cookie, guestId: k.guestId };
  }

  it('the session tells a guest let in about transcription and the call clock; a waiting guest is told nothing', async () => {
    const { meetingId, token: t } = await guestCall(nadia, [rafi]);
    const k = await knock(t, 'Ana');
    expect(GuestSessionResponse.parse((await session(k.cookie)).body)).toMatchObject({ state: 'waiting', transcription: 'off', consent: 'unasked', startedAt: null, serverNow: null });
    expect((await transcribeRoom(nadia, meetingId, 'on_device')).status).toBe(200);
    expect(GuestSessionResponse.parse((await session(k.cookie)).body).transcription).toBe('off');
    await decide(rafi, meetingId, k.guestId, 'admit');
    const s = GuestSessionResponse.parse((await session(k.cookie)).body);
    expect(s).toMatchObject({ state: 'admitted', transcription: 'on_device', turnedOnBy: 'Nadia', consent: 'unasked' });
    expect(s.startedAt).not.toBeNull();
    expect(s.serverNow).not.toBeNull();
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('yes: the device\'s lines are stored with the guest and read "Ana (guest)"; a line sent twice is stored once; captions name the guest', async () => {
    const { meetingId, cookie, guestId } = await admittedGuest('Ana');
    // not transcribed yet: no answer is taken, no line
    expect((await consent(cookie, 'yes')).status).toBe(409);
    expect((await say(cookie, [line('a1', 'hello')])).status).toBe(409);
    expect((await transcribeRoom(nadia, meetingId, 'on_device')).status).toBe(200);
    // asked, not answered: no line
    expect((await say(cookie, [line('a1', 'hello')])).status).toBe(409);
    // the Origin check holds here too
    expect((await consent(cookie, 'yes', null)).status).toBe(403);
    const yes = await consent(cookie, 'yes');
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(yes.body).toEqual({ consent: 'yes' });
    const before = pushed.length;
    const sent = await say(cookie, [line('a1', 'Shipping on Friday works for us'), line('a2', 'still typ', 2500, false)]);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ stored: 1, captioned: 1, blanked: false });
    expect((await say(cookie, [line('a1', 'Shipping on Friday works for us')])).body).toMatchObject({ stored: 0, duplicates: 1 });
    const rows = await w.system(
      async (tx) => (await tx.query<{ speaker_id: string | null; guest_id: string; text: string; source: string }>('SELECT speaker_id, guest_id, text, source FROM app.meeting_segments WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(rows).toEqual([{ speaker_id: null, guest_id: guestId, text: 'Shipping on Friday works for us', source: 'device' }]);
    const tr = (await w.call(priya, 'GET', `/api/meetings/${meetingId}/transcript`)).body as { lines: Array<Record<string, unknown>> };
    expect(tr.lines).toEqual([expect.objectContaining({ speakerName: 'Ana (guest)', guestId, text: 'Shipping on Friday works for us', transcribed: true, editable: false })]);
    await eventually(async () => pushed.slice(before).some((p) => p.type === 'meeting.caption' && JSON.stringify(p.payload).includes('Ana (guest)')), 10_000, 'a caption that names the guest');
    const answered = await eventsFor('meetings.guest.answered', meetingId);
    expect(answered.map((e) => e['value'])).toEqual(['yes']);
    expect(JSON.stringify(answered)).not.toContain('Ana');
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('no: the stored words go, the line says "Ana (guest) spoke (not transcribed)", and nothing more is taken', async () => {
    const { meetingId, cookie, guestId } = await admittedGuest('Ana');
    await transcribeRoom(nadia, meetingId, 'on_device');
    await consent(cookie, 'yes');
    await say(cookie, [line('b1', 'a secret plan')]);
    expect((await consent(cookie, 'no')).body).toEqual({ consent: 'no' });
    expect((await say(cookie, [line('b2', 'more words')])).status).toBe(409);
    const texts = await w.system(async (tx) => (await tx.query<{ text: string }>('SELECT text FROM app.meeting_segments WHERE guest_id = $1', [guestId])).rows.map((r) => r.text));
    expect(texts).toEqual(['']);
    const tr = (await w.call(nadia, 'GET', `/api/meetings/${meetingId}/transcript`)).body as { lines: Array<Record<string, unknown>> };
    expect(tr.lines).toEqual([expect.objectContaining({ speakerName: 'Ana (guest)', text: 'Ana (guest) spoke (not transcribed)', transcribed: false })]);
    expect(JSON.stringify(tr)).not.toContain('secret plan');
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('turning transcription on again asks the guest again; recording still counts a guest as no; a guest taken out is refused', async () => {
    const { meetingId, cookie, guestId } = await admittedGuest('Ana');
    await transcribeRoom(nadia, meetingId, 'on_device');
    await consent(cookie, 'yes');
    expect((await transcribeRoom(nadia, meetingId, 'off')).status).toBe(200);
    expect((await say(cookie, [line('c1', 'off now')])).status).toBe(409);
    await transcribeRoom(nadia, meetingId, 'on_device');
    expect(GuestSessionResponse.parse((await session(cookie)).body).consent).toBe('unasked');
    await consent(cookie, 'yes');
    const people = await w.system((tx) => loadPresent(tx, meetingId));
    expect(people.find((p) => p.actorId === `guest:${guestId}`)).toMatchObject({ stored: 'no', yes: false });
    expect((await decide(rafi, meetingId, guestId, 'remove')).status).toBe(200);
    expect((await consent(cookie, 'yes')).status).toBe(403);
    expect((await say(cookie, [line('c2', 'gone')])).status).toBe(403);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });

  it('the database blanks the words of a guest who has not said yes, and a line names exactly one speaker', async () => {
    const { meetingId, guestId } = await admittedGuest('Ana');
    await transcribeRoom(nadia, meetingId, 'on_device');
    await w.system((tx) => tx.query("INSERT INTO app.meeting_segments (meeting_id, guest_id, start_ms, end_ms, text, source) VALUES ($1, $2, 0, 10, 'unasked words', 'device')", [meetingId, guestId]));
    expect(await w.system(async (tx) => (await tx.query<{ text: string }>('SELECT text FROM app.meeting_segments WHERE guest_id = $1', [guestId])).rows)).toEqual([{ text: '' }]);
    await expect(
      w.system((tx) => tx.query("INSERT INTO app.meeting_segments (meeting_id, speaker_id, guest_id, start_ms, end_ms, text, source) VALUES ($1, $2, $3, 0, 10, 'x', 'device')", [meetingId, nadia.actorId, guestId])),
    ).rejects.toThrow();
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});

describe('"Guest links (n)": the links that still work, and turning off one', () => {
  it('the starter sees the links with who made them, the card counts them; turning one off leaves the others and the switch on', async () => {
    const { meetingId, token: first } = await guestCall(nadia, [rafi]);
    const second = MakeGuestLinkResponse.parse((await w.call(rafi, 'POST', `/api/meetings/${meetingId}/guest-links`)).body);
    const secondToken = second.url.slice(second.url.lastIndexOf('/') + 1);
    // a reader who is not the starter, a lead or an admin sees no list and turns nothing off
    expect((await w.call(rafi, 'GET', `/api/meetings/${meetingId}/guest-links`)).status).toBe(403);
    const list = await w.call(nadia, 'GET', `/api/meetings/${meetingId}/guest-links`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const links = (list.body as { links: Array<{ id: string; createdByName: string; uses: number; maxUses: number }> }).links;
    expect(links.map((l) => [l.createdByName, l.uses, l.maxUses])).toEqual([
      ['Nadia', 0, 50],
      ['Rafi', 0, 50],
    ]);
    expect(JSON.stringify(list.body)).not.toContain(first);
    const cardOf = async (who: Who) => ListCallCardsResponse.parse((await w.call(who, 'GET', `/api/meetings/cards?ids=${meetingId}`)).body).cards[0]!.guests;
    expect((await cardOf(nadia)).links).toBe(2);
    expect((await cardOf(rafi)).links).toBe(0);
    const rafiLink = links.find((l) => l.createdByName === 'Rafi')!.id;
    expect((await w.call(rafi, 'DELETE', `/api/meetings/${meetingId}/guest-links/${rafiLink}`)).status).toBe(403);
    const off = await w.call(nadia, 'DELETE', `/api/meetings/${meetingId}/guest-links/${rafiLink}`);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toEqual({ revoked: true });
    // once more: it had already stopped
    expect((await w.call(nadia, 'DELETE', `/api/meetings/${meetingId}/guest-links/${rafiLink}`)).body).toEqual({ revoked: false });
    expect((await peek(secondToken)).status).toBe(404);
    expect((await peek(first)).status).toBe(200);
    expect((await cardOf(nadia)).links).toBe(1);
    expect((await eventsFor('meetings.guest_link.revoked', meetingId)).filter((e) => e['reason'] === 'person')).toEqual([expect.objectContaining({ linkIds: [rafiLink], revokedBy: nadia.actorId })]);
    // a link of another call is not found there
    const other = await guestCall(nadia);
    expect((await w.call(nadia, 'DELETE', `/api/meetings/${other.meetingId}/guest-links/${rafiLink}`)).status).toBe(404);
    await w.call(nadia, 'POST', `/api/meetings/${other.meetingId}/end`);
    await w.call(nadia, 'POST', `/api/meetings/${meetingId}/end`);
  });
});
