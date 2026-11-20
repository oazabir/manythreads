import { describe, expect, it } from 'vitest';
import {
  CALL_CARDS_MAX,
  CALL_INVITES_MAX,
  CALL_OPTIONS_PEOPLE_MAX,
  CallStartOptionsQuery,
  CallCard,
  CallStartOptionsResponse,
  InviteToMeetingRequest,
  StartMeetingResponse,
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

  it('takes the dialog’s people, the note-taker and a guest switch that can only be off (P15-25)', () => {
    const full = { title: 'Design review', kind: 'audio', inviteeIds: [uuid(10), uuid(11)], allowGuests: false, notetakerBotId: uuid(12) } as const;
    expect(StartMeetingRequest.parse(full)).toEqual(full);
    expect(StartMeetingRequest.parse({ notetakerBotId: null }).notetakerBotId).toBeNull();
    expect(StartMeetingRequest.safeParse({ allowGuests: true }).success).toBe(false);
    expect(StartMeetingRequest.safeParse({ inviteeIds: ['Nadia'] }).success).toBe(false);
    expect(StartMeetingRequest.safeParse({ inviteeIds: Array.from({ length: CALL_INVITES_MAX + 1 }, (_, i) => uuid(100 + i)) }).success).toBe(false);
    expect(StartMeetingRequest.safeParse({ notetakerBotId: 'note-taker' }).success).toBe(false);
  });
});

describe('inviting people', () => {
  it('the start answer says how many were asked (0 when an older server leaves it out)', () => {
    const answer = {
      meeting: {
        id: meetingId, workspaceId: uuid(1), teamId: uuid(2), channelId: uuid(3), title: 'Call', state: 'live', kind: 'audio', startedBy: uuid(4), organizerId: uuid(4),
        notetakerBotId: null, startedAt: '2026-11-20T10:00:00.000Z', endedAt: null, endReason: null, transcription: 'off', recording: false, transcriptPath: null, transcriptFileId: null,
        threadRootId: uuid(5),
      },
      created: true,
      join: { provider: 'fake', url: 'wss://media.example/', token: 't', identity: uuid(4), roomName: meetingId, expiresAt: '2026-11-20T10:10:00.000Z' },
    };
    expect(StartMeetingResponse.parse(answer).invited).toBe(0);
    expect(StartMeetingResponse.parse({ ...answer, invited: 3 }).invited).toBe(3);
  });

  it('"Invite more" takes one to a hundred person ids and nothing else', () => {
    expect(InviteToMeetingRequest.parse({ personIds: [uuid(10)] })).toEqual({ personIds: [uuid(10)] });
    expect(InviteToMeetingRequest.safeParse({ personIds: [] }).success).toBe(false);
    expect(InviteToMeetingRequest.safeParse({ personIds: Array.from({ length: CALL_INVITES_MAX + 1 }, (_, i) => uuid(100 + i)) }).success).toBe(false);
    expect(InviteToMeetingRequest.safeParse({ personIds: [uuid(10)], message: 'come' }).success).toBe(false);
  });

  it('the dialog’s options: guest links are never available yet', () => {
    const options = {
      canStart: true,
      reason: null,
      directMessage: false,
      defaultTitle: 'Call · #dev · 14:02',
      live: null,
      people: [{ personId: uuid(10), displayName: 'Nadia', you: true }],
      peopleTotal: 1240,
      notetaker: { bots: [], defaultBotId: null, available: false, reason: 'No note-taker bot is set up here.' },
      guestLinks: { available: false, reason: 'Guest links are not available yet' },
    };
    expect(CallStartOptionsResponse.parse(options)).toEqual(options);
    expect(CallStartOptionsResponse.safeParse({ ...options, guestLinks: { available: true, reason: '' } }).success).toBe(false);
    const many = Array.from({ length: CALL_OPTIONS_PEOPLE_MAX + 1 }, (_, i) => ({ personId: uuid(100 + i), displayName: `P${String(i)}`, you: i === 0 }));
    expect(CallStartOptionsResponse.safeParse({ ...options, people: many }).success).toBe(false);
    expect(CallStartOptionsQuery.parse({ q: '  ra ' })).toEqual({ q: 'ra' });
    expect(CallStartOptionsQuery.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
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
