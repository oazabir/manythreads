import type { MeetingSummary } from '@manythreads/shared';

/*
 * The voice room card under the "Started a voice room" message (P33-03): which live room a message started, and what the card says. Plain rules, no React, so a test
 * can run them.
 */

/** The live room that the message with this id started (`meeting.threadRootId`), if it is live. A message that started nothing, or a room that ended, answers undefined. */
export function roomOfMessage(rooms: readonly MeetingSummary[], messageId: string): MeetingSummary | undefined {
  return rooms.find((r) => r.meeting.state === 'live' && r.meeting.threadRootId === messageId);
}

/** How many faces the card draws before "+N". */
export const CARD_FACES = 3;

export type RoomCardFacts = {
  title: string;
  /** "3 in the room", or "Nobody in the room yet" while the room is open and empty. */
  countText: string;
  faces: MeetingSummary['present'];
  more: number;
  /** The reader is in this very room: the card says so instead of offering Join. */
  inRoom: boolean;
  /** Only the person who started the room sees End room on the card (a lead or an admin may still end it from the dock). */
  canEnd: boolean;
};

export function roomCardFacts(room: MeetingSummary, selfActor: string | null, joinedMeetingId: string | null): RoomCardFacts {
  const present = room.present.filter((p) => p.leftAt === null);
  const n = present.length;
  return {
    title: room.meeting.title,
    countText: n === 0 ? 'Nobody in the room yet' : `${n} in the room`,
    faces: present.slice(0, CARD_FACES),
    more: Math.max(0, n - CARD_FACES),
    inRoom: joinedMeetingId === room.meeting.id,
    canEnd: selfActor !== null && room.meeting.startedBy === selfActor,
  };
}

/** The question before a room is ended for everyone, with the number of people who would be sent out. */
export function endQuestion(inRoom: number): string {
  if (inRoom <= 0) return 'End the voice room for everyone?';
  return `End the voice room for everyone? The ${inRoom === 1 ? 'one person' : `${inRoom} people`} in it will leave.`;
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
