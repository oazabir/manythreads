import { createHash, randomBytes } from 'node:crypto';
import {
  HttpError,
  conflict,
  createLockout,
  forbidden,
  guardRedemption,
  json,
  notFound,
  route,
  type HttpRequest,
  type HttpResponse,
  type MediaProvider,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  DecideGuestResponse,
  GUEST_ADMITTED_SILENT_SECONDS,
  GUEST_COOKIE,
  GUEST_FAILURE_LOCK,
  GUEST_LINK_GONE,
  GUEST_PAGE_PREFIX,
  GUEST_WAIT_SECONDS,
  GUEST_WAITING_PER_ADDRESS,
  GUEST_WAITING_SILENT_SECONDS,
  GuestKnockRequest,
  GuestKnockResponse,
  GuestLinkPeekRequest,
  GuestLinkToken,
  GuestLinkPeekResponse,
  GuestConsentRequest,
  GuestConsentResponse,
  GuestOkResponse,
  GuestSessionResponse,
  GuestTokenResponse,
  MEDIA_TOKEN_MAX_SECONDS,
  MEETING_GUEST_NAME_MAX,
  MEETING_LOBBY_PUSH,
  MakeGuestLinkResponse,
  ListGuestLinksResponse,
  MeetingGuestLinkPathParams,
  MeetingGuestPathParams,
  MeetingLobbyPush,
  MeetingLobbyResponse,
  MeetingPathParams,
  MeetingsGuestAdmittedEvent,
  MeetingsGuestAnsweredEvent,
  MeetingsGuestAskedEvent,
  MeetingsGuestDeniedEvent,
  MeetingsGuestLeftEvent,
  MeetingsGuestLinkCreatedEvent,
  MeetingsGuestLinkRevokedEvent,
  MeetingsGuestRemovedEvent,
  PostMeetingSegmentsRequest,
  PostMeetingSegmentsResponse,
  RevokeGuestLinkResponse,
  RevokeGuestLinksResponse,
  abuseLimit,
  addressKey,
  admitGuestRoute,
  denyGuestRoute,
  guestConsentRoute,
  guestHeartbeatRoute,
  guestKnockRoute,
  guestLeaveRoute,
  guestLinkPeekRoute,
  guestSegmentsRoute,
  guestSessionRoute,
  guestTokenRoute,
  listGuestLinksRoute,
  makeGuestLinkRoute,
  meetingLobbyRoute,
  removeGuestRoute,
  revokeGuestLinkRoute,
  revokeGuestLinksRoute,
  type GuestLinkMade,
  type GuestSessionState,
} from '@manythreads/shared';
import { announceRoom } from './live.ts';
import { WindowCounter, stripHostileText } from './limits.ts';
import { bestEffort, currentMedia, joinOf, mediaFailure, requireMedia } from './media.ts';
import { callerPerson, type Caller } from './routes.ts';
import { guestIdentity, guestSpeakerName, loadMeeting, type MeetingRow } from './rows.ts';
import { takeGuestSegments } from './segments.ts';

// Guest links and the waiting room (PLAN P17-04, docs/plans/guest-links.md, docs/plugins/meetings.md "Guest links"). Two halves:
//
//  * The members' routes run as the caller, and the database decides (migration 0012): `app.meetings_make_guest_link` (a reader who may post, not a workspace
//    guest, the call live and links on), `app.meetings_revoke_guest_links` (the starter, a lead, an admin), `app.meetings_decide_guest` (someone in the call;
//    whoever answers first wins; letting in counts the room).
//  * The guest's routes are public: nobody is signed in. They run as the system role and scope every statement themselves, by the hash of the link's secret or of
//    the guest's cookie secret, so a guest reaches exactly one call and nothing else: no session route reads the guest's cookie (it is sent only to `/api/guest`),
//    and a guest's media token names the one room, microphone and camera only, for ten minutes at most.
//
// Transcription (step 2): while the call is transcribed, a guest let in is asked "Transcribe my voice?" on their page (`POST /api/guest/consent`). A guest who says yes is
// written down by their own device, which sends its lines to `POST /api/guest/segments`; they are stored with `guest_id` and read "Ana (guest)". The server never
// writes a guest down itself and the note-taker never listens to one. A no throws away what was stored; a guest who did not answer is never written down.
//
// Secrets: a link is 32 random bytes in the address (`/join/g/<43 characters>`), the cookie is `<guest id>.<32 random bytes>`; only the sha-256 of each is stored
// and they are found by that hash (an equality lookup, so the time it takes says nothing about how close a guess was). Neither is logged, put in an event or an
// audit row, or returned after it was made. An unknown, expired, turned-off and used-up link answer the same 404. Refused secrets count per client address: 20 in
// 15 minutes lock the address for 15 minutes. A secret of the wrong shape is refused before anything is looked up, and is not counted (it cannot be right).

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
/** A new secret: 32 random bytes as base64url (43 characters) and its sha-256. */
export function newGuestSecret(): { secret: string; hash: Buffer } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: sha256(secret) };
}
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const GUEST_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name a guest is shown by in the room, set by the server. */
export const guestLabel = guestSpeakerName;

// ---- the cookie ---------------------------------------------------------------------------------------------------------------------------------------

/** `mt_guest=<id>.<secret>` from a Cookie header; null when absent. `malformed` when present but not of the shape the server makes (never looked up). */
export function readGuestCookie(header: string | undefined): { guestId: string; secret: string } | 'malformed' | null {
  if (!header) return null;
  let raw: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === GUEST_COOKIE) raw = part.slice(eq + 1).trim();
  }
  if (raw === undefined) return null;
  const dot = raw.indexOf('.');
  const guestId = dot < 0 ? '' : raw.slice(0, dot);
  const secret = dot < 0 ? '' : raw.slice(dot + 1);
  if (!GUEST_ID_SHAPE.test(guestId) || !SECRET_SHAPE.test(secret)) return 'malformed';
  return { guestId, secret };
}

