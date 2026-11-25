import type { ActionItemView, Appointment, Approval, DirectMessageSummary, MeetingSummary, NavChannelGroup, Notification, ThreadInboxItem } from '@manythreads/shared';
import { approvalLine } from '../approvals/sentence';
import { dueLabel } from '../files/actionItems/actionItemsWords';
import { addDays, joinable, sameDay, startOfDay } from '../schedule/calendar';
import { channelLabel } from '../threadCard';

/*
 * The rules of the Summaries page (P37-06, docs/plans/summaries.md): which rows each card shows, in which order, and the words around them ("2 hours ago", "In 25 min").
 * Everything here is pure: the page passes in what it read and the clock, so each rule is tested without a screen. A card shows at most `CARD_ROWS` rows and says how many more
 * there are; the page reads each source on its own, so a source that fails only empties its own card.
 */

/** The most rows a card draws; the rest is behind its "See all" link. */
export const CARD_ROWS = 5;
/** The most chips in "Keep going". */
export const CHIPS = 8;

/** What a row's small mark shows: the kind of thing, or the face of the person who wrote (`avatar`). */
export type RowKind = 'action' | 'approval' | 'meeting' | 'thread' | 'note' | 'event' | 'live';

/** A small tag at the end of a row. `urgent` is the warm colour (late, or waiting a long time), `live` the green one. */
export interface RowTag {
  text: string;
  tone: 'urgent' | 'soon' | 'info' | 'live';
}

/** One row of a card: a title line, one muted line under it, and where a press leads. */
export interface DigestRow {
  key: string;
  kind: RowKind;
  title: string;
  meta: string;
  to: string;
  tag?: RowTag;
  /** Who the row is from; the row draws their picture instead of the kind's mark. */
  avatar?: { actorId: string; name: string };
}

/** The rows a card draws and how many it holds in all. */
export interface Trimmed<T> {
  shown: T[];
  total: number;
  more: number;
}

export function trim<T>(items: readonly T[], max: number = CARD_ROWS): Trimmed<T> {
  const shown = items.slice(0, Math.max(0, max));
  return { shown, total: items.length, more: Math.max(0, items.length - shown.length) };
}

// ---- words ----------------------------------------------------------------------------------------------------------------------

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "2 weeks ago", then the date ("12 Nov"). A time in the future reads "just now". */
export function agoWords(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const ms = now.getTime() - t;
  if (ms < MS.minute) return 'just now';
  if (ms < MS.hour) return `${plural(Math.floor(ms / MS.minute), 'minute')} ago`;
  if (ms < MS.day) return `${plural(Math.floor(ms / MS.hour), 'hour')} ago`;
  const days = Math.floor((startOfDay(now).getTime() - startOfDay(new Date(t)).getTime()) / MS.day);
  if (days <= 1) return 'yesterday';
  if (days < 14) return `${plural(days, 'day')} ago`;
  if (days < 60) return `${plural(Math.floor(days / 7), 'week')} ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(t));
}

/** "Good morning", "Good afternoon" or "Good evening" by the hour of the person's own clock. */
export function dayGreeting(now: Date): string {
  const h = now.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** "Wednesday 25 November": the date line under the page title. */
export function dateLine(now: Date, locale?: string): string {
  const f = (o: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(locale, o).format(now);
  return `${f({ weekday: 'long' })} ${f({ day: 'numeric', month: 'long' })}`;
}

const clockOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** When a meeting is, in the person's own time: "Today 15:00 – 15:30", "Tomorrow 09:00 – 09:45", "Thu 26 Nov 09:00 – 09:45". */
export function whenRange(startsAt: string, endsAt: string, now: Date, locale?: string): string {
  const start = new Date(startsAt);
  const span = `${clockOf(startsAt)} – ${clockOf(endsAt)}`;
  if (sameDay(start, now)) return `Today ${span}`;
  if (sameDay(start, addDays(now, 1))) return `Tomorrow ${span}`;
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(start);
  return `${day} ${span}`;
}

/** The tag of a meeting that has not ended: "Live now" once it has begun, "Starting now" under a minute, "In 25 min", "In 2 h"; nothing when it is further off than that. */
export function startsIn(startsAt: string, endsAt: string, now: Date): RowTag | null {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const t = now.getTime();
  if (t >= end) return null;
  if (t >= start) return { text: 'Live now', tone: 'live' };
  const min = Math.ceil((start - t) / MS.minute);
  if (min <= 1) return { text: 'Starting now', tone: 'soon' };
  if (min < 60) return { text: `In ${min} min`, tone: 'soon' };
  if (min < 12 * 60) return { text: `In ${Math.round(min / 60)} h`, tone: 'info' };
  return null;
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A thread's place, as a person says it: "#dev", "Direct message". */
const placeOf = (channel: ThreadInboxItem['channel']): string => {
  const label = channelLabel(channel);
  return channel.kind === 'dm' || channel.kind === 'bot_conversation' || label === '' ? label || 'Conversation' : `#${label}`;
};

