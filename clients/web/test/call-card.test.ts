// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { CallCard } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock } from '../src/channels/format';
import { FakeClock, id, settle } from './meetings-fixtures';

// P15-26 / P34-02: the call card drawn in place of a stamped start message, the event line it becomes once the call is over, and the store that asks for the
// cards of the start messages in view.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = id(100);
const CALL = id(200);
const OMAR_ACTOR = id(1);

const h = vi.hoisted(() => ({
  call: vi.fn(),
  joinRoom: vi.fn(),
  endForAll: vi.fn(),
  refreshLive: vi.fn(),
  endMeeting: vi.fn(),
  selfActor: 'unset' as string | null,
}));

vi.mock('../src/api/client', () => ({ call: (...a: unknown[]) => h.call(...a), isApiError: (e: unknown) => typeof e === 'object' && e !== null && 'status' in e }));
vi.mock('../src/api/setup', () => ({ isMockMode: () => false }));
vi.mock('../src/presence/PresenceDot', () => ({ PresenceDot: () => null }));
vi.mock('../src/channels/hooks', () => ({ usePeople: () => ({ me: { personId: id(11), actorId: h.selfActor }, byActor: () => undefined }) }));
vi.mock('../src/channels/store', () => ({ channelStore: { get selfActor() { return h.selfActor; } } }));
vi.mock('../src/meetings/api', () => ({ endMeeting: (m: string) => h.endMeeting(m) }));
vi.mock('../src/meetings/store', () => ({
  useRoomOfMessage: () => undefined,
  useCall: () => ({ phase: 'idle', meeting: null }),
  callController: () => ({ joinRoom: h.joinRoom, endForAll: h.endForAll }),
  liveRooms: () => ({ refresh: h.refreshLive, snapshot: () => ({ rooms: [] }) }),
}));

const { callCardFacts, callCopyText, callLength, eventLine, runningTime, startLine } = await import('../src/meetings/roomCard');
const { CallCardsStore, CARD_BATCH_MS, CARD_RETRY_MS, callCards } = await import('../src/meetings/callCards');
const { GESTURE_IGNORES, RowGestureContext } = await import('../src/channels/gestures');
const { dropPersonData } = await import('../src/app/caches');
const { CallCardMessage } = await import('../src/meetings/VoiceRoomCard');
const { standsAlone } = await import('../src/channels/runs');

const card = (over: Partial<CallCard> = {}): CallCard =>
  ({
    meetingId: CALL,
    kind: 'audio',
    title: 'Design review',
    state: 'live',
    startedBy: OMAR_ACTOR,
    starterName: 'Omar',
    startedAt: '2026-11-18T22:14:00.000Z',
    endedAt: null,
    durationSeconds: null,
    present: [{ actorId: OMAR_ACTOR, displayName: 'Omar' }],
    presentCount: 1,
    joinedCount: 1,
    invited: { count: 0, names: [] },
    notetaker: null,
    you: { joined: false, canEnd: true, canInvite: true },
    notesLink: null,
    ...over,
  }) as CallCard;

const ended = (over: Partial<CallCard> = {}): CallCard =>
  card({ state: 'ended', endedAt: '2026-11-18T22:28:00.000Z', durationSeconds: 14 * 60 + 20, presentCount: 0, present: [], joinedCount: 3, you: { joined: false, canEnd: false, canInvite: false }, ...over });