/** The Set-Cookie value: HttpOnly, SameSite=Strict, only `/api/guest`, Secure on an https site, for `maxAgeSeconds` (0 clears it). */
export function guestCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${GUEST_COOKIE}=${value}; Path=/api/guest; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** The guest's routes accept a state-changing call only from the site's own pages: the `Origin` must be the public address (on top of SameSite=Strict). */
export function sameOrigin(req: Pick<HttpRequest, 'headers'>, publicUrl: string): boolean {
  const origin = req.headers['origin'];
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

const NOT_YOURS = 'This guest page has expired. Open the link again.';

// ---- in-memory limits (per replica, like every rate limit) ------------------------------------------------------------------------------------------------
const KNOCKS_PER_LINK_PER_MINUTE = 20;
const perLink = new WindowCounter(60_000);
/**
 * The knocks of each call and address that may still be waiting, by guest id (in memory, per replica). Before a knock the set is checked against the database, so a
 * guest who was let in, turned away, left or lapsed no longer counts; a knock the database refused is never added.
 */
const waitingByAddress = new Map<string, Set<string>>();
const WAITING_KEYS_MAX = 20_000;

// ---- the members' half ------------------------------------------------------------------------------------------------------------------------------------

/** The database's refusals, matched on the start of its message (never forwarded), and what each answers with. */
const REFUSALS: readonly (readonly [string, number, string])[] = [
  ['This call has ended', 409, 'This call has ended.'],
  ['A call in a direct message', 409, 'A call in a direct message cannot have guest links.'],
  ['Guest links are switched off for this workspace', 409, 'Guest links are switched off for this workspace. A workspace admin can allow them.'],
  ['Guest links are off for this call', 409, 'Guest links are off for this call.'],
  ['At most 10 guest links', 409, 'This call already has 10 guest links. Use one you copied before.'],
  ['Someone already answered', 409, 'Someone already answered.'],
  ['That guest is not in the call', 409, 'That guest is not in the call any more.'],
  ['The call is full', 409, 'The call is full'],
];

function refusal(err: unknown, gone: string, denied: string): never {
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === 'P0002') throw notFound(gone);
  if (code === '42501') throw forbidden(denied);
  if (code === '23514') {
    const hit = REFUSALS.find(([start]) => typeof message === 'string' && message.startsWith(start));
    throw new HttpError(hit?.[1] ?? 409, 'conflict', hit?.[2] ?? 'This cannot be done now.');
  }
  throw err;
}

/**
 * The people in the call now who may let a guest in (person ids): the same rule as `app.meetings_decide_guest`, so a workspace guest in the call is told nothing of
 * who knocks.
 */
async function decidingPeople(tx: PluginTx, meetingId: string): Promise<string[]> {
  return (
    await tx.query<{ person_id: string }>(
      `SELECT p.person_id FROM app.meeting_participants p
         JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.person_id AND wm.role <> 'guest'
        WHERE p.meeting_id = $1::uuid AND p.left_at IS NULL`,
      [meetingId],
    )
  ).rows.map((r) => r.person_id);
}

async function pushLobby(ctx: PluginContext, tx: PluginTx, meetingId: string): Promise<void> {
  const people = await decidingPeople(tx, meetingId);
  if (people.length > 0) await ctx.realtime.pushToPeople(tx, people, MEETING_LOBBY_PUSH, MeetingLobbyPush.parse({ meetingId }));
}

/**
 * Makes a guest link of the caller's own for the call and says so (`meetings.guest_link.created`). `turnOn` is the start's first link, which turns guest links on.
 * Returns the address, shown this once.
 */
export async function makeGuestLink(ctx: PluginContext, tx: PluginTx, m: Pick<MeetingRow, 'id' | 'workspace_id'>, caller: Caller, turnOn: boolean): Promise<GuestLinkMade> {
  const { secret, hash } = newGuestSecret();
  let row: { link_id: string; expires_at: Date; team_id: string | null; channel_id: string } | undefined;
  try {
    row = (
      await tx.query<{ link_id: string; expires_at: Date; team_id: string | null; channel_id: string }>(
        'SELECT link_id, expires_at, team_id, channel_id FROM app.meetings_make_guest_link($1::uuid, $2::bytea, $3::boolean)',
        [m.id, hash, turnOn],
      )
    ).rows[0];
  } catch (err) {
    refusal(err, 'That call is not available', 'You cannot make a guest link for this call.');
  }
  if (!row) throw notFound('That call is not available');
  await ctx.audit.emit(
    tx,
    MeetingsGuestLinkCreatedEvent.parse({
      type: 'meetings.guest_link.created',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: row.team_id,
      channelId: row.channel_id,
      meetingId: m.id,
      linkId: row.link_id,
      createdBy: caller.actorId,
      expiresAt: row.expires_at.toISOString(),
      at: ctx.runtime.now().toISOString(),
    }),
  );
  return { linkId: row.link_id as GuestLinkMade['linkId'], url: `${ctx.runtime.publicUrl.replace(/\/+$/, '')}${GUEST_PAGE_PREFIX}${secret}`, expiresAt: row.expires_at.toISOString() };
}

interface ClosingFacts {
  guests: { id: string; state: string }[];
  links: string[];
}

/** What the end of a call will close (read before `app.meetings_end`, whose trigger closes them): the guests waiting or in, and the links still working. */
export async function guestsBeforeEnd(tx: PluginTx, meetingId: string): Promise<ClosingFacts> {
  const guests = (await tx.query<{ id: string; state: string }>("SELECT id::text, state FROM app.meeting_guests WHERE meeting_id = $1::uuid AND state IN ('waiting', 'admitted')", [meetingId])).rows;
  const links = (
    await tx.query<{ id: string }>('SELECT id::text FROM app.meeting_guest_links WHERE meeting_id = $1::uuid AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses', [meetingId])
  ).rows.map((r) => r.id);
  return { guests, links };
}

