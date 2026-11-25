import { describe, expect, it } from 'vitest';
import {
  CARD_ROWS,
  agoWords,
  approvalsForMe,
  attention,
  dateLine,
  dayGreeting,
  keepGoing,
  leadLine,
  meetingsLeftToday,
  notificationPath,
  recentActivity,
  startsIn,
  trim,
  upNext,
  waitingRoots,
  waitingThreads,
  whenRange,
  type Place,
} from '../src/screens/summaries/summaries';

// The clock is the person's own: Wednesday 25 November 2026, 10:00 local time. Every time below is built from it, so the tests do not depend on the machine's zone.
const now = new Date(2026, 10, 25, 10, 0, 0);
const at = (minutesFromNow: number): string => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();
const MIN = { hour: 60, day: 1440 };
const today = '2026-11-25';

// fixtures: only the fields the rules read, cast once
const item = (over: Record<string, unknown>) => ({ id: 'a1', what: 'Send the notes', done: false, due: null, source: null, ...over }) as never;
const approval = (over: Record<string, unknown>) =>
  ({ id: 'ap1', status: 'pending', canDecide: true, createdAt: at(-30), tool: 'shell', summary: 'Run the build', argsPreview: null, source: 'bot', botName: 'Builder', requesterName: 'Builder', ...over }) as never;
const thread = (over: Record<string, unknown>) =>
  ({
    rootMessageId: 'r1',
    title: 'Plan the launch',
    channel: { id: 'c1', kind: 'public', name: 'dev' },
    mention: null,
    unreadCount: 0,
    replyCount: 4,
    lastReplyAt: at(-60),
    lastReply: { authorId: 'u2', authorName: 'Nadia' },
    rootAuthor: { displayName: 'Omar' },
    ...over,
  }) as never;
const note = (over: Record<string, unknown>) =>
  ({ id: 'n1', kind: 'mention', readAt: null, createdAt: at(-20), actorId: 'u2', actorName: 'Nadia', preview: 'Can you look?', channelId: 'c1', refId: 'm1', refType: 'message', threadRootId: null, ...over }) as never;
const appt = (over: Record<string, unknown>) =>
  ({
    id: 'p1',
    title: 'Weekly sync',
    status: 'scheduled',
    startsAt: at(120),
    endsAt: at(150),
    liveMeetingId: null,
    invited: [
      { personId: 'me', name: 'Sam' },
      { personId: 'u2', name: 'Nadia' },
    ],
    team: { name: 'Engineering' },
    ...over,
  }) as never;
const place = (over: Partial<Place>): Place => ({ key: 'channel:c1', label: 'dev', to: '/t/x/c/dev', kind: 'channel', unread: 0, at: 0, isPrivate: false, ...over });

describe('trim', () => {
  it('keeps at most five rows and counts the rest', () => {
    const t = trim([1, 2, 3, 4, 5, 6, 7]);
    expect(t.shown).toEqual([1, 2, 3, 4, 5]);
    expect(t.total).toBe(7);
    expect(t.more).toBe(2);
    expect(CARD_ROWS).toBe(5);
  });
  it('says nothing more when everything fits', () => {
    expect(trim([1, 2])).toEqual({ shown: [1, 2], total: 2, more: 0 });
  });
});

describe('agoWords', () => {
  it('reads like a person', () => {
    expect(agoWords(at(0), now)).toBe('just now');
    expect(agoWords(at(-1), now)).toBe('1 minute ago');
    expect(agoWords(at(-45), now)).toBe('45 minutes ago');
    expect(agoWords(at(-61), now)).toBe('1 hour ago');
    expect(agoWords(at(-5 * 60), now)).toBe('5 hours ago');
  });
  it('turns to days and weeks', () => {
    expect(agoWords(new Date(2026, 10, 24, 8, 0).toISOString(), now)).toBe('yesterday');
    expect(agoWords(new Date(2026, 10, 22, 12, 0).toISOString(), now)).toBe('3 days ago');
    expect(agoWords(new Date(2026, 10, 11, 12, 0).toISOString(), now)).toBe('2 weeks ago');
  });
  it('treats the future and a bad date as harmless', () => {
    expect(agoWords(at(30), now)).toBe('just now');
    expect(agoWords('not a date', now)).toBe('');
  });
});

