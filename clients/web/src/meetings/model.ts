import type { Meeting, MeetingParticipant, MeetingSummary } from '@manythreads/shared';
import { isApiError } from '../api/client';

/*
 * Voice rooms in the page (PLAN P15-04): the plain rules, kept apart from React and from the media library so a test can run them without a browser.
 */

export const NOT_SET_UP_TITLE = 'Voice rooms are not set up on this server';
export const NOT_SET_UP_HELP = 'Ask a workspace admin to connect a media server, then try again.';

/** How often the page tells the server "I am still here" (the server counts a person silent for three minutes as gone). */
export const HEARTBEAT_EVERY_MS = 30_000;
/** A new token is asked for this long before the old one runs out. */
export const RENEW_BEFORE_MS = 90_000;
export const RENEW_MIN_MS = 5_000;
/** The page asks for the list of live rooms again this often, so a lost push heals. */
export const LIVE_POLL_MS = 30_000;
/** After a drop the page tries to get back into the room this many times, with growing gaps. */
export const REJOIN_ATTEMPTS = 6;
/** The sidebar badge draws this many faces, then "+N". */
export const BADGE_FACES = 3;

/** True when the server said "voice rooms are not set up" (HTTP 409 with its plain message) or the media status says so. */
export function isNotConfigured(err: unknown): boolean {
  return isApiError(err) && err.status === 409 && /not set up/i.test(err.message);
}

/** The words for a failed start, join or token call: the server's own plain message when it sent one. */
export function startFailure(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 403) return 'You cannot start or join a voice room here.';
    if (err.status === 404) return 'That voice room is not available any more.';
    if (err.status === 429) return 'You started several voice rooms in a short time. Try again in a minute.';
    return err.message;
  }
  return 'Could not start the voice room. Try again.';
}

/** Live rooms by the channel they belong to. A room with no channel is not shown in the sidebar. */
export function liveByChannel(rooms: readonly MeetingSummary[]): ReadonlyMap<string, MeetingSummary> {
  const out = new Map<string, MeetingSummary>();
  for (const r of rooms) {
    if (r.meeting.state !== 'live' || r.meeting.channelId === null) continue;
    if (!out.has(r.meeting.channelId)) out.set(r.meeting.channelId, r);
  }
  return out;
}

/** The faces of the sidebar badge: the first few, and how many more there are. */
export function badgeFaces<T>(present: readonly T[], max = BADGE_FACES): { faces: T[]; more: number } {
  return { faces: present.slice(0, max), more: Math.max(0, present.length - max) };
}

/** "3 people in a voice room" for a screen reader. */
export function liveLabel(room: MeetingSummary, what: 'channel' | 'conversation' = 'channel'): string {
  const n = room.present.length;
  const where = what === 'channel' ? 'voice room' : 'call';
  return n === 0 ? `A ${where} is open` : n === 1 ? `1 person in a ${where}` : `${n} people in a ${where}`;
}

/** How long a call has lasted: 4:05, or 1:02:09 past the hour. */
export function callClock(startedAtIso: string, nowMs: number): string {
  const started = Date.parse(startedAtIso);
  const total = Number.isNaN(started) ? 0 : Math.max(0, Math.floor((nowMs - started) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Milliseconds until the token should be renewed (a minute and a half before it runs out, never sooner than five seconds from now). */
export function renewDelay(expiresAtIso: string, nowMs: number): number {
  const at = Date.parse(expiresAtIso);
  if (Number.isNaN(at)) return RENEW_MIN_MS;
  return Math.max(RENEW_MIN_MS, at - RENEW_BEFORE_MS - nowMs);
}

/** The wait before try number `attempt` (0 is the first) of getting back into the room: 1 s, 2 s, 4 s … at most 15 s. */
export function rejoinDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));
}

// ---- the key that mutes ------------------------------------------------------------------------------------------------------------------------------
export type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/** Ctrl+Shift+Space on Windows and Linux, Cmd+Shift+Space on a Mac. */
export function isMuteShortcut(e: KeyLike): boolean {
  const space = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  return space && e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey);
}

/** The element is a place where typing happens (a text box, a select, or anything editable): Space there is a space, not a push-to-talk. */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  const role = t.getAttribute?.('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

/** Push-to-talk: holding Space (outside a text box or a button) opens the microphone. */
export function isPushToTalkKey(e: Pick<KeyLike, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, target: Parameters<typeof isTypingTarget>[0]): boolean {
  const space = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  if (!space || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (isTypingTarget(target)) return false;
  const tag = (target?.tagName ?? '').toLowerCase();
  return tag !== 'button' && tag !== 'a';
}

// ---- who is in the room ------------------------------------------------------------------------------------------------------------------------------
export type RosterEntry = {
  actorId: string;
  personId: string;
  name: string;
  speaking: boolean;
  me: boolean;
  /** The person's answer to "Transcribe my voice" while transcription is on. */
  consent: MeetingParticipant['consentTranscribe'];
};

/** The people in the room now, me first, then those speaking, then by the time they came in. */
export function rosterOf(present: readonly MeetingParticipant[], speaking: ReadonlySet<string>, myActorId: string | null): RosterEntry[] {
  return [...present]
    .filter((p) => p.leftAt === null)
    .map<RosterEntry>((p) => ({
      actorId: p.actorId,
      personId: p.personId,
      name: p.displayName,
      speaking: speaking.has(p.actorId),
      me: p.actorId === myActorId,
      consent: p.consentTranscribe,
    }))
    .sort((a, b) => Number(b.me) - Number(a.me) || Number(b.speaking) - Number(a.speaking) || 0);
}

/** Who joined or left between two lists of the people present (by actor id): the sounds to play. */
export function presenceChange(before: readonly string[], after: readonly string[], myActorId: string | null): { joined: string[]; left: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    joined: after.filter((id) => !b.has(id) && id !== myActorId),
    left: before.filter((id) => !a.has(id) && id !== myActorId),
  };
}

// ---- the ring ----------------------------------------------------------------------------------------------------------------------------------------
export type Ring = { meetingId: string; channelId: string; callerActorId: string; callerName: string; until: number };

/** What is still ringing at `now`: a call that was answered, joined or ended elsewhere stops; so does one past its thirty seconds. */
export function activeRings(rings: readonly Ring[], now: number, skip: ReadonlySet<string>): Ring[] {
  return rings.filter((r) => r.until > now && !skip.has(r.meetingId));
}

export const ringText = (r: Pick<Ring, 'callerName'>): string => `${r.callerName} is calling you`;

// ---- small helpers -----------------------------------------------------------------------------------------------------------------------------------
export function meetingTitleOf(m: Pick<Meeting, 'title'>): string {
  return m.title;
}