// ---- 1. needs your attention ----------------------------------------------------------------------------------------------------

/** How urgent a row is, lowest first: a request waiting over a day and a late item lead, an item with no date is last. */
type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface Ranked {
  row: DigestRow;
  rank: Rank;
  /** Ties inside a rank: earlier first (the due day, or the moment it began to wait). */
  at: number;
}

export interface AttentionInput {
  slug: string;
  now: Date;
  /** `YYYY-MM-DD` in the person's calendar. */
  today: string;
  actionItems: readonly ActionItemView[];
  approvals: readonly Approval[];
  /** The person's unread notifications of the kind "gave you action items" (a meeting's list). */
  meetingNotes: readonly Notification[];
}

export interface Attention {
  rows: Trimmed<DigestRow>;
  /** "1 late, 2 requests to answer" or "". */
  summary: string;
  /** How many of each source, for the card's "See all" links. */
  counts: { actionItems: number; approvals: number; meetings: number };
}

/** Approvals only count when the person may decide them: one that waits on someone else is not theirs to answer. */
export const approvalsForMe = (approvals: readonly Approval[]): Approval[] => approvals.filter((a) => a.status === 'pending' && a.canDecide);

/** Open action items, requests waiting for the person and meeting notes, in one list: late and long-waiting first, undated last. */
export function attention(input: AttentionInput): Attention {
  const { slug, now, today } = input;
  const out: Ranked[] = [];
  let late = 0;
  let dueToday = 0;
  for (const a of input.actionItems) {
    if (a.done) continue;
    const due = a.due === null ? null : dueLabel(a.due, today);
    const rank: Rank = due === null ? 6 : due.overdue ? 1 : a.due === today ? 2 : 5;
    if (rank === 1) late += 1;
    if (rank === 2) dueToday += 1;
    out.push({
      rank,
      at: a.due === null ? Number.MAX_SAFE_INTEGER : Date.parse(`${a.due}T00:00:00Z`),
      row: {
        key: `action:${a.id}`,
        kind: 'action',
        title: clip(a.what, 140),
        meta: [due?.text ?? 'No date', a.source ? clip(a.source, 60) : ''].filter(Boolean).join(' · '),
        to: '/account/action-items',
        ...(rank <= 2 ? { tag: { text: rank === 1 ? 'Late' : 'Today', tone: rank === 1 ? ('urgent' as const) : ('soon' as const) } } : {}),
      },
    });
  }
  const mine = approvalsForMe(input.approvals);
  for (const a of mine) {
    const waited = now.getTime() - Date.parse(a.createdAt);
    const long = waited > MS.day;
    out.push({
      rank: long ? 0 : 3,
      at: Date.parse(a.createdAt),
      row: {
        key: `approval:${a.id}`,
        kind: 'approval',
        title: approvalLine(a),
        meta: `Asked ${agoWords(a.createdAt, now)}`,
        to: `/t/${encodeURIComponent(slug)}/approvals?approval=${encodeURIComponent(a.id)}`,
        ...(long ? { tag: { text: 'Over a day', tone: 'urgent' as const } } : { tag: { text: 'Your answer', tone: 'info' as const } }),
      },
    });
  }
  for (const n of input.meetingNotes) {
    out.push({
      rank: 4,
      at: Date.parse(n.createdAt),
      row: {
        key: `meeting:${n.id}`,
        kind: 'meeting',
        title: `${n.actorName} gave you action items`,
        meta: `${clip(n.preview, 100)} · ${agoWords(n.createdAt, now)}`,
        to: `/meetings/${encodeURIComponent(String(n.refId))}`,
        tag: { text: 'From a meeting', tone: 'info' },
      },
    });
  }
  out.sort((a, b) => a.rank - b.rank || a.at - b.at);
  const parts = [
    late > 0 ? `${late} late` : '',
    dueToday > 0 ? `${dueToday} due today` : '',
    mine.length > 0 ? plural(mine.length, 'request') + ' to answer' : '',
  ].filter(Boolean);
  return {
    rows: trim(out.map((o) => o.row)),
    summary: parts.join(', '),
    counts: { actionItems: input.actionItems.filter((a) => !a.done).length, approvals: mine.length, meetings: input.meetingNotes.length },
  };
}

