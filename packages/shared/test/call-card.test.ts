import { describe, expect, it } from 'vitest';
import {
  CALL_CARDS_MAX,
  CallCard,
  ListCallCardsQuery,
  ListCallCardsResponse,
  Meeting,
  MeetingsMeetingStartedEvent,
  Message,
  StartMeetingRequest,
  eventRegistry,
} from '../src/index.ts';
import { messageWire, uuid } from './fixtures.ts';

// The call card's contracts (P15-26): the stamp on a start message, the card, the start request that an older page still sends, the cards query and the started event's kind.

const meetingId = uuid(700);

describe('Message.meta.meeting', () => {
  it('round-trips, and a value that does not read is dropped without losing the message', () => {
    const stamped = Message.parse({ ...messageWire, meta: { meeting: { meetingId } } });
    expect(stamped.meta.meeting).toEqual({ meetingId });
    expect(Message.parse(JSON.parse(JSON.stringify(stamped)))).toEqual(stamped);
    for (const bad of [{ meetingId: 'nope' }, 'x', { other: 1 }]) {
      const parsed = Message.parse({ ...messageWire, meta: { meeting: bad } });
      expect(parsed.meta.meeting).toBeUndefined();
      expect(parsed.body).toBe(messageWire.body);
    }
  });
});

describe('the start request', () => {
  it('takes what the older page sends, a kind, and nothing else', () => {
    expect(StartMeetingRequest.parse({})).toEqual({});
    expect(StartMeetingRequest.parse({ title: 'Design review' })).toEqual({ title: 'Design review' });
    expect(StartMeetingRequest.parse({ kind: 'video' }).kind).toBe('video');
    expect(StartMeetingRequest.safeParse({ kind: 'screen' }).success).toBe(false);
    expect(StartMeetingRequest.safeParse({ title: 'x', meta: {} }).success).toBe(false);
  });
});

describe('Meeting.kind and the started event', () => {
  it('a meeting says its kind; the event carries it, and an event written before calls had a kind still reads', () => {
    expect(Meeting.shape.kind.options).toEqual(['audio', 'video']);
    const base = {
      type: 'meetings.meeting.started',
      schemaVersion: 1,
      workspaceId: uuid(1),
      teamId: null,
      channelId: uuid(2),
      meetingId,
      startedBy: uuid(3),
      at: '2026-11-20T10:00:00.000Z',
    } as const;
    expect(MeetingsMeetingStartedEvent.parse(base).kind).toBeUndefined();
    expect(MeetingsMeetingStartedEvent.parse({ ...base, kind: 'audio' }).kind).toBe('audio');
    expect(eventRegistry['meetings.meeting.started'][1].parse({ ...base, kind: 'audio' })).toMatchObject({ kind: 'audio' });
  });
});

describe('the cards', () => {
  const card = {
    meetingId,
    kind: 'audio',
    title: 'Design review',
    state: 'live',
    startedBy: uuid(3),
    starterName: 'Nadia',
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: null,
    durationSeconds: null,
    present: [{ actorId: uuid(3), displayName: 'Nadia' }],
    presentCount: 1,
    joinedCount: 1,
    invited: { count: 0, names: [] },
    notetaker: null,
    you: { joined: true, canEnd: true, canInvite: true },
    notesLink: null,
  } as const;

  it('a card round-trips and carries at most five faces', () => {
    expect(ListCallCardsResponse.parse({ cards: [card] }).cards[0]).toEqual(CallCard.parse(card));
    const six = Array.from({ length: 6 }, (_, i) => ({ actorId: uuid(10 + i), displayName: `P${String(i)}` }));
    expect(CallCard.safeParse({ ...card, present: six }).success).toBe(false);
  });

  it('the query takes ids joined by commas (or an array, parsed twice), at least one and at most fifty', () => {
    expect(ListCallCardsQuery.parse({ ids: `${uuid(1)}, ${uuid(2)}` }).ids).toEqual([uuid(1), uuid(2)]);
    const once = ListCallCardsQuery.parse({ ids: uuid(1) });
    expect(ListCallCardsQuery.parse(once)).toEqual(once);
    expect(ListCallCardsQuery.safeParse({ ids: '' }).success).toBe(false);
    expect(ListCallCardsQuery.safeParse({ ids: 'nope' }).success).toBe(false);
    const many = Array.from({ length: CALL_CARDS_MAX + 1 }, (_, i) => uuid(100 + i)).join(',');
    expect(ListCallCardsQuery.safeParse({ ids: many }).success).toBe(false);
  });
});
