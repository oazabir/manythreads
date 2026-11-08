import type { Meeting, MeetingCaption, MeetingNotetaker, MeetingParticipant, MeetingRecordingState, MeetingSummary, ListMeetingNotetakersResponse } from '@manythreads/shared';
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

// ---- captions (P15-08) -------------------------------------------------------------------------------------------------------------------------------
/** One caption as the page keeps it: the push's caption, a key that stays the same while a partial line grows into its final line, and when it arrived. */
export type CaptionLine = {
  key: string;
  kind: MeetingCaption['kind'];
  speakerId: string;
  speakerName: string;
  text: string;
  final: boolean;
  catchingUp: boolean;
  askerName: string | null;
  startMs: number;
  endMs: number;
  /** When the page got it (the page's clock), to let it fade from the strip. */
  at: number;
};

/** How many captions the page remembers, how many the strip shows, and how long one stays on the strip after the last change. */
export const CAPTION_KEEP = 40;
export const CAPTION_SHOW = 2;
export const CAPTION_FADE_MS = 8000;

/**
 * Folds a push into the lines already kept: a speaker's growing partial line is replaced by their next partial or final line (it keeps its key), a final line that
 * is already there is not added twice, and an empty line is ignored. Only the newest `keep` lines stay.
 */
export function mergeCaptions(prev: readonly CaptionLine[], incoming: readonly MeetingCaption[], at: number, keep = CAPTION_KEEP): CaptionLine[] {
  const out = [...prev];
  incoming.forEach((c, i) => {
    if (c.text.trim() === '') return;
    const base = { kind: c.kind, speakerId: c.speakerId as string, speakerName: c.speakerName, text: c.text, final: c.final, catchingUp: c.catchingUp, askerName: c.askerName, startMs: c.startMs, endMs: c.endMs, at };
    let open = -1;
    for (let j = out.length - 1; j >= 0; j--) {
      const l = out[j]!;
      if (l.speakerId === base.speakerId && l.kind === base.kind && !l.final) {
        open = j;
        break;
      }
    }
    if (open >= 0) {
      out[open] = { ...base, key: out[open]!.key };
      return;
    }
    if (c.final && out.some((l) => l.final && l.speakerId === base.speakerId && l.startMs === base.startMs && l.endMs === base.endMs && l.text === base.text)) return;
    out.push({ ...base, key: `${at}-${i}-${base.speakerId}` });
  });
  return out.slice(-keep);
}

/** The lines the strip draws: the newest few that have not faded. */
export function visibleCaptions(lines: readonly CaptionLine[], now: number, max = CAPTION_SHOW, fadeMs = CAPTION_FADE_MS): CaptionLine[] {
  return lines.filter((l) => now - l.at <= fadeMs).slice(-max);
}

/** Who a caption is from: "You", a person's name, or for the note-taker's answer "<bot> answered <asker>". */
export function captionHeading(line: Pick<CaptionLine, 'kind' | 'speakerId' | 'speakerName' | 'askerName'>, myActorId: string | null): string {
  const who = line.speakerId === myActorId ? 'You' : line.speakerName;
  if (line.kind === 'answer') return line.askerName ? `${who} answered ${line.askerName}` : `${who} answered`;
  return who;
}

/** A time inside the call: 4:05, or 1:02:09 past the hour. */
export function msClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The plain reason a correction was refused. */
export function correctionFailure(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 403 || err.status === 409) return 'You can correct your own lines for 24 hours after you said them.';
    if (err.status === 404) return 'That line is not there any more.';
  }
  return 'Could not save the correction. Try again.';
}

/** What the strip says when there are no captions to show yet. */
export function captionsEmptyText(transcriptionOn: boolean, notetaker: boolean): string {
  if (!transcriptionOn) return 'Captions show here when transcription is on.';
  return notetaker ? 'The note-taker is listening. Captions show here as people speak.' : 'Captions show here as people speak.';
}

// ---- the note-taker (P15-18) -------------------------------------------------------------------------------------------------------------------------
export const NOTETAKER_NONE_TEXT = 'This team has no note-taker yet. A team lead can add one.';
export const NOTETAKER_BUSY_TEXT = 'The note-taker is not available in this room right now.';