// ---- 2. waiting on your reply ---------------------------------------------------------------------------------------------------

/**
 * The threads that wait on the person. The ones where somebody named them and they have not answered come first, the one waiting longest on top (as the Threads page does);
 * then the threads with new replies, the newest first. A thread the person is up to date on and nobody asked anything in is left out.
 */
export function waitingThreads(items: readonly ThreadInboxItem[], slug: string, now: Date): Trimmed<DigestRow> {
  const asked = items.filter((i) => i.mention).sort((a, b) => Date.parse(a.mention?.at ?? a.lastReplyAt) - Date.parse(b.mention?.at ?? b.lastReplyAt));
  const unread = items.filter((i) => !i.mention && i.unreadCount > 0).sort((a, b) => Date.parse(b.lastReplyAt) - Date.parse(a.lastReplyAt));
  const rows = [...asked, ...unread].map((i): DigestRow => {
    const m = i.mention ?? null;
    const since = m?.at ?? i.lastReplyAt;
    const who = m ? m.authorName : (i.lastReply?.authorName ?? i.rootAuthor?.displayName ?? '');
    const what = m ? 'asked for you' : i.unreadCount === 1 ? 'wrote a reply' : `wrote ${i.unreadCount} replies`;
    const authorId = m?.authorId ?? i.lastReply?.authorId;
    return {
      key: `thread:${i.rootMessageId}`,
      kind: 'thread',
      title: clip(i.title || 'Untitled thread', 140),
      meta: [placeOf(i.channel), who ? `${who} ${what}` : '', agoWords(since, now)].filter(Boolean).join(' · '),
      to: `/t/${encodeURIComponent(slug)}/threads?thread=${encodeURIComponent(i.rootMessageId)}`,
      ...(m ? { tag: { text: 'Your reply', tone: Date.parse(since) < now.getTime() - MS.day ? ('urgent' as const) : ('soon' as const) } } : { tag: { text: `${i.unreadCount} new`, tone: 'info' as const } }),
      ...(authorId && who ? { avatar: { actorId: authorId, name: who } } : {}),
    };
  });
  return trim(rows);
}

// ---- 3. recent activity ---------------------------------------------------------------------------------------------------------

/** Where a notification leads. A meeting's list opens the meeting; a planned meeting its panel on the Schedule; any message goes through `/open`, which checks the person may read it. */
export function notificationPath(n: Notification, slug: string): string {
  if (n.refType === 'meeting') return `/meetings/${encodeURIComponent(String(n.refId))}`;
  if (n.kind === 'appointment_soon' || n.kind === 'appointment_invite') return `/t/${encodeURIComponent(slug)}/schedule?appointment=${encodeURIComponent(String(n.refId))}`;
  const message = n.kind === 'meeting_invite' ? n.threadRootId : n.refId;
  if (!message) return `/t/${encodeURIComponent(slug)}/activity`;
  const p = new URLSearchParams({ channel: n.channelId, message: String(message) });
  if (n.threadRootId && n.kind !== 'meeting_invite') p.set('root', n.threadRootId);
  return `/open?${p.toString()}`;
}

/** The notifications this card leaves to others: background news (a message in a channel set to "everything") and a meeting's list (that is in the first card). */
const ELSEWHERE: ReadonlySet<Notification['kind']> = new Set(['message', 'meeting_actions']);

export interface ActivityInput {
  slug: string;
  now: Date;
  items: readonly Notification[];
  /** The threads the second card already shows: a notification about one of them is not drawn twice. */
  shownRoots: ReadonlySet<string>;
  /** The line a notification makes ("Nadia replied in a thread in #dev"); the page passes the bell's own words. */
  titleOf: (n: Notification) => string;
}