/** The events of a call's end for its guests and links. */
export async function emitGuestsEnded(
  ctx: PluginContext,
  tx: PluginTx,
  m: { id: string; workspace_id: string; team_id: string | null; channel_id: string | null },
  closing: ClosingFacts,
): Promise<void> {
  const at = ctx.runtime.now().toISOString();
  const place = { schemaVersion: 1 as const, workspaceId: m.workspace_id, teamId: m.team_id, channelId: m.channel_id, meetingId: m.id, at };
  for (const g of closing.guests) {
    await ctx.audit.emit(tx, MeetingsGuestLeftEvent.parse({ ...place, type: 'meetings.guest.left', guestId: g.id, how: g.state === 'waiting' ? 'expired' : 'ended' }));
  }
  if (closing.links.length > 0) {
    await ctx.audit.emit(tx, MeetingsGuestLinkRevokedEvent.parse({ ...place, type: 'meetings.guest_link.revoked', linkIds: closing.links.slice(0, 100), revokedBy: null, reason: 'ended' }));
  }
}

/**
 * The sweep's part (every minute, as the system, one workspace at a time): a waiting guest whose page has been silent three minutes, or who has waited ten, is
 * expired; a guest in the call whose page has been silent three minutes is counted as gone and dropped from the media room. The people in each call changed are
 * told (the waiting room, the room). Times are the database's. Returns how many changed.
 */
export async function sweepGuests(ctx: PluginContext, tx: PluginTx, workspaceId: string): Promise<number> {
  const gone = (
    await tx.query<{ id: string; meeting_id: string; workspace_id: string; team_id: string | null; channel_id: string; was: string }>(
      `WITH stale AS (
         SELECT g.id, g.state FROM app.meeting_guests g
           LEFT JOIN app.meeting_guest_presence r ON r.guest_id = g.id
          WHERE g.workspace_id = $4::uuid
            AND ((g.state = 'waiting' AND (coalesce(r.seen_at, g.asked_at) < now() - make_interval(secs => $1::int) OR g.asked_at < now() - make_interval(secs => $2::int)))
              OR (g.state = 'admitted' AND coalesce(r.seen_at, g.decided_at, g.asked_at) < now() - make_interval(secs => $3::int)))
          FOR UPDATE OF g SKIP LOCKED
       )
       UPDATE app.meeting_guests g SET state = CASE WHEN s.state = 'waiting' THEN 'expired' ELSE 'left' END, left_at = now()
         FROM stale s WHERE g.id = s.id
       RETURNING g.id::text, g.meeting_id::text, g.workspace_id::text, g.team_id::text, g.channel_id::text, s.state AS was`,
      [GUEST_WAITING_SILENT_SECONDS, GUEST_WAIT_SECONDS, GUEST_ADMITTED_SILENT_SECONDS, workspaceId],
    )
  ).rows;
  if (gone.length === 0) return 0;
  await tx.query('DELETE FROM app.meeting_guest_presence WHERE guest_id = ANY ($1::uuid[])', [gone.map((g) => g.id)]);
  const media = currentMedia(ctx);
  const at = ctx.runtime.now().toISOString();
  for (const g of gone) {
    await ctx.audit.emit(
      tx,
      MeetingsGuestLeftEvent.parse({
        type: 'meetings.guest.left',
        schemaVersion: 1,
        workspaceId: g.workspace_id,
        teamId: g.team_id,
        channelId: g.channel_id,
        meetingId: g.meeting_id,
        guestId: g.id,
        how: g.was === 'waiting' ? 'expired' : 'dropped',
        at,
      }),
    );
    if (g.was === 'admitted' && media && media.status().configured) await bestEffort(undefined, 'dropping a silent guest', () => media.kick(g.meeting_id, guestIdentity(g.id)));
  }
  const calls = new Map(gone.map((g) => [g.meeting_id, g] as const));
  for (const [meetingId, g] of calls) {
    if (gone.some((x) => x.meeting_id === meetingId && x.was === 'waiting')) await pushLobby(ctx, tx, meetingId);
    if (gone.some((x) => x.meeting_id === meetingId && x.was === 'admitted')) await announceRoom(ctx, tx, { id: meetingId, channel_id: g.channel_id, state: 'live' });
  }
  return gone.length;
}

// ---- the guest's half: lookups as the system role, scoped by a hash ---------------------------------------------------------------------------------------

interface GuestRow extends Record<string, unknown> {
  id: string;
  meeting_id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string;
  display_name: string;
  state: 'waiting' | 'admitted' | 'denied' | 'removed' | 'left' | 'expired';
  asked_at: Date;
  /** A knock nobody answered in ten minutes, by the database's clock. */
  lapsed: boolean;
  meeting_state: 'live' | 'ended';
  title: string;
  kind: 'audio' | 'video';
  channel_name: string | null;
  consent_transcribe: 'unasked' | 'yes' | 'no';
  transcription: 'off' | 'on_device' | 'server';
  turned_on_by: string | null;
  started_at: Date;
  server_now: Date;
}

/** The guest the cookie belongs to, found by the hash of its secret and checked against the id beside it; undefined when there is none. */
async function guestByCookie(sys: PluginTx, cookie: { guestId: string; secret: string }): Promise<GuestRow | undefined> {
  const row = (
    await sys.query<GuestRow>(
      `SELECT g.id::text, g.meeting_id::text, g.workspace_id::text, g.team_id::text, g.channel_id::text, g.display_name, g.state, g.asked_at,
              (g.state = 'waiting' AND g.asked_at <= now() - make_interval(secs => $2::int)) AS lapsed, m.state AS meeting_state, m.title, m.kind, c.name AS channel_name,
              g.consent_transcribe, m.transcription, m.started_at, clock_timestamp() AS server_now,
              (SELECT p.display_name FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.actor_id = m.transcription_by) AS turned_on_by
         FROM app.meeting_guests g JOIN app.meetings m ON m.id = g.meeting_id LEFT JOIN app.channels c ON c.id = m.channel_id
        WHERE g.credential_hash = $1::bytea`,
      [sha256(cookie.secret), GUEST_WAIT_SECONDS],
    )
  ).rows[0];
  return row && row.id === cookie.guestId ? row : undefined;
}

/**
 * The call's title as a guest sees it: never the channel (decision 3 of the plan). A title the server wrote itself names the channel ("Call · #dev · 14:02",
 * routes.ts `defaultTitle`): a guest sees "Call · 14:02". A title the starter typed is shown as typed.
 */
