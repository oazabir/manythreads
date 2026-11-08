import type { GetMeetingTranscriptResponse, MeetingNoteItem, MeetingNotes, MeetingOverview } from '@manythreads/shared';
import { isApiError } from '../../api/client';

/*
 * The plain rules and words of the meeting page (PLAN P15-20), kept apart from React so a test can read them. Nothing here touches the network.
 */

type Line = GetMeetingTranscriptResponse['lines'][number];

/** A time on the meeting clock as a person reads it: `12:04`, or `1:02:03` once past the hour. */
export function clockWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** How long a meeting ran. A live one has no length yet. */
export function lengthWords(seconds: number | null): string {
  if (seconds === null) return 'Still going';
  if (seconds < 60) return 'Under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export const peopleWords = (n: number): string => (n === 1 ? '1 person' : `${n} people`);

/** `?t=<ms>` as a time on the meeting clock, or null when it is not a whole number of at least zero. */
export function parseJump(raw: string | null): number | null {
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

/** The tab a meeting page shows: the transcript when the address points at a moment (`?t=`, also when it changes while the page is open), else the one the reader is on. */
export const tabFor = (mark: number | null, current: 'notes' | 'transcript'): 'notes' | 'transcript' => (mark === null ? current : 'transcript');

/** The line a jump lands on: the last one that starts at or before the time, else the first one. -1 when there are no lines. */
export function lineAt(lines: readonly Pick<Line, 'startMs'>[], ms: number): number {
  if (lines.length === 0) return -1;
  let found = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && line.startMs <= ms) found = i;
  }
  return found === -1 ? 0 : found;
}

/** Consecutive lines by one speaker read as one block under one name. */
export function runsOf<T extends { speakerId: string }>(lines: readonly T[]): { speakerId: string; lines: { line: T; index: number }[] }[] {
  const out: { speakerId: string; lines: { line: T; index: number }[] }[] = [];
  lines.forEach((line, index) => {
    const last = out.at(-1);
    if (last && last.speakerId === line.speakerId) last.lines.push({ line, index });
    else out.push({ speakerId: line.speakerId, lines: [{ line, index }] });
  });
  return out;
}

/**
 * Whether a person reads the transcript through the organizer's own copy. A note-taker meeting keeps its files in the organizer's Personal space, so anyone else (a person
 * the notes were shared with) goes through `copy=organizer`; every other place is read as the room's own transcript.
 */
export const readsOrganizerCopy = (o: Pick<MeetingOverview, 'location' | 'you'>): boolean => o.location === 'personal' && !o.you.isOrganizer;

// ---- items ------------------------------------------------------------------------------------------------------------------------------------------
export const decisionsOf = (items: readonly MeetingNoteItem[]): MeetingNoteItem[] => items.filter((i) => i.kind === 'decision');
export const actionsOf = (items: readonly MeetingNoteItem[]): MeetingNoteItem[] => items.filter((i) => i.kind === 'action');
export const questionsOf = (items: readonly MeetingNoteItem[]): MeetingNoteItem[] => items.filter((i) => i.kind === 'question');

/** "Decisions 2" / "Action items 3": a heading with its count. */
export const headingWithCount = (name: string, n: number): string => `${name} ${n}`;