/** The words under the note-taker's face. */
export function notetakerBadge(n: Pick<MeetingNotetaker, 'listening'>): string {
  return n.listening ? 'Note-taker · listening' : 'Note-taker · joining';
}

/** Why "Add note-taker" is switched off, or null when it may be used. */
export function notetakerReason(res: Pick<ListMeetingNotetakersResponse, 'bots' | 'current' | 'canAdd' | 'reason'> | null): string | null {
  if (!res) return NOTETAKER_BUSY_TEXT;
  if (res.current) return null;
  if (!res.canAdd) return res.reason && res.reason !== '' ? res.reason : NOTETAKER_BUSY_TEXT;
  if (res.bots.length === 0) return NOTETAKER_NONE_TEXT;
  return null;
}

/** The organizer, or a lead of the team, may take the note-taker out. */
export function canRemoveNotetaker(meeting: Pick<Meeting, 'organizerId' | 'startedBy'>, myActorId: string | null, canModerate: boolean): boolean {
  return canModerate || (myActorId !== null && (meeting.organizerId === myActorId || meeting.startedBy === myActorId));
}

// ---- recording (P15-15) ------------------------------------------------------------------------------------------------------------------------------
export type RecordingChip = { label: string; tone: 'rec' | 'wait'; title: string };

/** People in the room who have not said yes to being recorded. */
export function recordingWaitingOn(present: readonly MeetingParticipant[]): number {
  return present.filter((p) => p.leftAt === null && p.consentRecord !== 'yes').length;
}

/** The chip for the whole call while recording is on; null while it is off. */
export function recordingChip(rec: Pick<MeetingRecordingState, 'on' | 'recording'> | null, present: readonly MeetingParticipant[]): RecordingChip | null {
  if (!rec || !rec.on) return null;
  if (rec.recording) return { label: 'Recording', tone: 'rec', title: 'Everyone in the room said yes. Each person’s voice is being saved as a sound file.' };
  const n = recordingWaitingOn(present);
  return {
    label: n === 1 ? 'Recording: waiting for 1 person' : n > 1 ? `Recording: waiting for ${n} people` : 'Recording: getting ready',
    tone: 'wait',
    title: 'Nothing is saved yet. Recording starts when everyone in the room has said yes, and stops when someone who has not joins.',
  };
}

export type RecordConsentPlan = 'none' | 'ask' | 'settled';

/** Ask "Record my voice?" when recording is on and the person has not answered. */
export function planRecordConsent(rec: Pick<MeetingRecordingState, 'on' | 'yourConsent'> | null): RecordConsentPlan {
  if (!rec || !rec.on) return 'none';
  return rec.yourConsent === 'unasked' ? 'ask' : 'settled';
}

/** The words of the recording question: what yes and no mean. */
export function recordPromptCopy(): { title: string; body: string; yes: string; no: string } {
  return {
    title: 'Record my voice?',
    body: 'Recording was turned on for this call. If you say yes, your voice is saved as a sound file in this channel’s Files, for the people who can read the channel. Nothing is saved unless everyone in the room says yes, and it stops the moment someone who has not said yes joins. If you say no, nothing of your voice is saved and recording stays off.',
    yes: 'Yes, record my voice',
    no: 'No, do not record me',
  };
}

/** Why the record button is off, or null when it works. */
export function recordingReason(rec: Pick<MeetingRecordingState, 'cap' | 'reason'> | null): string | null {
  if (!rec) return null;
  if (rec.cap === 'off') return 'Recording is switched off for this workspace. A workspace admin can turn it on.';
  return rec.reason && rec.reason !== '' ? rec.reason : null;
}

/** Whether the call bar draws a record button at all: only where the workspace allows recording, or while the room is already recording. */
export function showsRecordButton(rec: Pick<MeetingRecordingState, 'cap' | 'on'> | null): boolean {
  return !!rec && (rec.cap === 'on' || rec.on);
}

/** The words for a refused note-taker or recording change. */
export function changeFailure(err: unknown, what: string): string {
  if (isApiError(err)) {
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.message !== '' && err.status >= 400 && err.status < 500) return err.message;
  }
  return `Could not ${what}. Try again.`;
}