/** What is new for the person and has not been read: mentions, replies, direct messages and invitations, newest first. */
export function recentActivity(input: ActivityInput): Trimmed<DigestRow> {
  const rows = input.items
    .filter((n) => n.readAt === null && !ELSEWHERE.has(n.kind))
    .filter((n) => !input.shownRoots.has(String(n.threadRootId ?? n.refId)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(
      (n): DigestRow => ({
        key: `note:${n.id}`,
        kind: 'note',
        title: input.titleOf(n),
        meta: [n.preview ? `“${clip(n.preview, 100)}”` : '', agoWords(n.createdAt, input.now)].filter(Boolean).join(' · '),
        to: notificationPath(n, input.slug),
        avatar: { actorId: n.actorId, name: n.actorName },
      }),
    );
  return trim(rows);
}

// ---- 4. up next -----------------------------------------------------------------------------------------------------------------

export interface UpNextRow extends DigestRow {
  /** The meeting's id: its Join button asks for this appointment. */
  appointmentId?: string;
  /** A call already going in a room: its Join button joins it. */
  room?: { meetingId: string; channelId: string | null };
  /** Join is offered now (from ten minutes before). */
  joinable: boolean;
}

export interface UpNextInput {
  slug: string;
  now: Date;
  appointments: readonly Appointment[];
  /** The calls going now that the person may join (any team's or none). */
  rooms: readonly MeetingSummary[];
  /** The person's own id, left out of "with …". */
  selfPersonId: string | null;
  /** More than one team on the schedule: the row names the team. */
  manyTeams: boolean;
  /** Only rooms of this team (or of no team) are shown; null shows every room. */
  teamId: string | null;
  /** Where a room's channel, direct message or meeting space is; null when it is not known (the row then opens the Schedule). */
  roomPath: (channelId: string) => string | null;
}

const withWords = (a: Appointment, selfPersonId: string | null): string => {
  const names = a.invited.filter((p) => p.personId !== selfPersonId).map((p) => p.name);
  if (names.length === 0) return '';
  return names.length <= 2 ? `with ${names.join(' and ')}` : `with ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
};

/** Calls going now first, then the meetings that have not ended, soonest first, over the next seven days. */
export function upNext(input: UpNextInput): Trimmed<UpNextRow> {
  const { now, slug } = input;
  const t = now.getTime();
  const horizon = addDays(startOfDay(now), 7).getTime();
  const liveIds = new Set(input.appointments.filter((a) => a.liveMeetingId).map((a) => String(a.liveMeetingId)));
  const rooms = input.rooms
    .filter((r) => r.meeting.state === 'live' && !liveIds.has(String(r.meeting.id)))
    .filter((r) => input.teamId === null || r.meeting.teamId === null || r.meeting.teamId === input.teamId)
    .sort((a, b) => Date.parse(a.meeting.startedAt) - Date.parse(b.meeting.startedAt))
    .map(
      (r): UpNextRow => ({
        key: `room:${r.meeting.id}`,
        kind: 'live',
        title: r.meeting.title,
        meta: r.present.length === 0 ? 'The call is open' : `${r.present.length === 1 ? '1 person' : `${r.present.length} people`} in the call: ${r.present.slice(0, 3).map((p) => p.displayName).join(', ')}${r.present.length > 3 ? '…' : ''}`,
        to: (r.meeting.channelId ? input.roomPath(String(r.meeting.channelId)) : null) ?? `/t/${encodeURIComponent(slug)}/schedule`,
        tag: { text: 'Live now', tone: 'live' },
        room: { meetingId: String(r.meeting.id), channelId: r.meeting.channelId ? String(r.meeting.channelId) : null },
        joinable: true,
      }),
    );
  const meetings = input.appointments
    .filter((a) => a.status === 'scheduled' && Date.parse(a.endsAt) > t && Date.parse(a.startsAt) < horizon)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .map((a): UpNextRow => {
      const tag = a.liveMeetingId ? ({ text: 'Live now', tone: 'live' } as const) : startsIn(a.startsAt, a.endsAt, now);
      return {
        key: `appointment:${a.id}`,
        kind: 'event',
        title: a.title,
        meta: [whenRange(a.startsAt, a.endsAt, now), withWords(a, input.selfPersonId), input.manyTeams ? a.team.name : ''].filter(Boolean).join(' · '),
        to: `/t/${encodeURIComponent(slug)}/schedule?appointment=${encodeURIComponent(a.id)}`,
        ...(tag ? { tag } : {}),
        appointmentId: a.id,
        joinable: joinable(a, t),
      };
    });
  // a meeting whose call is going stays among the live ones at the top
  const live = meetings.filter((m) => m.tag?.tone === 'live');
  return trim([...rooms, ...live, ...meetings.filter((m) => m.tag?.tone !== 'live')]);
}

// ---- 5. keep going --------------------------------------------------------------------------------------------------------------

export interface Place {
  key: string;
  label: string;
  to: string;
  kind: 'channel' | 'dm';
  unread: number;
  /** The last message, as a time; 0 when the place has none. */
  at: number;
  isPrivate: boolean;
}

/** The team's channels as places. `unread` is the live count by channel id, falling back to what the directory said. */
export function channelPlaces(groups: readonly NavChannelGroup[], slug: string, unread: Readonly<Record<string, number>>): Place[] {
  return groups.flatMap((g) =>
    g.channels.map((c): Place => {
      const name = c.name.replace(/^#/, '');
      return {
        key: `channel:${c.id}`,
        label: name,
        to: `/t/${encodeURIComponent(slug)}/c/${encodeURIComponent(name)}`,
        kind: 'channel',
        unread: unread[c.id] ?? c.unread,
        at: c.lastActivityAt ? Date.parse(c.lastActivityAt) : 0,
        isPrivate: c.isPrivate,
      };
    }),
  );
}

/** The person's direct messages as places. */
export function dmPlaces(dms: readonly DirectMessageSummary[], slug: string, unread: Readonly<Record<string, number>>, labelOf: (dm: DirectMessageSummary) => string): Place[] {
  return dms.map((d) => ({
    key: `dm:${d.channel.id}`,
    label: labelOf(d),
    to: `/t/${encodeURIComponent(slug)}/dm/${d.channel.id}`,
    kind: 'dm' as const,
    unread: unread[d.channel.id] ?? d.unreadCount,
    at: d.lastMessage ? Date.parse(d.lastMessage.createdAt) : 0,
    isPrivate: true,
  }));
}

/** A place with nothing said in it for this long is not "current" unless the person opened it lately. */
const CURRENT_DAYS = 3;

/**
 * The places the person is in the middle of: those with something new first (the newest on top, a quiet one set aside), then the ones opened lately in the order they were
 * opened (`recent` holds `channel:<id>` and `dm:<id>` keys, newest first), then any other with a message in the last few days. At most `CHIPS`.
 */
export function keepGoing(places: readonly Place[], recent: readonly string[], now: Date, quiet: (p: Place) => boolean, max: number = CHIPS): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  const add = (p: Place | undefined): void => {
    if (p && !seen.has(p.key) && out.length < max) {
      seen.add(p.key);
      out.push(p);
    }
  };
  const byKey = new Map(places.map((p) => [p.key, p]));
  for (const p of [...places].filter((p) => p.unread > 0 && !quiet(p)).sort((a, b) => b.at - a.at)) add(p);
  for (const k of recent) add(byKey.get(k));
  const cutoff = now.getTime() - CURRENT_DAYS * MS.day;
  for (const p of [...places].filter((p) => p.at >= cutoff).sort((a, b) => b.at - a.at)) add(p);
  return out;
}

// ---- the lead line --------------------------------------------------------------------------------------------------------------

/** "a, b and c" */
export const listWords = (parts: readonly string[]): string => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** The roots of every thread that waits on the person (not only the ones drawn): a notification about one of them is not drawn again in the activity card. */
export const waitingRoots = (items: readonly ThreadInboxItem[]): Set<string> => new Set(items.filter((i) => i.mention || i.unreadCount > 0).map((i) => String(i.rootMessageId)));

/** How many meetings are left today (not cancelled, not over). */
export const meetingsLeftToday = (appointments: readonly Appointment[], now: Date): number =>
  appointments.filter((a) => a.status === 'scheduled' && sameDay(new Date(a.startsAt), now) && Date.parse(a.endsAt) > now.getTime()).length;

/**
 * The one sentence under the greeting. `null` for a count that is not known yet; with nothing known it says nothing, and with everything known and nothing to do it says so.
 * "3 things need you, 2 threads are waiting for your reply and you have 1 meeting today."
 */
export function leadLine(c: { attention: number | null; waiting: number | null; meetings: number | null }): string {
  const known = [c.attention, c.waiting, c.meetings].filter((n): n is number => n !== null);
  if (known.length === 0) return '';
  if (known.every((n) => n === 0) && known.length === 3) return 'You are all caught up. Nothing needs you right now.';
  const parts: string[] = [];
  if (c.attention) parts.push(c.attention === 1 ? '1 thing needs you' : `${c.attention} things need you`);
  if (c.waiting) parts.push(c.waiting === 1 ? '1 thread is waiting for your reply' : `${c.waiting} threads are waiting for your reply`);
  if (c.meetings) parts.push(`you have ${plural(c.meetings, 'meeting')} today`);
  return parts.length === 0 ? '' : `${listWords(parts).replace(/^./, (ch) => ch.toUpperCase())}.`;
}