const DUE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** A due day (`YYYY-MM-DD`) in words. */
export function dueWords(due: string): string {
  const d = new Date(`${due}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? due : DUE.format(d);
}

/** Who an action item is for, and by when: "Rafi, by 12 Nov 2026" or "No owner". */
export function ownerLine(item: Pick<MeetingNoteItem, 'ownerName' | 'due'>): string {
  const who = item.ownerName ?? 'No owner';
  return item.due ? `${who}, by ${dueWords(item.due)}` : who;
}

/** The card an action item becomes on a board: the words, then where it came from, who and by when. */
export function boardCardOf(item: MeetingNoteItem, meetingTitle: string): { title: string; description: string } {
  const lines = [
    `From the meeting “${meetingTitle}”, at ${clockWords(item.atMs)}.`,
    item.ownerName ? `Owner: ${item.ownerName}` : 'Owner: no owner',
    item.due ? `Due: ${item.due}` : null,
  ].filter((l): l is string => l !== null);
  return { title: item.text.slice(0, 200), description: lines.join('\n').slice(0, 8000) };
}

/** Which action items were already turned into cards in this browser (a per-viewer convenience; the server does not record it). */
export const cardKey = (meetingId: string): string => `manythreads.meeting-cards.${meetingId}`;
export const itemKey = (item: Pick<MeetingNoteItem, 'text' | 'atMs'>): string => `${item.atMs}:${item.text.slice(0, 80)}`;

// ---- notes ------------------------------------------------------------------------------------------------------------------------------------------
/** True when the notes have nothing the page could draw as a list, so the markdown itself is shown. */
export const showsMarkdownOnly = (n: Pick<MeetingNotes, 'summary' | 'items' | 'notesMd'>): boolean => n.summary.trim() === '' && n.items.length === 0 && n.notesMd.trim() !== '';

export const NOTES_PENDING = 'The notes are being written. This takes a minute or two after the call ends.';
export const NOTES_FAILED = 'The notes could not be written this time. The transcript is still there.';
export const NOTES_CHANGED = 'Someone changed these notes while you were editing. Your words are still in the box. Copy them, reload the page and edit again.';
export const SAVED_ALREADY = 'These notes were already saved to the team.';

/** The words for a failed read: the server's own plain sentence when it sent one. */
export function readFailure(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 404) return 'This meeting is not available. It may not exist, or you may not have access to it.';
    if (err.status === 403) return 'You do not have access to this meeting.';
    if (err.status === 501) return 'This is not available on this server yet.';
    return err.message;
  }
  return 'Could not load this meeting. Try again.';
}

/** The words for a failed action (share, save, send): the server's own sentence for a refusal, else a plain fallback. */
export function actionFailure(err: unknown, fallback: string): string {
  if (isApiError(err)) {
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 403) return 'You do not have permission to do that.';
    if (err.status === 501) return 'This is not available on this server yet.';
    if (err.status === 409 || err.status === 400 || err.status === 404) return err.message || fallback;
  }
  return fallback;
}

export const isConflict = (err: unknown): boolean => isApiError(err) && err.status === 409;
export const isMissing = (err: unknown): boolean => isApiError(err) && err.status === 404;

// ---- the Files hook ---------------------------------------------------------------------------------------------------------------------------------
/**
 * Whether a path in the Files screen sits inside a meeting's folder, and so may have a meeting to open. Team repo: `meetings/<yyyy>/<mm>/<folder>`; a private channel or a
 * direct message in Files storage: `channels/<name>/meetings/<folder>`; the organizer's Personal space: `Meetings/<folder>`. Folders above those (the year, `meetings/`
 * itself) belong to many meetings, so they have nothing to open.
 */
export function meetingFolderPath(path: string, personal: boolean): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  const lower = (s: string | undefined): string => (s ?? '').toLowerCase();
  if (personal) return lower(parts[0]) === 'meetings' && parts.length >= 2 ? path : null;
  if (lower(parts[0]) === 'meetings' && parts.length >= 4) return path;
  if (lower(parts[0]) === 'channels' && lower(parts[2]) === 'meetings' && parts.length >= 4) return path;
  return null;
}

// ---- sharing ----------------------------------------------------------------------------------------------------------------------------------------
type Share = { id: string; revokedAt: string | null; grantee: { kind: 'person'; personId: string; displayName: string } | { kind: 'channel'; channelId: string; channelName: string | null } };

/** The shares still in force (a taken-back share stays on the server as a row, but is not shown). */
export const liveShares = <T extends Pick<Share, 'revokedAt'>>(shares: readonly T[]): T[] => shares.filter((s) => s.revokedAt === null);

/** Who a share is for, in words: a person's name, or "# channel". */
export function granteeWords(g: Share['grantee']): string {
  return g.kind === 'person' ? g.displayName : g.channelName ? `# ${g.channelName}` : 'A channel';
}

/** People who may still be picked: not the picker, and not someone already shared with. */
export function personChoices<T extends { personId: string }>(everyone: readonly T[], shares: readonly Pick<Share, 'revokedAt' | 'grantee'>[], selfPersonId: string): T[] {
  const taken = new Set(liveShares(shares).flatMap((s) => (s.grantee.kind === 'person' ? [s.grantee.personId] : [])));
  return everyone.filter((p) => p.personId !== selfPersonId && !taken.has(p.personId));
}

/** Channels that may still be picked: not one already shared with. */
export function channelChoices<T extends { id: string }>(all: readonly T[], shares: readonly Pick<Share, 'revokedAt' | 'grantee'>[]): T[] {
  const taken = new Set(liveShares(shares).flatMap((s) => (s.grantee.kind === 'channel' ? [s.grantee.channelId] : [])));
  return all.filter((c) => !taken.has(c.id));
}

export const SHARE_EXPLAINED =
  'People you share with can read the notes and the transcript. Their access is checked each time they open them, so someone who leaves the team can no longer read them. You can stop sharing at any time.';

// ---- save to team -----------------------------------------------------------------------------------------------------------------------------------
export const SAVE_EXPLAINED = 'This copies the notes and the transcript into the team’s meeting notes, where everyone on the team can read them. The copy is made in your name.';
export const MEMORY_WARNING = 'Adding them to the team’s memory means the team’s bots can recall what was said. Only the words of people who agreed to be transcribed are included.';