describe('what the card and the event line say', () => {
  it('names the kind, who started it and when, who is in it, and draws five faces with "+N"', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ actorId: id(10 + i), displayName: `P${i}` }));
    const f = callCardFacts(card({ present: many as CallCard['present'], presentCount: 8 }), { selfActor: null, joinedMeetingId: null });
    expect(f.kind).toBe('Audio');
    expect(f.started).toBe(`Started by Omar · ${clock('2026-11-18T22:14:00.000Z')}`);
    expect(f.faces).toHaveLength(5);
    expect(f.more).toBe(3);
    expect(f.countText).toBe('8 in the call');
    expect(callCardFacts(card({ present: [], presentCount: 0 }), { selfActor: null, joinedMeetingId: null }).countText).toBe('Nobody in the call yet');
  });

  it('offers End call to the starter only, while live, and says "in this call" only for the call this tab is in', () => {
    expect(callCardFacts(card(), { selfActor: OMAR_ACTOR, joinedMeetingId: null }).canEnd).toBe(true);
    // a lead may end it (the route says canEnd), but the card offers End to the starter only, as before
    expect(callCardFacts(card({ startedBy: id(2) as never }), { selfActor: OMAR_ACTOR, joinedMeetingId: null }).canEnd).toBe(false);
    expect(callCardFacts(card({ you: { joined: false, canEnd: false, canInvite: false } }), { selfActor: OMAR_ACTOR, joinedMeetingId: null }).canEnd).toBe(false);
    expect(callCardFacts(ended(), { selfActor: OMAR_ACTOR, joinedMeetingId: null }).canEnd).toBe(false);
    expect(callCardFacts(card(), { selfActor: null, joinedMeetingId: CALL }).inCall).toBe(true);
    expect(callCardFacts(card({ you: { joined: true, canEnd: true, canInvite: true } }), { selfActor: null, joinedMeetingId: null }).inCall).toBe(false);
  });

  it('shows the note-taker only while it listens', () => {
    expect(callCardFacts(card({ notetaker: { name: 'Scribe', listening: true } }), { selfActor: null, joinedMeetingId: null }).notetaker).toBe('Scribe');
    expect(callCardFacts(card({ notetaker: { name: 'Scribe', listening: false } }), { selfActor: null, joinedMeetingId: null }).notetaker).toBeNull();
  });

  it('writes an ended call as one line: who, when, how long, how many joined', () => {
    const at = clock('2026-11-18T22:14:00.000Z');
    expect(eventLine(ended())).toBe(`Omar started a call · ${at} · 14 min · 3 joined`);
    expect(eventLine(ended({ joinedCount: 0 }))).toBe(`Omar started a call · ${at} · 14 min`);
    expect(eventLine(ended({ durationSeconds: null }))).toBe(`Omar started a call · ${at} · 3 joined`);
    expect(eventLine(card())).toBe(`Omar started a call · ${at}`);
    expect(startLine('Omar', '2026-11-18T22:14:00.000Z')).toBe(`Omar started a call · ${at}`);
  });

  it('says how long in words and how long a live call has run as a clock', () => {
    expect(callLength(20)).toBe('under a minute');
    expect(callLength(60)).toBe('1 min');
    expect(callLength(59 * 60 + 59)).toBe('59 min');
    expect(callLength(3600)).toBe('1 h');
    expect(callLength(2 * 3600 + 5 * 60)).toBe('2 h 5 min');
    const start = '2026-11-18T22:14:00.000Z';
    expect(runningTime(start, Date.parse(start) + 42_000)).toBe('0:42');
    expect(runningTime(start, Date.parse(start) + 14 * 60_000 + 5_000)).toBe('14:05');
    expect(runningTime(start, Date.parse(start) + 3_729_000)).toBe('1:02:09');
    expect(runningTime(start, Date.parse(start) - 5_000)).toBe('0:00');
  });

  it('copies the card\'s line, never the stored start text', () => {
    const at = clock('2026-11-18T22:14:00.000Z');
    expect(callCopyText(ended(), 'Omar', '2026-11-18T22:14:00.000Z')).toBe(`Omar started a call · ${at} · 14 min · 3 joined`);
    expect(callCopyText(null, 'Omar', '2026-11-18T22:14:00.000Z')).toBe(`Omar started a call · ${at}`);
    expect(callCopyText(card(), 'Omar', '2026-11-18T22:14:00.000Z')).toBe(`Design review · Audio call · Started by Omar · ${at}`);
  });

  it('a stamped start message stands alone: it never joins a run, and nothing joins it', () => {
    const base = { authorId: OMAR_ACTOR, createdAt: '2026-11-18T22:14:00.000Z', deletedAt: null, replyCount: 0, reactions: [], author: undefined, forward: undefined, poll: undefined } as const;
    expect(standsAlone({ ...base, meta: { meeting: { meetingId: CALL } } } as never)).toBe(true);
    expect(standsAlone({ ...base, meta: {} } as never)).toBe(false);
  });
});