describe('the greeting and the date', () => {
  it('follows the hour', () => {
    expect(dayGreeting(new Date(2026, 10, 25, 8))).toBe('Good morning');
    expect(dayGreeting(new Date(2026, 10, 25, 13))).toBe('Good afternoon');
    expect(dayGreeting(new Date(2026, 10, 25, 20))).toBe('Good evening');
  });
  it('writes the weekday and the day', () => {
    expect(dateLine(now, 'en-GB')).toBe('Wednesday 25 November');
  });
});

describe('whenRange and startsIn', () => {
  it('says today and tomorrow, then the day', () => {
    expect(whenRange(at(120), at(150), now, 'en-GB')).toMatch(/^Today \d\d:\d\d – \d\d:\d\d$/);
    expect(whenRange(at(MIN.day + 60), at(MIN.day + 90), now, 'en-GB')).toMatch(/^Tomorrow /);
    expect(whenRange(at(3 * MIN.day), at(3 * MIN.day + 30), now, 'en-GB')).toMatch(/^[A-Z][a-z]{2},? 28 Nov/);
  });
  it('tags what is close, and nothing that is far or over', () => {
    expect(startsIn(at(-5), at(25), now)).toEqual({ text: 'Live now', tone: 'live' });
    expect(startsIn(at(0.5), at(30), now)).toEqual({ text: 'Starting now', tone: 'soon' });
    expect(startsIn(at(25), at(55), now)).toEqual({ text: 'In 25 min', tone: 'soon' });
    expect(startsIn(at(3 * 60), at(4 * 60), now)).toEqual({ text: 'In 3 h', tone: 'info' });
    expect(startsIn(at(20 * 60), at(21 * 60), now)).toBeNull();
    expect(startsIn(at(-60), at(-30), now)).toBeNull();
  });
});

describe('attention (needs your attention today)', () => {
  it('puts late items first, then due today, then requests, then dated, then undated', () => {
    const a = attention({
      slug: 'eng',
      now,
      today,
      actionItems: [
        item({ id: 'undated', what: 'Someday', due: null }),
        item({ id: 'later', what: 'Next week', due: '2026-12-02' }),
        item({ id: 'late', what: 'Send the invoice', due: '2026-11-20' }),
        item({ id: 'now', what: 'Book the room', due: today }),
        item({ id: 'done', what: 'Finished', done: true, due: '2026-11-01' }),
      ],
      approvals: [approval({ id: 'ap1' })],
      meetingNotes: [],
    });
    expect(a.rows.shown.map((r) => r.key)).toEqual(['action:late', 'action:now', 'approval:ap1', 'action:later', 'action:undated']);
    expect(a.rows.shown[0]?.tag).toEqual({ text: 'Late', tone: 'urgent' });
    expect(a.rows.shown[1]?.tag).toEqual({ text: 'Today', tone: 'soon' });
    expect(a.summary).toBe('1 late, 1 due today, 1 request to answer');
    expect(a.counts).toEqual({ actionItems: 4, approvals: 1, meetings: 0 });
  });

  it('puts a request that has waited over a day at the very top', () => {
    const a = attention({
      slug: 'eng',
      now,
      today,
      actionItems: [item({ id: 'late', due: '2026-11-20' })],
      approvals: [approval({ id: 'old', createdAt: at(-2 * MIN.day) })],
      meetingNotes: [],
    });
    expect(a.rows.shown[0]?.key).toBe('approval:old');
    expect(a.rows.shown[0]?.tag?.text).toBe('Over a day');
  });

  it('leaves out requests the person may not decide, and ones already decided', () => {
    const list = [approval({ id: 'mine' }), approval({ id: 'theirs', canDecide: false }), approval({ id: 'done', status: 'approved' })];
    expect(approvalsForMe(list).map((x) => x.id)).toEqual(['mine']);
  });

  it('adds the action items a meeting gave the person, linking to the meeting', () => {
    const a = attention({ slug: 'eng', now, today, actionItems: [], approvals: [], meetingNotes: [note({ id: 'm9', kind: 'meeting_actions', refType: 'meeting', refId: 'mt1', preview: '2 for you' })] });
    expect(a.rows.shown[0]).toMatchObject({ kind: 'meeting', to: '/meetings/mt1', title: 'Nadia gave you action items' });
  });

  it('shows five rows and counts the rest; with nothing it is empty with no summary', () => {
    const many = Array.from({ length: 8 }, (_, i) => item({ id: `i${i}`, due: '2026-12-01' }));
    const a = attention({ slug: 'eng', now, today, actionItems: many, approvals: [], meetingNotes: [] });
    expect(a.rows.shown).toHaveLength(5);
    expect(a.rows.more).toBe(3);
    const none = attention({ slug: 'eng', now, today, actionItems: [], approvals: [], meetingNotes: [] });
    expect(none.rows.total).toBe(0);
    expect(none.summary).toBe('');
  });
});

