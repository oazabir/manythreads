// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MEETING_ASK_PUSH, MEETING_CATCHUP_PUSH, type MeetingAssistantStatus } from '@manythreads/shared';
import { ApiError } from '../src/api/client';
import { ASK_WAIT_MS, AssistantStore, askHeading, catchUpLabel, offerCatchUp } from '../src/meetings/assistant';

// The meeting assistant on the page (P17-06): the store against a scripted server (ask, the answer's push, a push that comes before the POST's answer, a lost push, a
// refusal; Catch me up's states), the words, and the panel drawn at its states.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM = '00000000-0000-7000-8000-000000000101';
const ASK = '00000000-0000-4000-8000-000000000201';
const REQ = '00000000-0000-4000-8000-000000000301';
const STATUS: MeetingAssistantStatus = {
  ask: { available: true, answerer: { kind: 'brain', name: 'Brain' }, reason: null },
  catchUp: { available: true, minutesBefore: 12, reason: null },
};

function harness(over: Partial<ConstructorParameters<typeof AssistantStore>[0]> = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let askAnswer: (() => void) | null = null;
  const store = new AssistantStore({
    status: async () => STATUS,
    ask: () => new Promise((resolve) => (askAnswer = () => resolve({ askId: ASK as never, answerer: { kind: 'brain', name: 'Brain' } }))),
    catchUp: async () => ({ requestId: REQ, minutesBefore: 12 }),
    mark: async () => ({ mark: { id: REQ, meetingId: ROOM as never, markedBy: ROOM as never, atMs: 0, text: 'Nadia: I will send it.', createdAt: '2026-11-25T10:00:00.000Z' }, count: 1 }),
    now: () => 1_000,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    ...over,
  });
  return { store, timers, answerAsk: () => askAnswer?.() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const askPush = (state: 'answered' | 'failed', text: string, askId = ASK) => ({ type: MEETING_ASK_PUSH, payload: { meetingId: ROOM, askId, state, answererName: 'Brain', text } });

describe('the words', () => {
  it('says how much of the call came before the person', () => {
    expect(catchUpLabel(12)).toBe('Catch me up · 12 minutes so far');
    expect(catchUpLabel(1)).toBe('Catch me up · 1 minute so far');
    expect(catchUpLabel(0)).toBe('Catch me up');
    expect(askHeading({ kind: 'notetaker', name: 'Note-taker' })).toBe('Ask Note-taker');
    expect(askHeading(null)).toBe('Ask');
  });
  it('offers Catch me up in the bar only to someone who came late and has not asked', () => {
    expect(offerCatchUp({ status: STATUS, catchUp: { kind: 'idle' } })).toBe(true);
    expect(offerCatchUp({ status: { ...STATUS, catchUp: { ...STATUS.catchUp, minutesBefore: 1 } }, catchUp: { kind: 'idle' } })).toBe(false);
    expect(offerCatchUp({ status: STATUS, catchUp: { kind: 'writing', requestId: null, minutesBefore: 12 } })).toBe(false);
    expect(offerCatchUp({ status: { ...STATUS, catchUp: { ...STATUS.catchUp, available: false } }, catchUp: { kind: 'idle' } })).toBe(false);
  });
});

describe('Ask', () => {
  it('shows the question at once, then the answer its push brings', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    expect(h.store.snapshot().status).toEqual(STATUS);
    const sent = h.store.ask('  When do we ship?  ');
    expect(h.store.snapshot().asks[0]).toMatchObject({ question: 'When do we ship?', state: 'asking', answererName: 'Brain' });
    h.answerAsk();
    expect(await sent).toBe(true);
    h.store.handlePush(askPush('answered', 'On Thursday.'));
    expect(h.store.snapshot().asks[0]).toMatchObject({ askId: ASK, state: 'answered', text: 'On Thursday.' });
    // a later failure never replaces an answer
    h.store.handlePush(askPush('failed', 'Too late.'));
    expect(h.store.snapshot().asks[0]!.state).toBe('answered');
  });

  it('keeps a push that comes before the POST answered, and uses it then', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    const sent = h.store.ask('When?');
    h.store.handlePush(askPush('answered', 'Early answer.'));
    expect(h.store.snapshot().asks[0]!.state).toBe('asking');
    h.answerAsk();
    await sent;
    expect(h.store.snapshot().asks[0]).toMatchObject({ state: 'answered', text: 'Early answer.' });
  });

  it('stops waiting when no push came, and ignores a push of another call', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    const sent = h.store.ask('When?');
    h.answerAsk();
    await sent;
    h.store.handlePush({ type: MEETING_ASK_PUSH, payload: { meetingId: '00000000-0000-7000-8000-000000000999', askId: ASK, state: 'answered', answererName: 'Brain', text: 'x' } });
    expect(h.store.snapshot().asks[0]!.state).toBe('asking');
    const wait = h.timers.find((t) => t.ms === ASK_WAIT_MS)!;
    wait.fn();
    expect(h.store.snapshot().asks[0]).toMatchObject({ state: 'failed' });
    expect(h.store.snapshot().asks[0]!.text).toMatch(/thread/);
  });

  it('says the server’s reason when the question is refused, and drops it from the list', async () => {
    const h = harness({ ask: async () => Promise.reject(new ApiError({ code: 'conflict', status: 409, message: 'Join the call to use the assistant.' })) });
    h.store.follow(ROOM);
    await flush();
    expect(await h.store.ask('When?')).toBe(false);
    expect(h.store.snapshot()).toMatchObject({ asks: [], error: 'Join the call to use the assistant.' });
  });

  it('lists a question asked elsewhere from its own push, waiting, then answered; and stops waiting when nothing came', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    h.store.handlePush({ type: MEETING_ASK_PUSH, payload: { meetingId: ROOM, askId: ASK, state: 'asking', answererName: 'Brain', text: '', question: 'From the other tab?' } });
    expect(h.store.snapshot().asks).toEqual([expect.objectContaining({ askId: ASK, question: 'From the other tab?', state: 'asking' })]);
    // a second "asking" of the same question adds no second line
    h.store.handlePush({ type: MEETING_ASK_PUSH, payload: { meetingId: ROOM, askId: ASK, state: 'asking', answererName: 'Brain', text: '', question: 'From the other tab?' } });
    expect(h.store.snapshot().asks).toHaveLength(1);
    h.store.handlePush(askPush('failed', 'Brain could not answer from what everyone in the call may read.'));
    expect(h.store.snapshot().asks[0]).toMatchObject({ state: 'failed', text: 'Brain could not answer from what everyone in the call may read.' });
    const other = '00000000-0000-4000-8000-000000000202';
    h.store.handlePush({ type: MEETING_ASK_PUSH, payload: { meetingId: ROOM, askId: other, state: 'asking', answererName: 'Brain', text: '', question: 'Again?' } });
    h.timers.filter((t) => t.ms === ASK_WAIT_MS).at(-1)!.fn();
    expect(h.store.snapshot().asks.find((a) => a.askId === other)).toMatchObject({ state: 'failed' });
  });

  it('keeps one line when its own "asking" push comes before the POST answered', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    const sent = h.store.ask('Mine?');
    h.store.handlePush({ type: MEETING_ASK_PUSH, payload: { meetingId: ROOM, askId: ASK, state: 'asking', answererName: 'Brain', text: '', question: 'Mine?' } });
    h.answerAsk();
    await sent;
    expect(h.store.snapshot().asks).toEqual([expect.objectContaining({ askId: ASK, question: 'Mine?', state: 'asking' })]);
  });

  it('starts empty for another call', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    const sent = h.store.ask('When?');
    h.answerAsk();
    await sent;
    h.store.follow('00000000-0000-7000-8000-000000000102');
    expect(h.store.snapshot().asks).toEqual([]);
  });
});