describe('the call cards store', () => {
  const build = () => {
    const t = new FakeClock();
    const asks: string[][] = [];
    const answers: Array<{ resolve: (v: { cards: CallCard[] }) => void; reject: (e: unknown) => void }> = [];
    const store = new CallCardsStore({
      fetchCards: (ids) => {
        asks.push([...ids]);
        return new Promise((resolve, reject) => answers.push({ resolve, reject }));
      },
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
      now: () => t.now,
    });
    return { t, asks, answers, store };
  };

  it('sends the ids asked for within 100 ms as one request, and asks for a known call only once', async () => {
    const s = build();
    s.store.want(id(1));
    s.store.want(id(2));
    s.store.want(id(1));
    expect(s.store.get(id(1))).toEqual({ status: 'loading' });
    await s.t.advance(CARD_BATCH_MS - 1);
    expect(s.asks).toEqual([]);
    await s.t.advance(1);
    expect(s.asks).toEqual([[id(1), id(2)]]);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never })] });
    await settle();
    expect(s.store.get(id(1))).toMatchObject({ status: 'ok' });
    // a call the server left out (the reader may not read it) is gone: the row keeps its one-line start
    expect(s.store.get(id(2))).toEqual({ status: 'gone' });
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(1);
  });

  it('splits more than 50 ids into requests of 50', async () => {
    const s = build();
    for (let i = 0; i < 120; i++) s.store.want(id(1000 + i));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks.map((a) => a.length)).toEqual([50, 50, 20]);
  });

  it('asks again for one call on a push, only for a call the page drew', async () => {
    const s = build();
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never })] });
    await settle();
    s.store.changed(id(9));
    s.store.changed(id(1));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toEqual([[id(1)], [id(1)]]);
    s.answers[1]!.resolve({ cards: [ended({ meetingId: id(1) as never })] });
    await settle();
    expect(s.store.card(id(1))?.state).toBe('ended');
  });

  it('drops an older answer that comes in after a newer one', async () => {
    const s = build();
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    s.store.changed(id(1));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[1]!.resolve({ cards: [ended({ meetingId: id(1) as never })] });
    await settle();
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never })] });
    await settle();
    expect(s.store.card(id(1))?.state).toBe('ended');
  });

  it('keeps a drawn card when an ask fails, and marks a row still waiting as failed', async () => {
    const s = build();
    s.store.want(id(1));
    s.store.want(id(2));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never })] });
    await settle();
    s.store.changed(id(1));
    s.store.want(id(3));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[1]!.reject(new Error('offline'));
    await settle();
    expect(s.store.get(id(1))).toMatchObject({ status: 'ok' });
    expect(s.store.get(id(3))).toMatchObject({ status: 'failed', tries: 1 });
  });

  it('asks again for a failed call on a redraw only after its wait, and the wait doubles', async () => {
    const s = build();
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.reject(new Error('429'));
    await settle();
    expect(s.store.get(id(1))).toMatchObject({ status: 'failed', tries: 1 });
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(1);
    await s.t.advance(CARD_RETRY_MS);
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(2);
    s.answers[1]!.reject(new Error('429'));
    await settle();
    expect(s.store.get(id(1))).toMatchObject({ status: 'failed', tries: 2 });
    await s.t.advance(CARD_RETRY_MS);
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    // the second wait is twice as long
    expect(s.asks).toHaveLength(2);
    await s.t.advance(CARD_RETRY_MS);
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(3);
  });

  it('on a reconnect asks again only for live, loading or failed calls, never an ended one or one the reader may not read', async () => {
    const s = build();
    for (const n of [1, 2, 3, 4]) s.store.want(id(n));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never }), ended({ meetingId: id(2) as never })] });
    await settle();
    s.store.want(id(5));
    s.store.refreshAll();
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks[1]).toEqual([id(5), id(1)]);
  });

  it('turns a live card into an ended one when the end route has answered, and forgets everything on sign-out', async () => {
    const s = build();
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never, startedAt: new Date(s.t.now - 125_000).toISOString() })] });
    await settle();
    s.store.markEnded(id(1));
    expect(s.store.card(id(1))).toMatchObject({ state: 'ended', durationSeconds: 125, presentCount: 0, you: { canEnd: false } });
    s.store.want(id(2));
    s.store.reset();
    expect(s.store.get(id(1))).toBeUndefined();
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(1);
  });

  it('the page\'s store is cleared when the person changes', async () => {
    const st = callCards();
    h.call.mockReturnValueOnce(new Promise(() => undefined));
    st.want(id(77));
    expect(st.get(id(77))).toBeDefined();
    dropPersonData();
    expect(st.get(id(77))).toBeUndefined();
  });

  it('refresh resolves only after an answer asked after it', async () => {
    const s = build();
    s.store.want(id(1));
    await s.t.advance(CARD_BATCH_MS);
    let done = false;
    void s.store.refresh(id(1)).then(() => void (done = true));
    // the first ask is answered: refresh still waits for its own
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never })] });
    await settle();
    expect(done).toBe(false);
    await s.t.advance(CARD_BATCH_MS);
    s.answers[1]!.resolve({ cards: [ended({ meetingId: id(1) as never })] });
    await settle();
    expect(done).toBe(true);
  });

  it('asks again for a card drawn as live once the live list no longer has its call', async () => {
    const s = build();
    s.store.want(id(1));
    s.store.want(id(2));
    await s.t.advance(CARD_BATCH_MS);
    s.answers[0]!.resolve({ cards: [card({ meetingId: id(1) as never }), ended({ meetingId: id(2) as never })] });
    await settle();
    s.store.liveListChanged(new Set([id(1)]));
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks).toHaveLength(1);
    s.store.liveListChanged(new Set());
    await s.t.advance(CARD_BATCH_MS);
    expect(s.asks[1]).toEqual([id(1)]);
  });
});