describe('waitingThreads', () => {
  it('puts a thread that asks for the person first, the longest wait on top, then threads with new replies, newest first', () => {
    const rows = waitingThreads(
      [
        thread({ rootMessageId: 'quiet', unreadCount: 0 }),
        thread({ rootMessageId: 'new-old', unreadCount: 2, lastReplyAt: at(-300) }),
        thread({ rootMessageId: 'new-fresh', unreadCount: 1, lastReplyAt: at(-10) }),
        thread({ rootMessageId: 'asked-late', mention: { at: at(-30), authorId: 'u3', authorName: 'Priya' } }),
        thread({ rootMessageId: 'asked-long', mention: { at: at(-3 * MIN.hour), authorId: 'u2', authorName: 'Nadia' } }),
      ],
      'eng',
      now,
    );
    expect(rows.shown.map((r) => r.key)).toEqual(['thread:asked-long', 'thread:asked-late', 'thread:new-fresh', 'thread:new-old']);
    expect(rows.total).toBe(4);
  });

  it('writes the title, the channel, who and how long ago, and links straight to the thread', () => {
    const [row] = waitingThreads([thread({ rootMessageId: 'r 1', mention: { at: at(-120), authorId: 'u2', authorName: 'Nadia' } })], 'eng', now).shown;
    expect(row?.title).toBe('Plan the launch');
    expect(row?.meta).toBe('#dev · Nadia asked for you · 2 hours ago');
    expect(row?.to).toBe('/t/eng/threads?thread=r%201');
    expect(row?.tag).toEqual({ text: 'Your reply', tone: 'soon' });
  });

  it('marks a request that has waited over a day as urgent, and names a direct message as one', () => {
    const [row] = waitingThreads([thread({ channel: { id: 'd', kind: 'dm', name: '' }, mention: { at: at(-2 * MIN.day), authorId: 'u2', authorName: 'Nadia' } })], 'eng', now).shown;
    expect(row?.tag?.tone).toBe('urgent');
    expect(row?.meta.startsWith('Direct message')).toBe(true);
  });

  it('says how many replies are new', () => {
    const [row] = waitingThreads([thread({ unreadCount: 3 })], 'eng', now).shown;
    expect(row?.meta).toContain('Nadia wrote 3 replies');
    expect(row?.tag).toEqual({ text: '3 new', tone: 'info' });
  });

  it('is empty when nobody waits', () => {
    expect(waitingThreads([thread({})], 'eng', now).total).toBe(0);
    expect([...waitingRoots([thread({}), thread({ rootMessageId: 'x', unreadCount: 1 })])]).toEqual(['x']);
  });
});