export function guestTitle(title: string, channelName: string | null): string {
  if (!channelName) return title;
  const prefix = `Call · #${[...channelName.replace(/^#/, '')].slice(0, 80).join('')} · `;
  return title.startsWith(prefix) ? `Call · ${title.slice(prefix.length)}` : title;
}

/** The names of the people in the call and of the guests let in, for a guest's tiles: no avatar, no handle, no e-mail address. */
async function roomPeople(sys: PluginTx, meetingId: string): Promise<{ identity: string; displayName: string }[]> {
  return (
    await sys.query<{ identity: string; display_name: string }>(
      `SELECT p.actor_id::text AS identity, p.display_name FROM app.meeting_participants p WHERE p.meeting_id = $1::uuid AND p.left_at IS NULL
       UNION ALL
       SELECT 'guest:' || x.id::text, x.display_name || ' (guest)' FROM app.meeting_guests x WHERE x.meeting_id = $1::uuid AND x.state = 'admitted'`,
      [meetingId],
    )
  ).rows.map((r) => ({ identity: r.identity, displayName: r.display_name }));
}

/** The state the guest page shows: the call's end wins; a knock nobody answered in ten minutes has lapsed (the database's clock decides, MISTAKES P15-02). */
function stateOf(g: GuestRow): GuestSessionState {
  if (g.meeting_state === 'ended') return 'ended';
  if (g.lapsed) return 'expired';
  return g.state;
}

