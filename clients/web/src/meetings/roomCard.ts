import { CALL_CARD_FACES, type CallCard, type CallCardPerson, type MeetingSummary } from '@manythreads/shared';
import { clock } from '../channels/format';

/*
 * The call card (P33-03, grown in P15-26): the card a call's start message draws in place of its text while the call is live, and the one muted event line it
 * becomes once the call is over. Plain rules, no React, so a test can run them.
 */

/** The live room that the message with this id started (`meeting.threadRootId`), if it is live. A message that started nothing, or a room that ended, answers undefined. */
export function roomOfMessage(rooms: readonly MeetingSummary[], messageId: string): MeetingSummary | undefined {
  return rooms.find((r) => r.meeting.state === 'live' && r.meeting.threadRootId === messageId);
}

/** How many faces the card draws before "+N" (the cards route sends at most this many). */
export const CARD_FACES = CALL_CARD_FACES;

export type CallCardFacts = {
  meetingId: string;
  title: string;
  /** "Audio" (video calls come with P17-01). */
  kind: string;
  /** "Started by Nadia · 14:02". */
  started: string;
  /** "3 in the call", or "Nobody in the call yet" while it is open and empty. */
  countText: string;
  faces: readonly CallCardPerson[];
  /** The people in the call beyond the faces drawn: the card shows "+N". */
  more: number;
  /** Everyone in the call now (the question before ending names this number). */
  presentCount: number;
  /** The reader is in this very call in this tab: the card says so instead of offering Join. */
  inCall: boolean;
  /** Only the person who started the call sees End call on the card (a lead or an admin may still end it from the call bar). */
  canEnd: boolean;
  /** The note-taker bot's name while it is listening; null when there is none or it is not listening. */
  notetaker: string | null;
};

export function callCardFacts(card: CallCard, o: { selfActor: string | null; joinedMeetingId: string | null }): CallCardFacts {
  const faces = card.present.slice(0, CARD_FACES);
  const n = Math.max(card.presentCount, faces.length);
  return {
    meetingId: card.meetingId,
    title: card.title,
    kind: card.kind === 'video' ? 'Video' : 'Audio',
    started: `Started by ${card.starterName} · ${clock(card.startedAt)}`,
    countText: n === 0 ? 'Nobody in the call yet' : `${n} in the call`,
    faces,
    more: Math.max(0, n - faces.length),
    presentCount: n,
    inCall: o.joinedMeetingId === card.meetingId,
    // the route's `canEnd` also covers a lead or an admin; the card offers End only to the starter, as before (P33-03)
    canEnd: card.state === 'live' && o.selfActor !== null && card.startedBy === o.selfActor && card.you.canEnd,
    notetaker: card.notetaker?.listening ? card.notetaker.name : null,
  };
}

/**
 * The card of an older start message that carries no stamp (written before migration 0007 and not stamped by it): drawn from the live list, as P33 did, until
 * S7 removes the fallback. Only a live room is known this way.
 */
export function cardFromSummary(room: MeetingSummary, starterName: string): CallCard {
  const present = room.present.filter((p) => p.leftAt === null);
  return {
    meetingId: room.meeting.id,
    kind: room.meeting.kind,
    title: room.meeting.title,
    state: room.meeting.state,
    startedBy: room.meeting.startedBy,
    starterName,
    startedAt: room.meeting.startedAt,
    endedAt: room.meeting.endedAt,
    durationSeconds: null,
    present: present.slice(0, CARD_FACES).map((p) => ({ actorId: p.actorId, displayName: p.displayName })),
    presentCount: present.length,
    joinedCount: present.length,
    invited: { count: 0, names: [] },
    notetaker: null,
    you: { joined: false, canEnd: true, canInvite: false },
    notesLink: null,
  };
}

/** How long a live call has run: "0:42", "14:05", "1:02:09". */
export function runningTime(startedAt: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How long an ended call lasted, in words: "under a minute", "14 min", "1 h", "2 h 5 min". */
export function callLength(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const total = Math.floor(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The one line a start message draws before its card has loaded, and the start of every event line: "Omar started a call · 22:14". */
export function startLine(starterName: string, startedAt: string): string {
  return `${starterName} started a call · ${clock(startedAt)}`;
}

/**
 * The muted event line of an ended call (P34-02): "Omar started a call · 22:14 · 14 min · 3 joined". A live call (the card is drawn instead) and a card whose
 * length is not known answer the start alone.
 */
export function eventLine(card: CallCard): string {
  const parts = [startLine(card.starterName, card.startedAt)];
  if (card.state === 'ended' && card.durationSeconds !== null) parts.push(callLength(card.durationSeconds));
  if (card.state === 'ended' && card.joinedCount > 0) parts.push(`${card.joinedCount} joined`);
  return parts.join(' · ');
}

/** The text "Copy text" puts on the clipboard for a start message: the card's own line, never the stored "Started a call: …" body. */
export function callCopyText(card: CallCard | null, starterName: string, startedAt: string): string {
  if (card === null) return startLine(starterName, startedAt);
  if (card.state === 'live') return `${card.title} · ${card.kind === 'video' ? 'Video' : 'Audio'} call · Started by ${card.starterName} · ${clock(card.startedAt)}`;
  return eventLine(card);
}

/** The question before a call is ended for everyone, with the number of people who would be sent out. */
export function endQuestion(inCall: number): string {
  if (inCall <= 0) return 'End the call for everyone?';
  return `End the call for everyone? The ${inCall === 1 ? 'one person' : `${inCall} people`} in it will leave.`;
}

/** What the header's voice icon does: start a room, scroll to the message that started the live one, or join it straight away. */
export type VoiceIconAction = 'start' | 'show-message' | 'join';

/**
 * A channel with a live room whose start message is in the list scrolls to that message (its card has Join); when the message is not loaded, and in a direct
 * message (a call has no card to hunt for), the icon joins directly.
 */
export function voiceIconAction(o: { live: boolean; dm: boolean; messageLoaded: boolean }): VoiceIconAction {
  if (!o.live) return 'start';
  return !o.dm && o.messageLoaded ? 'show-message' : 'join';
}