describe('recentActivity', () => {
  const titleOf = (n: { actorName: string }): string => `${n.actorName} did something`;
  it('shows unread news, newest first, and leaves out read ones, background messages and threads already shown', () => {
    const rows = recentActivity({
      slug: 'eng',
      now,
      shownRoots: new Set(['shown-root']),
      titleOf: titleOf as never,
      items: [
        note({ id: 'old', createdAt: at(-300) }),
        note({ id: 'fresh', createdAt: at(-5), kind: 'dm' }),
        note({ id: 'read', readAt: at(-1) }),
        note({ id: 'bg', kind: 'message' }),
        note({ id: 'meet', kind: 'meeting_actions' }),
        note({ id: 'dup', refId: 'x', threadRootId: 'shown-root' }),
      ],
    });
    expect(rows.shown.map((r) => r.key)).toEqual(['note:fresh', 'note:old']);
    expect(rows.shown[0]?.meta).toBe('“Can you look?” · 5 minutes ago');
    expect(rows.shown[0]?.avatar).toEqual({ actorId: 'u2', name: 'Nadia' });
  });

  it('opens a message through /open, a meeting on its page and a planned meeting on the Schedule', () => {
    expect(notificationPath(note({ channelId: 'c1', refId: 'm1', threadRootId: 'r9' }), 'eng')).toBe('/open?channel=c1&message=m1&root=r9');
    expect(notificationPath(note({ refType: 'meeting', refId: 'mt1' }), 'eng')).toBe('/meetings/mt1');
    expect(notificationPath(note({ kind: 'appointment_invite', refType: 'appointment', refId: 'p1' }), 'eng')).toBe('/t/eng/schedule?appointment=p1');
  });
});

describe('upNext', () => {
  const base = { slug: 'eng', now, rooms: [], selfPersonId: 'me', manyTeams: false, teamId: 't1', roomPath: () => null };
  it('lists meetings soonest first, leaves out the past, the cancelled and the far off', () => {
    const rows = upNext({
      ...base,
      appointments: [
        appt({ id: 'later', startsAt: at(300), endsAt: at(330) }),
        appt({ id: 'soon', startsAt: at(25), endsAt: at(55) }),
        appt({ id: 'over', startsAt: at(-90), endsAt: at(-60) }),
        appt({ id: 'cancelled', status: 'cancelled' }),
        appt({ id: 'far', startsAt: at(10 * MIN.day), endsAt: at(10 * MIN.day + 30) }),
      ],
    });
    expect(rows.shown.map((r) => r.appointmentId)).toEqual(['soon', 'later']);
    expect(rows.shown[0]?.tag).toEqual({ text: 'In 25 min', tone: 'soon' });
  });

  it('offers Join from ten minutes before and names who is invited, not the person themselves', () => {
    const rows = upNext({ ...base, appointments: [appt({ id: 'a', startsAt: at(8), endsAt: at(38) }), appt({ id: 'b', startsAt: at(60), endsAt: at(90) })] });
    expect(rows.shown.map((r) => r.joinable)).toEqual([true, false]);
    expect(rows.shown[0]?.meta).toContain('with Nadia');
    expect(rows.shown[0]?.meta).not.toContain('Sam');
  });

  it('keeps a call that runs past its planned end, with Join', () => {
    const rows = upNext({ ...base, appointments: [appt({ id: 'long', liveMeetingId: 'm9', startsAt: at(-45), endsAt: at(-15) })] });
    expect(rows.shown.map((r) => [r.appointmentId, r.joinable, r.tag?.text])).toEqual([['long', true, 'Live now']]);
  });

  it('names the team only when there are several', () => {
    const one = upNext({ ...base, appointments: [appt({})] }).shown[0]?.meta;
    const many = upNext({ ...base, manyTeams: true, appointments: [appt({})] }).shown[0]?.meta;
    expect(one).not.toContain('Engineering');
    expect(many).toContain('Engineering');
  });

  it('puts a call going now first with a Join, and shows a meeting whose call is going once', () => {
    const room = (id: string, over: Record<string, unknown> = {}) =>
      ({ meeting: { id, title: 'Standup', state: 'live', startedAt: at(-10), channelId: 'c1', teamId: 't1', ...over }, present: [{ displayName: 'Nadia' }, { displayName: 'Omar' }] }) as never;
    const rows = upNext({
      ...base,
      roomPath: (c) => `/t/eng/c/${c}`,
      rooms: [room('m1'), room('m2', { state: 'ended' }), room('m3', { teamId: 'other' }), room('m4')],
      appointments: [appt({ id: 'a', liveMeetingId: 'm4', startsAt: at(-5), endsAt: at(25) }), appt({ id: 'b', startsAt: at(20), endsAt: at(50) })],
    });
    expect(rows.shown.map((r) => r.key)).toEqual(['room:m1', 'appointment:a', 'appointment:b']);
    expect(rows.shown[0]).toMatchObject({ joinable: true, to: '/t/eng/c/c1', meta: '2 people in the call: Nadia, Omar' });
    expect(rows.shown[1]?.tag?.text).toBe('Live now');
  });
});