describe('Catch me up', () => {
  it('writes, then shows the summary that was pushed to this person', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    await h.store.catchUp();
    expect(h.store.snapshot().catchUp).toEqual({ kind: 'writing', requestId: REQ, minutesBefore: 12 });
    h.store.handlePush({ type: MEETING_CATCHUP_PUSH, payload: { meetingId: ROOM, requestId: REQ, state: 'ready', minutesBefore: 12, text: 'You missed the plan.' } });
    expect(h.store.snapshot().catchUp).toEqual({ kind: 'ready', minutesBefore: 12, text: 'You missed the plan.' });
    h.store.dismissCatchUp();
    expect(h.store.snapshot().catchUp).toEqual({ kind: 'idle' });
  });

  it('says so when the summary never came, or the server refused', async () => {
    const h = harness();
    h.store.follow(ROOM);
    await flush();
    await h.store.catchUp();
    h.timers.at(-1)!.fn();
    expect(h.store.snapshot().catchUp).toMatchObject({ kind: 'failed' });
    const refused = harness({ catchUp: async () => Promise.reject(new ApiError({ code: 'rate_limited', status: 429, message: 'Try again in 10 minutes.' })) });
    refused.store.follow(ROOM);
    await flush();
    await refused.store.catchUp();
    expect(refused.store.snapshot()).toMatchObject({ catchUp: { kind: 'idle' }, error: 'Try again in 10 minutes.' });
  });
});