export function registerGuestRoutes(ctx: PluginContext): void {
  const refusals = createLockout({ now: ctx.runtime.now, ...GUEST_FAILURE_LOCK });
  const lockKey = (req: HttpRequest): string => `guest\n${addressKey(req.ip)}`;
  const secure = (): boolean => ctx.runtime.publicUrl.startsWith('https://');
  /** Runs a lookup by a secret behind the address lock: a 404 (a link) or 401 (a cookie) counts as a refused guess. */
  const guarded = <T>(req: HttpRequest, fn: () => Promise<T>): Promise<T> =>
    guardRedemption(refusals, lockKey(req), 'attempts with a guest link', fn, ({ error }) => error instanceof HttpError && (error.status === 404 || error.status === 401));
  const requireOrigin = (req: HttpRequest): void => {
    if (!sameOrigin(req, ctx.runtime.publicUrl)) throw forbidden('This request did not come from this site.');
  };
  /** The link's secret from the body, or the same 404 as an unknown link (a wrong shape is never looked up and never counted). */
  const tokenOf = (token: string): string => {
    const p = GuestLinkToken.safeParse(token);
    if (!p.success) throw notFound(GUEST_LINK_GONE);
    return p.data;
  };
  /** Runs `fn` with the guest of the request's cookie, as the system role in the guest's workspace; 401 when there is no such guest. */
  const asGuest = async <T>(req: HttpRequest, fn: (sys: PluginTx, g: GuestRow) => Promise<T>): Promise<T> => {
    const cookie = readGuestCookie(req.headers['cookie']);
    if (cookie === null || cookie === 'malformed') throw new HttpError(401, 'unauthenticated', NOT_YOURS);
    return guarded(req, async () => {
      // one lookup by the hash (it names the workspace the work then runs in); every write below says which state it changes from, so two requests at once
      // cannot both move the guest
      const g = await ctx.db.system((sys) => guestByCookie(sys, cookie));
      if (!g) throw new HttpError(401, 'unauthenticated', NOT_YOURS);
      return ctx.db.system((sys) => fn(sys, g), { workspaceId: g.workspace_id });
    });
  };
  const publicRoute = { public: true, rateLimitBy: 'address' as const, csrfExempt: true };

  // ---- peek: what the guest page shows before the knock -----------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...guestLinkPeekRoute,
    ...publicRoute,
    schema: { body: GuestLinkPeekRequest, response: GuestLinkPeekResponse },
    rateLimit: abuseLimit('POST', guestLinkPeekRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const token = tokenOf(GuestLinkPeekRequest.parse(req.body).token);
      return guarded(req, async () => {
        const row = await ctx.db.system(async (sys) =>
          (
            await sys.query<{ title: string; kind: 'audio' | 'video'; transcription: string; notetaker: boolean; workspace_name: string; channel_name: string | null }>(
              `SELECT m.title, m.kind, m.transcription, m.notetaker_bot_id IS NOT NULL AS notetaker, w.name AS workspace_name, c.name AS channel_name
                 FROM app.meeting_guest_links l
                 JOIN app.meetings m ON m.id = l.meeting_id
                 LEFT JOIN app.channels c ON c.id = m.channel_id
                 JOIN app.workspaces w ON w.id = l.workspace_id
                 LEFT JOIN app.meeting_settings s ON s.workspace_id = l.workspace_id
                WHERE l.token_hash = $1::bytea AND l.revoked_at IS NULL AND l.expires_at > now() AND l.uses < l.max_uses
                  AND m.state = 'live' AND m.allow_guests AND coalesce(s.guest_links_allowed, true)`,
              [sha256(token)],
            )
          ).rows[0],
        );
        if (!row) throw notFound(GUEST_LINK_GONE);
        return withHeaders(
          json(GuestLinkPeekResponse.parse({ state: 'open', workspaceName: row.workspace_name, title: guestTitle(row.title, row.channel_name), kind: row.kind, transcribing: row.transcription !== 'off', notetaker: row.notetaker })),
          noStore,
        );
      });
    },
  });

  // ---- knock: a waiting row and the guest's cookie ---------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...guestKnockRoute,
    ...publicRoute,
    schema: { body: GuestKnockRequest, response: GuestKnockResponse },
    rateLimit: abuseLimit('POST', guestKnockRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const body = GuestKnockRequest.parse(req.body);
      const token = tokenOf(body.token);
      const { displayName } = body;
      const name = [...stripHostileText(displayName)].slice(0, MEETING_GUEST_NAME_MAX).join('');
      if (name === '') throw new HttpError(400, 'validation_failed', 'Write your name');
      const linkHash = sha256(token);
      return guarded(req, async () => {
        const link = (
          await ctx.db.system(async (sys) => (await sys.query<{ id: string; meeting_id: string; workspace_id: string }>('SELECT id::text, meeting_id::text, workspace_id::text FROM app.meeting_guest_links WHERE token_hash = $1::bytea', [linkHash])).rows[0])
        );
        if (!link) throw notFound(GUEST_LINK_GONE);
        const now = ctx.runtime.now().getTime();
        const busyLink = perLink.take(`l:${link.id}`, 1, KNOCKS_PER_LINK_PER_MINUTE, now);
        if (busyLink !== null) throw new HttpError(429, 'rate_limited', 'Too many people are opening this link at once. Try again in a minute.', { 'retry-after': String(busyLink) });
        const addressSlot = `${link.meeting_id}\n${addressKey(req.ip)}`;
        const mine = waitingByAddress.get(addressSlot);
        if (mine && mine.size > 0) {
          const still = await ctx.db.system(async (sys) =>
            (
              await sys.query<{ id: string }>(
                "SELECT id::text FROM app.meeting_guests WHERE id = ANY ($1::uuid[]) AND state = 'waiting' AND asked_at > now() - make_interval(secs => $2::int)",
                [[...mine], GUEST_WAIT_SECONDS],
              )
            ).rows.map((r) => r.id),
          );
          for (const id of [...mine]) if (!still.includes(id)) mine.delete(id);
          if (mine.size === 0) waitingByAddress.delete(addressSlot);
          if (mine.size >= GUEST_WAITING_PER_ADDRESS) {
            throw new HttpError(429, 'rate_limited', 'Too many people are waiting to join this call from your network. Try again once one of them is let in.', { 'retry-after': '60' });
          }
        }
        const credential = newGuestSecret();
        const made = await ctx.db.system(
          async (sys) => {
            let row: { guest_id: string; link_id: string; meeting_id: string; workspace_id: string; team_id: string | null; channel_id: string; max_age: number } | undefined;
            try {
              row = (
                await sys.query<{ guest_id: string; link_id: string; meeting_id: string; workspace_id: string; team_id: string | null; channel_id: string; max_age: number }>(
                  // the cookie lasts as long as the link, by the database's clock
                  `SELECT guest_id::text, link_id::text, meeting_id::text, workspace_id::text, team_id::text, channel_id::text,
                          greatest(1, floor(extract(epoch FROM expires_at - now())))::int AS max_age
                     FROM app.meetings_guest_knock($1::bytea, $2, $3::bytea)`,
                  [linkHash, name, credential.hash],
                )
              ).rows[0];
            } catch (err) {
              const code = (err as { code?: unknown }).code;
              if (code === 'P0002') throw notFound(GUEST_LINK_GONE);
              if (code === '54000') throw new HttpError(429, 'rate_limited', 'The waiting room of this call is full. Try again in a few minutes.', { 'retry-after': '60' });
              throw err;
            }
            if (!row) throw notFound(GUEST_LINK_GONE);
            const m = (
              await sys.query<{ title: string; kind: 'audio' | 'video'; channel_name: string | null }>(
                'SELECT m.title, m.kind, c.name AS channel_name FROM app.meetings m LEFT JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1::uuid',
                [row.meeting_id],
              )
            ).rows[0]!;
            await sys.query('INSERT INTO app.meeting_guest_presence (guest_id, meeting_id) VALUES ($1::uuid, $2::uuid)', [row.guest_id, row.meeting_id]);
            await ctx.audit.emit(
              sys,
              MeetingsGuestAskedEvent.parse({
                type: 'meetings.guest.asked',
                schemaVersion: 1,
                workspaceId: row.workspace_id,
                teamId: row.team_id,
                channelId: row.channel_id,
                meetingId: row.meeting_id,
                guestId: row.guest_id,
                linkId: row.link_id,
                at: ctx.runtime.now().toISOString(),
              }),
            );
            await pushLobby(ctx, sys, row.meeting_id);
            return { ...row, title: guestTitle(m.title, m.channel_name), kind: m.kind };
          },
          { workspaceId: link.workspace_id },
        );
        // the knock is in: it counts against its address while it waits
        if (!waitingByAddress.has(addressSlot) && waitingByAddress.size >= WAITING_KEYS_MAX) waitingByAddress.delete(waitingByAddress.keys().next().value as string);
        const slot = waitingByAddress.get(addressSlot) ?? new Set<string>();
        slot.add(made.guest_id);
        waitingByAddress.set(addressSlot, slot);
        const maxAge = made.max_age;
        return withHeaders(json(GuestKnockResponse.parse({ state: 'waiting', title: made.title, kind: made.kind }), 201), {
          ...noStore,
          'set-cookie': guestCookieHeader(`${made.guest_id}.${credential.secret}`, maxAge, secure()),
        });
      });
    },
  });

  // ---- session: where the guest stands (also their sign of life while waiting) -----------------------------------------------------------------------------
  ctx.http.route({
    ...guestSessionRoute,
    ...publicRoute,
    schema: { response: GuestSessionResponse },
    rateLimit: abuseLimit('GET', guestSessionRoute.path),
    handler: async (req) =>
      asGuest(req, async (sys, g) => {
        const state = stateOf(g);
        if (state === 'expired' && g.state === 'waiting') {
          const moved = await sys.query("UPDATE app.meeting_guests SET state = 'expired', left_at = now() WHERE id = $1::uuid AND state = 'waiting' RETURNING id", [g.id]);
          if (moved.rows.length > 0) {
            await sys.query('DELETE FROM app.meeting_guest_presence WHERE guest_id = $1::uuid', [g.id]);
            await emitLeft(sys, g, 'expired');
            await pushLobby(ctx, sys, g.meeting_id);
          }
        } else if (state === 'waiting' || state === 'admitted') {
          // the page's poll is its sign of life, in the waiting room and in the call
          await touch(sys, g);
        }
        const admitted = state === 'admitted';
        const people = admitted ? await roomPeople(sys, g.meeting_id) : [];
        return withHeaders(
          json(
            GuestSessionResponse.parse({
              state,
              title: guestTitle(g.title, g.channel_name),
              kind: g.kind,
              displayName: g.display_name,
              people,
              // only for a guest let in: whether the call is transcribed (and who turned it on), their own answer, and the call clock for their device's lines
              ...(admitted
                ? {
                    transcription: g.transcription,
                    turnedOnBy: g.transcription === 'off' ? null : g.turned_on_by,
                    consent: g.consent_transcribe,
                    startedAt: g.started_at.toISOString(),
                    serverNow: g.server_now.toISOString(),
                  }
                : {}),
            }),
          ),
          noStore,
        );
      }),
  });

  // ---- token: microphone and camera in the one room, while let in ----------------------------------------------------------------------------------------
  ctx.http.route({
    ...guestTokenRoute,
    ...publicRoute,
    schema: { response: GuestTokenResponse },
    rateLimit: abuseLimit('POST', guestTokenRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const media = requireMedia(ctx);
      return asGuest(req, async (sys, g) => {
        const state = stateOf(g);
        if (state === 'ended') throw conflict('The call has ended.');
        if (state !== 'admitted') throw forbidden(state === 'waiting' ? 'You have not been let in yet.' : 'You are not in this call.');
        await sys.query('UPDATE app.meeting_guests SET joined_at = coalesce(joined_at, now()) WHERE id = $1::uuid', [g.id]);
        await touch(sys, g);
        let token;
        try {
          token = await media.token({ id: guestIdentity(g.id), kind: 'guest', displayName: guestLabel(g.display_name) }, g.meeting_id, { canPublish: true, canSubscribe: true, sources: ['microphone', 'camera'] }, { ttlSeconds: MEDIA_TOKEN_MAX_SECONDS });
        } catch (err) {
          throw mediaFailure(err);
        }
        const people = await roomPeople(sys, g.meeting_id);
        return withHeaders(
          json(
            GuestTokenResponse.parse({
              join: joinOf(ctx, token, req.origin),
              people,
            }),
          ),
          noStore,
        );
      });
    },
  });

  // ---- "Transcribe my voice?" and the lines of the guest's own device (step 2) --------------------------------------------------------------------------------
  /** The guest must be let in to a live call that is being transcribed. */
  const requireTranscribed = (g: GuestRow): void => {
    const state = stateOf(g);
    if (state === 'ended') throw conflict('The call has ended.');
    if (state !== 'admitted') throw forbidden('You are not in this call.');
    if (g.transcription === 'off') throw conflict('This call is not being transcribed.');
  };

  ctx.http.route({
    ...guestConsentRoute,
    ...publicRoute,
    schema: { body: GuestConsentRequest, response: GuestConsentResponse },
    rateLimit: abuseLimit('POST', guestConsentRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const { transcribe } = GuestConsentRequest.parse(req.body);
      return asGuest(req, async (sys, g) => {
        requireTranscribed(g);
        const moved = await sys.query("UPDATE app.meeting_guests SET consent_transcribe = $2 WHERE id = $1::uuid AND state = 'admitted' RETURNING id", [g.id, transcribe]);
        if (moved.rows.length === 0) throw forbidden('You are not in this call.');
        // a no throws away the words already stored for the guest (the line keeps its times: "Ana (guest) spoke (not transcribed)")
        // and the marks that hold the guest's words (Mark action item) go with them
        if (transcribe === 'no') {
          await sys.query("UPDATE app.meeting_segments SET text = '' WHERE meeting_id = $1::uuid AND guest_id = $2::uuid AND text <> ''", [g.meeting_id, g.id]);
          await sys.query('DELETE FROM app.meeting_marks WHERE meeting_id = $1::uuid AND $2::uuid = ANY (guest_ids)', [g.meeting_id, g.id]);
        }
        await ctx.audit.emit(
          sys,
          MeetingsGuestAnsweredEvent.parse({
            type: 'meetings.guest.answered',
            schemaVersion: 1,
            workspaceId: g.workspace_id,
            teamId: g.team_id,
            channelId: g.channel_id,
            meetingId: g.meeting_id,
            guestId: g.id,
            value: transcribe,
            at: ctx.runtime.now().toISOString(),
          }),
        );
        await touch(sys, g);
        return withHeaders(json(GuestConsentResponse.parse({ consent: transcribe })), noStore);
      });
    },
  });

  ctx.http.route({
    ...guestSegmentsRoute,
    ...publicRoute,
    schema: { body: PostMeetingSegmentsRequest, response: PostMeetingSegmentsResponse },
    rateLimit: abuseLimit('POST', guestSegmentsRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const { segments } = PostMeetingSegmentsRequest.parse(req.body);
      return asGuest(req, async (sys, g) => {
        requireTranscribed(g);
        if (g.consent_transcribe !== 'yes') throw conflict('You have not said yes to being transcribed.');
        const done = await takeGuestSegments(ctx, sys, { id: g.meeting_id, workspaceId: g.workspace_id }, { guestId: g.id, displayName: guestLabel(g.display_name), consent: g.consent_transcribe }, segments);
        return withHeaders(json(PostMeetingSegmentsResponse.parse(done)), noStore);
      });
    },
  });

  // ---- leave and heartbeat ----------------------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...guestLeaveRoute,
    ...publicRoute,
    schema: { response: GuestOkResponse },
    rateLimit: abuseLimit('POST', guestLeaveRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      const res = await asGuest(req, async (sys, g) => {
        const moved =
          g.state === 'waiting' || g.state === 'admitted'
            ? (await sys.query("UPDATE app.meeting_guests SET state = 'left', left_at = now() WHERE id = $1::uuid AND state IN ('waiting', 'admitted') RETURNING id", [g.id])).rows.length > 0
            : false;
        if (moved) {
          await sys.query('DELETE FROM app.meeting_guest_presence WHERE guest_id = $1::uuid', [g.id]);
          await emitLeft(sys, g, 'left');
          if (g.state === 'waiting') await pushLobby(ctx, sys, g.meeting_id);
          else if (g.meeting_state === 'live') {
            await announceRoom(ctx, sys, { id: g.meeting_id, channel_id: g.channel_id, state: 'live' });
            const media = currentMedia(ctx);
            if (media && media.status().configured) await bestEffort(undefined, 'dropping a guest who left', () => media.kick(g.meeting_id, guestIdentity(g.id)));
          }
        }
        return GuestOkResponse.parse({ ok: true });
      });
      return withHeaders(json(res), { ...noStore, 'set-cookie': guestCookieHeader('', 0, secure()) });
    },
  });

  ctx.http.route({
    ...guestHeartbeatRoute,
    ...publicRoute,
    schema: { response: GuestOkResponse },
    rateLimit: abuseLimit('POST', guestHeartbeatRoute.path),
    handler: async (req) => {
      requireOrigin(req);
      return asGuest(req, async (sys, g) => {
        const state = stateOf(g);
        if (state !== 'waiting' && state !== 'admitted') throw conflict(state === 'ended' ? 'The call has ended.' : 'You are not in this call.');
        await touch(sys, g);
        return withHeaders(json(GuestOkResponse.parse({ ok: true })), noStore);
      });
    },
  });

  async function touch(sys: PluginTx, g: GuestRow): Promise<void> {
    await sys.query(
      `INSERT INTO app.meeting_guest_presence (guest_id, meeting_id, seen_at) VALUES ($1::uuid, $2::uuid, now())
       ON CONFLICT (guest_id) DO UPDATE SET seen_at = now()`,
      [g.id, g.meeting_id],
    );
  }

  async function emitLeft(sys: PluginTx, g: GuestRow, how: 'left' | 'expired'): Promise<void> {
    await ctx.audit.emit(
      sys,
      MeetingsGuestLeftEvent.parse({
        type: 'meetings.guest.left',
        schemaVersion: 1,
        workspaceId: g.workspace_id,
        teamId: g.team_id,
        channelId: g.channel_id,
        meetingId: g.meeting_id,
        guestId: g.id,
        how,
        at: ctx.runtime.now().toISOString(),
      }),
    );
  }

  // ---- the members' routes ------------------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...makeGuestLinkRoute,
    schema: { response: MakeGuestLinkResponse },
    rateLimit: abuseLimit('POST', makeGuestLinkRoute.path),
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      const made = await makeGuestLink(ctx, tx, m, caller, false);
      return withHeaders(json(MakeGuestLinkResponse.parse(made), 201), noStore);
    }),
  });

  ctx.http.route({
    ...revokeGuestLinksRoute,
    schema: { response: RevokeGuestLinksResponse },
    rateLimit: abuseLimit('DELETE', revokeGuestLinksRoute.path),
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      let ids: string[] = [];
      try {
        ids = (await tx.query<{ link_id: string }>('SELECT link_id::text FROM app.meetings_revoke_guest_links($1::uuid)', [m.id])).rows.map((r) => r.link_id);
      } catch (err) {
        refusal(err, 'That call is not available', 'Only the person who started the call, a team lead or an admin can turn guest links off.');
      }
      await ctx.audit.emit(
        tx,
        MeetingsGuestLinkRevokedEvent.parse({
          type: 'meetings.guest_link.revoked',
          schemaVersion: 1,
          workspaceId: m.workspace_id,
          teamId: m.team_id,
          channelId: m.channel_id,
          meetingId: m.id,
          linkIds: ids.slice(0, 100),
          revokedBy: caller.actorId,
          reason: 'person',
          at: ctx.runtime.now().toISOString(),
        }),
      );
      await announceRoom(ctx, tx, m);
      return json(RevokeGuestLinksResponse.parse({ revoked: ids.length }));
    }),
  });

  // ---- "Guest links (n)": the links of the call that still work, and turning off one of them (step 2) ------------------------------------------------------------
  ctx.http.route({
    ...listGuestLinksRoute,
    schema: { response: ListGuestLinksResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m || !m.channel_id) throw notFound('That call is not available');
      // the people who may turn links off (app.meetings_revoke_guest_link's rule): the starter, a lead of the channel's team, an admin
      const may = (await tx.query<{ ok: boolean }>("SELECT ($2::uuid = app.actor() OR coalesce(app.lookup_channel_can($1::uuid, 'manage'), false)) AS ok", [m.channel_id, m.started_by])).rows[0]?.ok;
      if (!may) throw forbidden('Only the person who started the call, a team lead or an admin sees its guest links.');
      if (m.state !== 'live') return withHeaders(json(ListGuestLinksResponse.parse({ links: [] })), noStore);
      const links = (
        await tx.query<{ id: string; created_by: string; created_at: Date; expires_at: Date; uses: number; max_uses: number }>(
          `SELECT id::text, created_by::text, created_at, expires_at, uses, max_uses FROM app.meeting_guest_links
            WHERE meeting_id = $1::uuid AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses ORDER BY created_at, id`,
          [m.id],
        )
      ).rows;
      // who made each link, a person of the workspace: the actors table shows a caller only their own row, so the names are read as the system, for these ids only
      const makers = [...new Set(links.map((l) => l.created_by))];
      const names = new Map(
        makers.length === 0
          ? []
          : await ctx.db.system(
              async (sys) =>
                (
                  await sys.query<{ id: string; display_name: string }>(
                    "SELECT a.id::text, p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = ANY ($1::uuid[]) AND a.kind = 'person'",
                    [makers],
                  )
                ).rows.map((r) => [r.id, r.display_name] as const),
              { workspaceId: m.workspace_id },
            ),
      );
      return withHeaders(
        json(
          ListGuestLinksResponse.parse({
            links: links.map((l) => ({
              id: l.id,
              createdBy: l.created_by,
              createdByName: names.get(l.created_by) ?? 'Someone',
              createdAt: l.created_at.toISOString(),
              expiresAt: l.expires_at.toISOString(),
              uses: l.uses,
              maxUses: l.max_uses,
            })),
          }),
        ),
        noStore,
      );
    }),
  });

  ctx.http.route({
    ...revokeGuestLinkRoute,
    schema: { response: RevokeGuestLinkResponse },
    rateLimit: abuseLimit('DELETE', revokeGuestLinkRoute.path),
    handler: route(async (req, tx) => {
      const { meetingId, linkId } = MeetingGuestLinkPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      let revoked = false;
      try {
        revoked = (await tx.query<{ revoked: boolean }>('SELECT app.meetings_revoke_guest_link($1::uuid, $2::uuid) AS revoked', [m.id, linkId])).rows[0]?.revoked === true;
      } catch (err) {
        refusal(err, 'That guest link is not there any more', 'Only the person who started the call, a team lead or an admin can turn guest links off.');
      }
      // only a link that still worked is news: one that had expired or was used up stopped already
      if (revoked) {
        await ctx.audit.emit(
          tx,
          MeetingsGuestLinkRevokedEvent.parse({
            type: 'meetings.guest_link.revoked',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: m.team_id,
            channelId: m.channel_id,
            meetingId: m.id,
            linkIds: [linkId],
            revokedBy: caller.actorId,
            reason: 'person',
            at: ctx.runtime.now().toISOString(),
          }),
        );
        await announceRoom(ctx, tx, m);
      }
      return json(RevokeGuestLinkResponse.parse({ revoked }));
    }),
  });

  ctx.http.route({
    ...meetingLobbyRoute,
    schema: { response: MeetingLobbyResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      // nobody outside the call is told who knocks, nor a workspace guest in it: only the people who may let a guest in (app.meetings_decide_guest's rule)
      const here = await tx.query<{ role: string | null }>(
        'SELECT app.lookup_workspace_role() AS role FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL',
        [m.id, caller.actorId],
      );
      const role = here.rows[0]?.role;
      if (here.rows.length === 0 || !role || role === 'guest') throw forbidden('Only someone in the call sees who is waiting.');
      const waiting = (
        await tx.query<{ id: string; display_name: string; asked_at: Date }>(
          "SELECT id::text, display_name, asked_at FROM app.meeting_guests WHERE meeting_id = $1::uuid AND state = 'waiting' AND asked_at > now() - make_interval(secs => $2::int) ORDER BY asked_at, id",
          [m.id, GUEST_WAIT_SECONDS],
        )
      ).rows;
      return json(MeetingLobbyResponse.parse({ waiting: m.state === 'live' ? waiting.map((w) => ({ id: w.id, displayName: w.display_name, askedAt: w.asked_at.toISOString() })) : [] }));
    }),
  });

  const DECISIONS = [
    [admitGuestRoute, 'admit'],
    [denyGuestRoute, 'deny'],
    [removeGuestRoute, 'remove'],
  ] as const;
  for (const [def, decision] of DECISIONS) {
    ctx.http.route({
      ...def,
      schema: { response: DecideGuestResponse },
      rateLimit: abuseLimit('POST', def.path),
      handler: route(async (req, tx) => {
        const { meetingId, guestId } = MeetingGuestPathParams.parse(req.params);
        const caller = await callerPerson(tx);
        let row: { state: 'admitted' | 'denied' | 'removed'; workspace_id: string; team_id: string | null; channel_id: string } | undefined;
        try {
          row = (
            await tx.query<{ state: 'admitted' | 'denied' | 'removed'; workspace_id: string; team_id: string | null; channel_id: string }>(
              'SELECT state, workspace_id::text, team_id::text, channel_id::text FROM app.meetings_decide_guest($1::uuid, $2::uuid, $3)',
              [meetingId, guestId, decision],
            )
          ).rows[0];
        } catch (err) {
          refusal(err, 'That guest is not there any more', 'Only someone in the call can let a guest in.');
        }
        if (!row) throw notFound('That guest is not there any more');
        const place = { schemaVersion: 1 as const, workspaceId: row.workspace_id, teamId: row.team_id, channelId: row.channel_id, meetingId, guestId, decidedBy: caller.actorId, at: ctx.runtime.now().toISOString() };
        if (decision === 'admit') await ctx.audit.emit(tx, MeetingsGuestAdmittedEvent.parse({ ...place, type: 'meetings.guest.admitted' }));
        else if (decision === 'deny') await ctx.audit.emit(tx, MeetingsGuestDeniedEvent.parse({ ...place, type: 'meetings.guest.denied' }));
        else await ctx.audit.emit(tx, MeetingsGuestRemovedEvent.parse({ ...place, type: 'meetings.guest.removed' }));
        await pushLobby(ctx, tx, meetingId);
        if (decision !== 'deny') await announceRoom(ctx, tx, { id: meetingId, channel_id: row.channel_id, state: 'live' });
        if (decision === 'remove') {
          const media: MediaProvider | undefined = currentMedia(ctx);
          if (media && media.status().configured) await bestEffort(undefined, 'taking a guest out', () => media.kick(meetingId, guestIdentity(guestId)));
        }
        return json(DecideGuestResponse.parse({ state: row.state }));
      }),
    });
  }
}

