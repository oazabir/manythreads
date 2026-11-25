import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { MEETING_GUEST_IDENTITY, MEETING_GUEST_NAME_MAX, MeetingGuestState, MeetingKind } from '../../entities/meeting.ts';
import { MeetingGuestId, MeetingGuestLinkId, MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Guest links and the waiting room (PLAN P17-04, docs/plans/guest-links.md, docs/plugins/meetings.md "Guest links"). A link guest is someone outside the workspace,
// with no account: not a workspace guest (role `guest`). A member of the call's channel makes a link of their own (the server keeps only a hash of it, so each member
// gets theirs, shown once); whoever opens it types a name and knocks; anyone in the call lets them in or turns them away. A guest gets the one call: they hear and see
// the people in it and send their microphone and camera, and nothing else (no screen, no chat, no channel, no transcript). A guest is never transcribed or recorded.
//
// The guest's side is public (no session). Its credential is a cookie, `mt_guest`, made at the knock: HttpOnly, SameSite=Strict, limited to `/api/guest` and to
// that one call. No session route reads it.

/** A link works this long at most, while the call is live; ending the call turns every link off. */
export const GUEST_LINK_MAX_HOURS = 12;
/** A link lets this many people knock by default (1 to 100). */
export const GUEST_LINK_MAX_USES_DEFAULT = 50;
export const GUEST_LINK_MAX_USES_MAX = 100;
/** At most this many links of one call work at once. */
export const GUEST_LINKS_LIVE_MAX = 10;
/** At most this many guests of one call wait at once, and this many of them from one address. */
export const GUEST_WAITING_MAX = 10;
export const GUEST_WAITING_PER_ADDRESS = 3;
/**
 * A knock nobody answers lapses after this long (seconds); a waiting guest whose page is silent this long is counted as gone. Three minutes, not one: a browser slows
 * the timers of a hidden tab to once a minute or less, and the page also says it is there when it is shown again.
 */
export const GUEST_WAIT_SECONDS = 600;
export const GUEST_WAITING_SILENT_SECONDS = 180;
/** An admitted guest whose page is silent this long is counted as gone (seconds), as for a person. */
export const GUEST_ADMITTED_SILENT_SECONDS = 180;
/** The guest page asks for its state this often while waiting, and in the call (milliseconds). */
export const GUEST_POLL_WAITING_MS = 2_000;
export const GUEST_POLL_IN_CALL_MS = 10_000;
/** The guest's credential cookie. */
export const GUEST_COOKIE = 'mt_guest';
/** The address a guest link opens: `/join/g/<token>`. */
export const GUEST_PAGE_PREFIX = '/join/g/';

/** A link's secret part: 32 random bytes as base64url (43 characters). Anything else is refused before the database is asked. */
export const GuestLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type GuestLinkToken = z.infer<typeof GuestLinkToken>;
/**
 * The secret travels in the body of a POST, never in an API address: an address lands in access logs, proxies and the browser's history. (The page's own address,
 * `/join/g/<secret>`, does carry it: nginx writes no access log for it, the server's log redacts it, and the page takes it out of the address bar after the knock.)
 * Any string is taken here, so a secret of the wrong shape gets the same 404 as an unknown one rather than a different answer.
 */
const LinkSecret = z.string().max(200);

/** The same plain answer for an unknown, expired, turned-off or used-up link. */
export const GUEST_LINK_GONE = 'This guest link has expired or was turned off';

/** A link a member just made: the address is shown this once. */
export const GuestLinkMade = z.object({
  linkId: MeetingGuestLinkId,
  /** The whole address to share (`<site>/join/g/<token>`). */
  url: z.string().min(1).max(2000),
  expiresAt: IsoDateTime,
});
export type GuestLinkMade = z.infer<typeof GuestLinkMade>;

// ---- the guest's side (public) ------------------------------------------------------------------------------------------------------------------------

/**
 * What the guest page shows before the knock: the call's title and the workspace's name (never the channel, never who is in the call), its kind, and whether
 * it is being transcribed or a note-taker listens (the guest's own voice is not written down either way).
 */
export const GuestLinkPeekResponse = z.object({
  state: z.literal('open'),
  workspaceName: z.string(),
  title: z.string(),
  kind: MeetingKind,
  transcribing: z.boolean(),
  notetaker: z.boolean(),
});
export type GuestLinkPeekResponse = z.infer<typeof GuestLinkPeekResponse>;
export const GuestLinkPeekRequest = z.strictObject({ token: LinkSecret });
export type GuestLinkPeekRequest = z.infer<typeof GuestLinkPeekRequest>;
export const guestLinkPeekRoute = { method: 'POST', path: '/api/guest-links/peek' } as const satisfies ApiRoute;

/** The name the guest is shown by: 1 to 60 characters after control and direction characters are taken out (the server cleans it again). */
export const GuestDisplayName = z.string().trim().min(1, 'Write your name').max(MEETING_GUEST_NAME_MAX, `A name can have at most ${MEETING_GUEST_NAME_MAX} characters`);
export const GuestKnockRequest = z.strictObject({ token: LinkSecret, displayName: GuestDisplayName });
export type GuestKnockRequest = z.infer<typeof GuestKnockRequest>;
/** The knock is in: the page waits. The credential is the cookie set with this answer, never the body. */
export const GuestKnockResponse = z.object({ state: z.literal('waiting'), title: z.string(), kind: MeetingKind });
export type GuestKnockResponse = z.infer<typeof GuestKnockResponse>;
export const guestKnockRoute = { method: 'POST', path: '/api/guest-links/knock' } as const satisfies ApiRoute;

/** Where the guest stands, for the page: waiting, in the call, turned away, taken out, gone, or the call has ended (`ended`). */
export const GuestSessionState = z.enum(['waiting', 'admitted', 'denied', 'removed', 'left', 'expired', 'ended']);
export type GuestSessionState = z.infer<typeof GuestSessionState>;
/** A name in the call as a guest sees it: the media identity and the name, nothing else (no avatar, no handle, no e-mail address). */
export const GuestRoomPerson = z.object({ identity: z.string().min(1).max(200), displayName: z.string() });
export type GuestRoomPerson = z.infer<typeof GuestRoomPerson>;
/** `people` is filled only while the guest is let in: the names on the tiles. */
export const GuestSessionResponse = z.object({ state: GuestSessionState, title: z.string(), kind: MeetingKind, displayName: z.string(), people: z.array(GuestRoomPerson).default([]) });
export type GuestSessionResponse = z.infer<typeof GuestSessionResponse>;
export const guestSessionRoute = { method: 'GET', path: '/api/guest/session' } as const satisfies ApiRoute;

/** A media token for an admitted guest: microphone and camera only, the one room, at most ten minutes; asked for again before it runs out. */
export const GuestJoin = z.object({
  provider: z.string().min(1).max(40),
  url: z.string().min(1).max(2000),
  token: z.string().min(1).max(4000),
  identity: z.string().regex(MEETING_GUEST_IDENTITY),
  roomName: z.string().min(1).max(200),
  expiresAt: IsoDateTime,
});
export type GuestJoin = z.infer<typeof GuestJoin>;
/** The names of the people in the call (no avatars, handles or e-mail addresses) and the other guests, for the tiles. */
export const GuestTokenResponse = z.object({
  join: GuestJoin,
  people: z.array(GuestRoomPerson),
});
export type GuestTokenResponse = z.infer<typeof GuestTokenResponse>;
export const guestTokenRoute = { method: 'POST', path: '/api/guest/token' } as const satisfies ApiRoute;

export const GuestOkResponse = z.object({ ok: z.literal(true) });
export type GuestOkResponse = z.infer<typeof GuestOkResponse>;
export const guestLeaveRoute = { method: 'POST', path: '/api/guest/leave' } as const satisfies ApiRoute;
export const guestHeartbeatRoute = { method: 'POST', path: '/api/guest/heartbeat' } as const satisfies ApiRoute;

// ---- the members' side ----------------------------------------------------------------------------------------------------------------------------------

/** Make a guest link of one's own for a live call with guest links on (a reader who may post, not a workspace guest). */
export const MakeGuestLinkResponse = GuestLinkMade;
export type MakeGuestLinkResponse = z.infer<typeof MakeGuestLinkResponse>;
export const makeGuestLinkRoute = { method: 'POST', path: '/api/meetings/:meetingId/guest-links' } as const satisfies ApiRoute;
/** Turn guest links off for the call: every link stops working. Guests already in stay (Remove takes one out). The starter, a lead or an admin. */
export const RevokeGuestLinksResponse = z.object({ revoked: z.number().int().min(0) });
export type RevokeGuestLinksResponse = z.infer<typeof RevokeGuestLinksResponse>;
export const revokeGuestLinksRoute = { method: 'DELETE', path: '/api/meetings/:meetingId/guest-links' } as const satisfies ApiRoute;

/** One guest knocking, as the people in the call see them. */
export const LobbyGuest = z.object({ id: MeetingGuestId, displayName: z.string(), askedAt: IsoDateTime });
export type LobbyGuest = z.infer<typeof LobbyGuest>;
/** Who is waiting to be let in (only for someone in the call). */
export const MeetingLobbyResponse = z.object({ waiting: z.array(LobbyGuest) });
export type MeetingLobbyResponse = z.infer<typeof MeetingLobbyResponse>;
export const meetingLobbyRoute = { method: 'GET', path: '/api/meetings/:meetingId/lobby' } as const satisfies ApiRoute;

export const MeetingGuestPathParams = z.object({ meetingId: MeetingId, guestId: MeetingGuestId });
export type MeetingGuestPathParams = z.infer<typeof MeetingGuestPathParams>;
/** Let a guest in, turn one away, or take one out. Whoever answers first wins; a later answer is 409. */
export const DecideGuestResponse = z.object({ state: MeetingGuestState });
export type DecideGuestResponse = z.infer<typeof DecideGuestResponse>;
export const admitGuestRoute = { method: 'POST', path: '/api/meetings/:meetingId/guests/:guestId/admit' } as const satisfies ApiRoute;
export const denyGuestRoute = { method: 'POST', path: '/api/meetings/:meetingId/guests/:guestId/deny' } as const satisfies ApiRoute;
export const removeGuestRoute = { method: 'POST', path: '/api/meetings/:meetingId/guests/:guestId/remove' } as const satisfies ApiRoute;

/** Pushed to the people in the call (only them) when a guest knocks or a knock is answered: the page asks for the lobby again. */
export const MEETING_LOBBY_PUSH = 'meeting.lobby';
export const MeetingLobbyPush = z.object({ meetingId: MeetingId });
export type MeetingLobbyPush = z.infer<typeof MeetingLobbyPush>;