describe('the panel', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
  });

  it('draws Catch me up, the box and the answers; the reason instead of the box when Ask is not available', async () => {
    const { AssistantPanel } = await import('../src/meetings/AssistantPanel');
    const { assistantStore } = await import('../src/meetings/assistant');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const snap = {
      ...assistantStore().snapshot(),
      meetingId: ROOM,
      status: STATUS,
      open: true,
      asks: [{ key: 'k', askId: ASK, question: 'When?', state: 'answered' as const, answererName: 'Brain', text: 'Thursday.' }],
    };
    act(() => root!.render(createElement(AssistantPanel, { snap, canOpenThread: true, onOpenThread: () => undefined })));
    expect(host.querySelector('[data-testid="assistant-catchup-btn"]')?.textContent).toBe('Catch me up · 12 minutes so far');
    expect(host.querySelector('[data-testid="assistant-question"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="assistant-answer"]')?.textContent).toBe('Thursday.');
    expect(host.textContent).toContain('Ask Brain');
    // a question still on its way says Brain is looking; a failure shows its sentence
    const waiting = { ...snap, asks: [{ key: 'w', askId: ASK, question: 'When?', state: 'asking' as const, answererName: 'Brain', text: '' }] };
    act(() => root!.render(createElement(AssistantPanel, { snap: waiting, canOpenThread: true, onOpenThread: () => undefined })));
    expect(host.querySelector('[data-testid="assistant-ask-item"]')?.textContent).toContain('Brain is looking…');
    const failed = { ...snap, asks: [{ key: 'f', askId: ASK, question: 'When?', state: 'failed' as const, answererName: 'Brain', text: 'Brain took too long. Try a shorter question.' }] };
    act(() => root!.render(createElement(AssistantPanel, { snap: failed, canOpenThread: true, onOpenThread: () => undefined })));
    expect(host.querySelector('[data-testid="assistant-answer"]')?.textContent).toBe('Brain took too long. Try a shorter question.');
    const closed = { ...snap, status: { ...STATUS, ask: { available: false, answerer: null, reason: 'Join the call to use the assistant.' } } };
    act(() => root!.render(createElement(AssistantPanel, { snap: closed, canOpenThread: false, onOpenThread: () => undefined })));
    expect(host.querySelector('[data-testid="assistant-question"]')).toBeNull();
    expect(host.querySelector('[data-testid="assistant-ask-reason"]')?.textContent).toBe('Join the call to use the assistant.');
    expect(host.querySelector('[data-testid="assistant-open-thread"]')).toBeNull();
  });
});