/** Answers that carry a secret, or the state of one, are never kept by a cache. */
const noStore: Record<string, string> = { 'cache-control': 'no-store' };
const withHeaders = (res: HttpResponse, headers: Record<string, string>): HttpResponse => ({ ...res, headers: { ...res.headers, ...headers } });

/** For the webhook: a `guest:<uuid>` that joins the media room without being let in (or after the call ended) is dropped; a guest let in may come and go. */
export async function guestNotice(ctx: PluginContext, sys: PluginTx, media: MediaProvider, notice: { kind: string; room: string; identity: string }): Promise<void> {
  const id = notice.identity.slice('guest:'.length);
  if (!GUEST_ID_SHAPE.test(id)) return;
  const g = (
    await sys.query<{ state: string; meeting_state: string; workspace_id: string; team_id: string | null; channel_id: string }>(
      `SELECT g.state, m.state AS meeting_state, g.workspace_id::text, g.team_id::text, g.channel_id::text
         FROM app.meeting_guests g JOIN app.meetings m ON m.id = g.meeting_id WHERE g.id = $1::uuid AND g.meeting_id = $2::uuid`,
      [id, notice.room],
    )
  ).rows[0];
  if (notice.kind === 'participant_joined') {
    if (!g || g.state !== 'admitted' || g.meeting_state !== 'live') await bestEffort(undefined, 'dropping a guest who is not let in', () => media.kick(notice.room, notice.identity));
    return;
  }
  // participant_left changes nothing: a reload or a lost connection drops the media connection, and the guest comes back with the same cookie and a new token while
  // they are still let in. A guest leaves the call by Leave, by being taken out, by the call's end, or by a page silent for three minutes (the sweep).
}