describe('keepGoing', () => {
  const never = () => false;
  it('puts places with something new first, then the ones opened lately, then any with a recent message', () => {
    const day = 86_400_000;
    const places = [
      place({ key: 'channel:old', label: 'old', at: now.getTime() - 20 * day }),
      place({ key: 'channel:unread', label: 'unread', unread: 3, at: now.getTime() - 2 * 60_000 }),
      place({ key: 'channel:opened', label: 'opened', at: now.getTime() - 10 * day }),
      place({ key: 'dm:busy', label: 'Nadia', kind: 'dm', at: now.getTime() - day }),
    ];
    const out = keepGoing(places, ['channel:opened', 'channel:gone'], now, never);
    expect(out.map((p) => p.key)).toEqual(['channel:unread', 'channel:opened', 'dm:busy']);
  });

  it('sets aside a place the person muted, and never repeats one', () => {
    const places = [place({ key: 'channel:muted', unread: 5, at: now.getTime() }), place({ key: 'channel:a', unread: 1, at: now.getTime() - 1000 })];
    const out = keepGoing(places, ['channel:a'], now, (p) => p.key === 'channel:muted');
    // the muted one is not pushed up by its unread count; it comes last, only because it has a recent message
    expect(out.map((p) => p.key)).toEqual(['channel:a', 'channel:muted']);
  });

  it('stops at the limit', () => {
    const places = Array.from({ length: 20 }, (_, i) => place({ key: `channel:${i}`, unread: 1, at: i }));
    expect(keepGoing(places, [], now, never)).toHaveLength(8);
    expect(keepGoing(places, [], now, never, 3)).toHaveLength(3);
  });
});

describe('the lead line', () => {
  it('says nothing while nothing is known', () => {
    expect(leadLine({ attention: null, waiting: null, meetings: null })).toBe('');
  });
  it('says the person is caught up when everything is known and empty', () => {
    expect(leadLine({ attention: 0, waiting: 0, meetings: 0 })).toBe('You are all caught up. Nothing needs you right now.');
  });
  it('joins what there is, with the right plurals', () => {
    expect(leadLine({ attention: 3, waiting: 1, meetings: 2 })).toBe('3 things need you, 1 thread is waiting for your reply and you have 2 meetings today.');
    expect(leadLine({ attention: 1, waiting: 0, meetings: 0 })).toBe('1 thing needs you.');
    expect(leadLine({ attention: 0, waiting: 0, meetings: 1 })).toBe('You have 1 meeting today.');
    expect(leadLine({ attention: null, waiting: 2, meetings: null })).toBe('2 threads are waiting for your reply.');
  });
  it('counts the meetings still to come today', () => {
    const list = [appt({ id: 'a', startsAt: at(60), endsAt: at(90) }), appt({ id: 'b', startsAt: at(-90), endsAt: at(-60) }), appt({ id: 'c', status: 'cancelled' }), appt({ id: 'd', startsAt: at(2 * MIN.day), endsAt: at(2 * MIN.day + 30) })];
    expect(meetingsLeftToday(list, now)).toBe(1);
  });
});