describe('a stamped start message in the list', () => {
  let host: HTMLDivElement;
  let root: Root;
  const q = (testId: string): HTMLElement | null => host.querySelector(`[data-testid="${testId}"]`);
  const mount = (): void =>
    void act(() =>
      root.render(createElement(MemoryRouter, null, createElement(CallCardMessage, { meetingId: CALL, channelId: CHANNEL, starterName: 'Omar', startedAt: '2026-11-18T22:14:00.000Z' }))),
    );
  const answer = async (c: CallCard | null): Promise<void> => {
    h.call.mockResolvedValueOnce({ cards: c ? [c] : [] });
    mount();
    await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 20))));
    await settle();
  };
  beforeEach(() => {
    h.call.mockReset();
    h.joinRoom.mockReset();
    h.selfActor = OMAR_ACTOR;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    // a fresh store for the next test: forget this call
    callCards().reset();
  });

  it('draws the one-line start before the card loads, and keeps it for a call the reader may not read', async () => {
    h.call.mockReturnValueOnce(new Promise(() => undefined));
    mount();
    const line = q('call-event');
    expect(line?.dataset['state']).toBe('start');
    expect(line?.textContent).toBe(`Omar started a call · ${clock('2026-11-18T22:14:00.000Z')}`);
    act(() => root.unmount());
    callCards().reset();
    root = createRoot(host);
    await answer(null);
    expect(q('call-event')?.dataset['state']).toBe('start');
    expect(q('room-card')).toBeNull();
  });

  it('asks the cards route with the ids in view', async () => {
    await answer(ended());
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call.mock.calls[0]![2]).toEqual({ ids: CALL });
  });

  it('draws an ended call as the event line, with Notes only when there is a link', async () => {
    await answer(ended());
    expect(q('call-event')?.dataset['state']).toBe('ended');
    expect(q('call-event')?.textContent).toContain('14 min · 3 joined');
    expect(q('call-event-notes')).toBeNull();
    act(() => root.unmount());
    callCards().reset();
    root = createRoot(host);
    await answer(ended({ notesLink: `/t/eng/meetings/${CALL}` }));
    expect(q('call-event-notes')?.getAttribute('href')).toBe(`/t/eng/meetings/${CALL}`);
    expect(q('call-event-notes')?.textContent).toBe('Notes');
  });

  it('draws a live call as the card: Audio, Live with its time, who started it, Join call and End call for the starter', async () => {
    await answer(card({ notetaker: { name: 'Scribe', listening: true } }));
    expect(q('room-card')?.dataset['meetingId']).toBe(CALL);
    expect(q('room-card-kind')?.textContent).toBe('Audio');
    expect(q('room-card-live')?.textContent).toMatch(/^Live \d+:\d{2}/);
    expect(q('room-card-by')?.textContent).toContain('Started by Omar');
    expect(q('room-card-notetaker')?.textContent).toContain('Note-taker listening');
    expect(q('room-card-join')?.textContent).toBe('Join call');
    expect(q('room-card-end')?.textContent).toBe('End call');
    act(() => q('room-card-join')!.click());
    expect(h.joinRoom).toHaveBeenCalledWith(CALL, CHANNEL);
  });

  it('does not join from the click a held finger leaves, nor from a click that selected words of the card', async () => {
    let fired = true;
    h.call.mockResolvedValueOnce({ cards: [card()] });
    act(() =>
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(RowGestureContext.Provider, { value: () => fired }, createElement(CallCardMessage, { meetingId: CALL, channelId: CHANNEL, starterName: 'Omar', startedAt: '2026-11-18T22:14:00.000Z' })),
        ),
      ),
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 20))));
    const title = host.querySelector<HTMLElement>('.room-card-title')!;
    act(() => title.click());
    expect(h.joinRoom).not.toHaveBeenCalled();
    fired = false;
    const range = document.createRange();
    range.selectNodeContents(title);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => title.click());
    expect(h.joinRoom).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
    act(() => title.click());
    expect(h.joinRoom).toHaveBeenCalledTimes(1);
    // a swipe or a hold that starts on the card is the card's, not the row's
    expect(GESTURE_IGNORES.split(',')).toContain('.room-card');
  });

  it('after a successful end, a failed re-ask still turns the card into the event line, with no "Could not end"', async () => {
    h.endMeeting.mockReset().mockResolvedValue({ meeting: {} });
    h.refreshLive.mockReset().mockResolvedValue(undefined);
    await answer(card());
    act(() => q('room-card-end')!.click());
    h.call.mockRejectedValueOnce(new Error('offline'));
    await act(async () => q('room-end-confirm-yes')!.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, CARD_BATCH_MS + 20))));
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(q('room-card')).toBeNull();
    expect(q('call-event')?.dataset['state']).toBe('ended');
  });

  it('shows "Could not end the call" only when the end request itself fails', async () => {
    h.endMeeting.mockReset().mockRejectedValue({ status: 500 });
    await answer(card());
    act(() => q('room-card-end')!.click());
    await act(async () => q('room-end-confirm-yes')!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not end the call. Try again.');
    expect(q('room-card')).not.toBeNull();
  });
});
