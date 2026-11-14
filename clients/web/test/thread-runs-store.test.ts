import type { ActiveChannelRunsResponse, BotId, ChannelId, ListThreadRunsResponse, MessageId, RunActivityResponse, RunHead, RunId } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadRunsStore, type ThreadRunsDeps } from '../src/runs/threadRuns';

// The data layer of a run card in a thread (P25-07): the lease while a panel is open, the head of each run kept by pushes, the answer preview, the lines, Stop.

const ROOT = '00000000-0000-7000-8000-0000000e0001' as MessageId;
const OTHER = '00000000-0000-7000-8000-0000000e0002' as MessageId;
const CH = '00000000-0000-7000-8000-0000000f0001' as ChannelId;
const RUN = '00000000-0000-7000-8000-000000a00001' as RunId;
const RUN2 = '00000000-0000-7000-8000-000000a00002' as RunId;
const BOT = '00000000-0000-7000-8000-000000b00001' as BotId;

const head = (over: Partial<RunHead> = {}): RunHead => ({
  state: 'working',
  now: null,
  counts: { steps: 0, failed: 0, commands: 0, filesChanged: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 },
  plan: { done: 0, total: 0, current: null },
  planVersion: 0,
  helpers: [],
  seq: -1,
  stoppedBy: null,
  runId: RUN,
  botId: BOT,
  botActorId: null,
  botName: 'Coder',
  channelId: CH,
  threadRootId: ROOT,
  askerActorId: null,
  conversation: false,
  startedAt: '2026-11-14T10:00:00.000Z',
  endedAt: null,
  stopReason: null,
  cost: null,
  canStop: true,
  ...over,
});

const progress = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  channelId: CH,
  threadRootId: ROOT,
  state: 'working',
  now: { kind: 'read', title: 'Read a.ts', paths: ['a.ts'], helper: null, count: 1 },
  counts: { steps: 3, failed: 0, commands: 0, filesChanged: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 },
  plan: { done: 1, total: 2, current: 'Write the test' },
  planVersion: 2,
  helpers: [],
  seq: 4,
  stoppedBy: null,
  ...over,
});

const LEASE = '00000000-0000-4000-8000-0000000c0001';
const ONE_HOUR = 3_600_000;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function setup(runs: RunHead[] = [head()]) {
  const state = { runs, active: [] as ActiveChannelRunsResponse['runs'] };
  const deps = {
    listRuns: vi.fn(async (): Promise<ListThreadRunsResponse> => ({ runs: state.runs })),
    activity: vi.fn(async (): Promise<RunActivityResponse> => ({ run: head(), plan: [], items: [], hasMore: false })),
    watch: vi.fn(async () => ({ expiresAt: 'x' })),
    unwatch: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ stopped: true })),
    activeRuns: vi.fn(async (): Promise<ActiveChannelRunsResponse> => ({ runs: state.active })),
    newLeaseId: () => LEASE,
  } satisfies ThreadRunsDeps;
  const store = new ThreadRunsStore(deps);
  return { store, deps, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the lease of an open thread', () => {
  it('is taken when a panel opens, renewed every 20 seconds, and let go when the last panel closes', async () => {
    const { store, deps } = setup();
    const closeA = store.open(ROOT);
    const closeB = store.open(ROOT);
    await flush();
    expect(deps.watch).toHaveBeenCalledTimes(1);
    expect(deps.watch).toHaveBeenCalledWith(ROOT, LEASE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.watch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.watch).toHaveBeenCalledTimes(3);
    closeA();
    expect(deps.unwatch).not.toHaveBeenCalled();
    closeB();
    closeB();
    await flush();
    expect(deps.unwatch).toHaveBeenCalledTimes(1);
    expect(deps.unwatch).toHaveBeenCalledWith(ROOT, LEASE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.watch).toHaveBeenCalledTimes(3);
  });

  it('keeps one lease per tab for every thread, and two panels of two threads each have their own lease call', async () => {
    const { store, deps } = setup();
    const closeA = store.open(ROOT);
    const closeB = store.open(OTHER);
    await flush();
    expect(deps.watch.mock.calls).toEqual([
      [ROOT, LEASE],
      [OTHER, LEASE],
    ]);
    closeA();
    await flush();
    expect(deps.unwatch.mock.calls).toEqual([[ROOT, LEASE]]);
    await vi.advanceTimersByTimeAsync(20_000);
    // only the thread that is still open is renewed
    expect(deps.watch.mock.calls.slice(2)).toEqual([[OTHER, LEASE]]);
    closeB();
  });

  it('a close never overtakes the open before it, and a reopen comes after the close', async () => {
    const { store, deps } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    deps.watch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            order.push('watch done');
            resolve({ expiresAt: 'x' });
          };
        }),
    );
    deps.unwatch.mockImplementation(async () => {
      order.push('unwatch');
      return { ok: true };
    });
    const close = store.open(ROOT);
    close();
    const reopen = store.open(ROOT);
    await flush();
    expect(order).toEqual([]); // the unwatch waits for the watch that is in flight
    release();
    await flush();
    expect(order).toEqual(['watch done', 'unwatch']);
    expect(deps.watch).toHaveBeenCalledTimes(2); // the reopen's own
    reopen();
  });

  it('is renewed and the runs are read again when the tab comes back into view', async () => {
    const { store, deps } = setup();
    // the test runs in node: a stand-in for the page's `document`
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      fire: () => [...listeners].forEach((l) => l()),
    };
    vi.stubGlobal('document', doc);
    store.attach({ onPush: () => () => undefined, onReconnected: () => () => undefined } as never);
    store.open(ROOT);
    await flush();
    expect(deps.watch).toHaveBeenCalledTimes(1);
    expect(deps.listRuns).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    doc.fire();
    await flush();
    expect(deps.watch).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'visible';
    doc.fire();
    await flush();
    expect(deps.watch).toHaveBeenCalledTimes(2);
    expect(deps.listRuns).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('a failing lease does not break the panel', async () => {
    const { store, deps } = setup();
    deps.watch.mockRejectedValue(new Error('no'));
    store.open(ROOT);
    await flush();
    expect(store.stateOf(ROOT).loaded).toBe(true);
  });
});

describe('the runs of a thread', () => {
  it('are read when the panel opens, and notify listeners', async () => {
    const { store } = setup();
    const seen = vi.fn();
    store.subscribe(ROOT, seen);
    store.open(ROOT);
    expect(store.stateOf(ROOT)).toMatchObject({ loaded: false, runs: [] });
    await flush();
    expect(store.stateOf(ROOT).runs.map((r) => r.runId)).toEqual([RUN]);
    expect(seen).toHaveBeenCalled();
  });

  it('a run.activity push replaces the folded part of the head and keeps the rest', async () => {
    const { store } = setup();
    store.open(ROOT);
    await flush();
    store.handlePush({ type: 'run.activity', id: 'p1', payload: progress() });
    const run = store.stateOf(ROOT).runs[0]!;
    expect(run).toMatchObject({ botName: 'Coder', canStop: true, seq: 4, planVersion: 2 });
    expect(run.now?.title).toBe('Read a.ts');
    expect(run.counts.steps).toBe(3);
  });

  it('a late push does not bring an ended run back', async () => {
    const { store } = setup([head({ state: 'done', endedAt: '2026-11-14T10:01:00.000Z', canStop: false })]);
    store.open(ROOT);
    await flush();
    store.handlePush({ type: 'run.activity', id: 'p1', payload: progress() });
    expect(store.stateOf(ROOT).runs[0]!.state).toBe('done');
  });

  it('a push for a run the store does not know reads the list again', async () => {
    const { store, deps, state } = setup([]);
    store.open(ROOT);
    await flush();
    expect(deps.listRuns).toHaveBeenCalledTimes(1);
    state.runs = [head()];
    store.handlePush({ type: 'run.activity', id: 'p1', payload: progress() });
    await flush();
    expect(deps.listRuns).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).runs).toHaveLength(1);
  });

  it('ignores pushes for a thread that is not open, and ones it cannot read', async () => {
    const { store, deps } = setup();
    store.open(ROOT);
    await flush();
    store.handlePush({ type: 'run.activity', id: 'p1', payload: progress({ threadRootId: OTHER }) });
    store.handlePush({ type: 'run.activity', id: 'p2', payload: { nonsense: true } });
    store.handlePush({ type: 'message.created', id: 'p3', payload: {} });
    expect(deps.listRuns).toHaveBeenCalledTimes(1);
    expect(store.stateOf(ROOT).runs[0]!.seq).toBe(-1);
  });

  it('a read while a read is on its way asks for one more after it', async () => {
    const { store, deps } = setup();
    store.open(ROOT);
    void store.load(ROOT);
    void store.load(ROOT);
    await flush();
    await flush();
    expect(deps.listRuns.mock.calls.length).toBe(2);
  });

  it('a failed read leaves the panel loaded and the rows as they were', async () => {
    const { store, deps } = setup();
    deps.listRuns.mockRejectedValue(new Error('down'));
    store.open(ROOT);
    await flush();
    expect(store.stateOf(ROOT)).toMatchObject({ loaded: true, runs: [] });
  });
});

describe('the answer preview', () => {
  it('grows with run.delta in order, ignores a piece it already has, and stops at a hole', async () => {
    const { store } = setup();
    store.open(ROOT);
    await flush();
    const delta = (offset: number, text: string): void => store.handlePush({ type: 'run.delta', id: 'd', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, offset, text } });
    delta(0, 'Hello ');
    delta(6, 'world');
    delta(6, 'world');
    expect(store.stateOf(ROOT).answers[RUN]).toBe('Hello world');
    delta(50, ' lost');
    delta(11, '!');
    expect(store.stateOf(ROOT).answers[RUN]).toBe('Hello world');
  });

  it('goes when the run ends, and the head says how it ended', async () => {
    const { store, state } = setup();
    store.open(ROOT);
    await flush();
    store.handlePush({ type: 'run.delta', id: 'd', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, offset: 0, text: 'Hi' } });
    state.runs = [head({ state: 'stopped', stoppedBy: 'Rafi', endedAt: '2026-11-14T10:02:00.000Z', canStop: false })];
    store.handlePush({ type: 'run.ended', id: 'e', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, status: 'stopped' } });
    expect(store.stateOf(ROOT).answers[RUN]).toBeUndefined();
    expect(store.stateOf(ROOT).runs[0]).toMatchObject({ state: 'stopped', canStop: false });
    await flush();
    expect(store.stateOf(ROOT).runs[0]).toMatchObject({ stoppedBy: 'Rafi', endedAt: '2026-11-14T10:02:00.000Z' });
  });
});

describe('the chip on a thread root (run.started and run.ended reach every reader of the channel)', () => {
  const started = (runId: string) => ({ runId, channelId: CH, threadRootId: ROOT, botId: BOT, botActorId: null, botName: 'Coder', startedAt: new Date(Date.now()).toISOString() });

  it('is known without the thread being open, once per run, and goes with run.ended', () => {
    const { store, deps } = setup();
    const seen = vi.fn();
    store.subscribe(ROOT, seen);
    store.handlePush({ type: 'run.started', id: 's1', payload: started(RUN) });
    store.handlePush({ type: 'run.started', id: 's2', payload: started(RUN) });
    store.handlePush({ type: 'run.started', id: 's3', payload: started(RUN2) });
    expect(store.workingOn(ROOT).map((r) => r.runId)).toEqual([RUN, RUN2]);
    expect(store.workingOn(OTHER)).toEqual([]);
    expect(seen).toHaveBeenCalled();
    expect(deps.listRuns).not.toHaveBeenCalled();
    store.handlePush({ type: 'run.ended', id: 'e1', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, status: 'done' } });
    expect(store.workingOn(ROOT).map((r) => r.runId)).toEqual([RUN2]);
    store.handlePush({ type: 'run.ended', id: 'e2', payload: { runId: RUN2, channelId: CH, threadRootId: ROOT, status: 'failed' } });
    expect(store.workingOn(ROOT)).toEqual([]);
  });

  it('an open thread reads its runs when one starts', async () => {
    const { store, deps } = setup([]);
    store.open(ROOT);
    await flush();
    store.handlePush({ type: 'run.started', id: 's1', payload: started(RUN) });
    await flush();
    expect(deps.listRuns).toHaveBeenCalledTimes(2);
  });
});

describe('the answer preview and the runs it belongs to', () => {
  const delta = (store: ThreadRunsStore, runId: string, offset: number, text: string, span?: number): void =>
    store.handlePush({ type: 'run.delta', id: 'd', payload: { runId, channelId: CH, threadRootId: ROOT, offset, text, ...(span === undefined ? {} : { span }) } });

  it('places the next piece after the span of a redacted piece, not after its text', async () => {
    const { store } = setup();
    store.open(ROOT);
    await flush();
    delta(store, RUN, 0, 'The key is [hidden]', 30);
    delta(store, RUN, 30, ' ok');
    expect(store.stateOf(ROOT).answers[RUN]).toBe('The key is [hidden] ok');
    delta(store, RUN, 19, 'again'); // a piece that starts inside what the span covered is one already held
    expect(store.stateOf(ROOT).answers[RUN]).toBe('The key is [hidden] ok');
  });

  it('ignores pieces of a run that has ended, and of one it does not know (it reads the list instead)', async () => {
    const { store, deps } = setup([head(), head({ runId: RUN2, state: 'done', endedAt: '2026-11-14T10:01:00.000Z', canStop: false })]);
    store.open(ROOT);
    await flush();
    delta(store, RUN2, 0, 'late');
    expect(store.stateOf(ROOT).answers[RUN2]).toBeUndefined();
    const unknown = '00000000-0000-7000-8000-000000a00009';
    delta(store, unknown, 0, 'who');
    expect(store.stateOf(ROOT).answers[unknown]).toBeUndefined();
    await flush();
    expect(deps.listRuns).toHaveBeenCalledTimes(2);
  });

  it('a list read keeps the answer of a working run with its offset, and drops the answer of a run that ended', async () => {
    const { store, state } = setup([head(), head({ runId: RUN2 })]);
    store.open(ROOT);
    await flush();
    delta(store, RUN, 0, 'abc');
    delta(store, RUN2, 0, 'xyz');
    state.runs = [head({ seq: 3 }), head({ runId: RUN2, state: 'done', endedAt: '2026-11-14T10:01:00.000Z', canStop: false })];
    await store.load(ROOT);
    expect(store.stateOf(ROOT).answers).toEqual({ [RUN]: 'abc' });
    delta(store, RUN, 3, 'def');
    expect(store.stateOf(ROOT).answers[RUN]).toBe('abcdef'); // the offset of the working run is still there
    delta(store, RUN2, 0, 'late');
    expect(store.stateOf(ROOT).answers[RUN2]).toBeUndefined();
  });

  it('a run the list no longer has leaves no old hole and no old length behind', async () => {
    const { store, state } = setup([head(), head({ runId: RUN2 })]);
    store.open(ROOT);
    await flush();
    delta(store, RUN2, 0, 'xyz');
    delta(store, RUN2, 99, 'hole'); // run 2 is broken now
    state.runs = [head()];
    await store.load(ROOT);
    expect(store.stateOf(ROOT).answers).toEqual({});
    state.runs = [head(), head({ runId: RUN2 })];
    await store.load(ROOT);
    delta(store, RUN2, 0, 'new');
    expect(store.stateOf(ROOT).answers[RUN2]).toBe('new');
  });
});

describe('the chips of a channel', () => {
  const chip = (runId: string, over: Record<string, unknown> = {}) => ({
    runId,
    channelId: CH,
    threadRootId: ROOT,
    botId: BOT,
    botActorId: null,
    botName: 'Coder',
    startedAt: new Date(Date.now()).toISOString(),
    ...over,
  });

  it('goes by itself three hours after the run began, if its run.ended was lost', async () => {
    const { store } = setup();
    store.handlePush({ type: 'run.started', id: 's1', payload: chip(RUN) });
    expect(store.workingOn(ROOT)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * ONE_HOUR);
    expect(store.workingOn(ROOT)).toHaveLength(1);
    const seen = vi.fn();
    store.subscribe(ROOT, seen);
    await vi.advanceTimersByTimeAsync(ONE_HOUR + 1);
    expect(store.workingOn(ROOT)).toEqual([]);
    expect(seen).toHaveBeenCalled();
  });

  it('counts the time from when the run began, not from when the push arrived (a chip of an old run is not shown at all)', () => {
    const { store } = setup();
    store.handlePush({ type: 'run.started', id: 's1', payload: chip(RUN, { startedAt: new Date(Date.now() - 4 * ONE_HOUR).toISOString() }) });
    expect(store.workingOn(ROOT)).toEqual([]);
  });

  it('reads the active runs of a tracked channel, and replaces what the pushes had told', async () => {
    const { store, deps, state } = setup();
    store.handlePush({ type: 'run.started', id: 's1', payload: chip(RUN2) }); // began, then ended unseen
    state.active = [chip(RUN) as never];
    const release = store.trackChannel(CH);
    await flush();
    expect(deps.activeRuns).toHaveBeenCalledWith(CH);
    expect(store.workingOn(ROOT).map((r) => r.runId)).toEqual([RUN]);
    release();
    release();
  });

  it('does not bring back a chip whose run.ended came while the read was on its way', async () => {
    const { store, state } = setup();
    state.active = [chip(RUN) as never];
    const release = store.trackChannel(CH);
    store.handlePush({ type: 'run.ended', id: 'e1', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, status: 'done' } });
    await flush();
    expect(store.workingOn(ROOT)).toEqual([]);
    store.handlePush({ type: 'run.started', id: 's1', payload: chip(RUN) }); // a late copy
    expect(store.workingOn(ROOT)).toEqual([]);
    release();
  });

  it('is cleared and read again after a reconnect, for the channels a page tracks', async () => {
    const { store, deps, state } = setup();
    let reopen: () => void = () => undefined;
    store.attach({ onPush: () => () => undefined, onReconnected: (l: () => void) => ((reopen = l), () => undefined) } as never);
    state.active = [chip(RUN) as never];
    store.trackChannel(CH);
    await flush();
    store.handlePush({ type: 'run.started', id: 's1', payload: chip(RUN2) });
    expect(store.workingOn(ROOT)).toHaveLength(2);
    state.active = []; // while the socket was down both ended
    reopen();
    expect(store.workingOn(ROOT)).toEqual([]); // cleared at once: the truth is unknown until the read
    await flush();
    expect(deps.activeRuns).toHaveBeenCalledTimes(2);
    expect(store.workingOn(ROOT)).toEqual([]);
    state.active = [chip(RUN) as never];
    reopen();
    await flush();
    expect(store.workingOn(ROOT).map((r) => r.runId)).toEqual([RUN]);
  });
});

describe('after a reconnect', () => {
  it('takes the lease again and reads the runs again', async () => {
    const { store, deps } = setup();
    let reopen: () => void = () => undefined;
    store.attach({ onPush: () => () => undefined, onReconnected: (l: () => void) => ((reopen = l), () => undefined) } as never);
    store.open(ROOT);
    await flush();
    reopen();
    await flush();
    expect(deps.watch).toHaveBeenCalledTimes(2);
    expect(deps.listRuns).toHaveBeenCalledTimes(2);
  });
});

describe('the lines of a run', () => {
  const item = (seq: number) => ({ seq, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'thinking' as const, seconds: 1 } });

  it('are read page by page and then only past the last one held', async () => {
    const { store, deps } = setup();
    deps.activity
      .mockResolvedValueOnce({ run: head(), plan: [{ content: 'a', status: 'pending' }], items: [item(0), item(1)], hasMore: true })
      .mockResolvedValueOnce({ run: head(), plan: [{ content: 'a', status: 'completed' }], items: [item(2)], hasMore: false });
    await store.loadActivity(RUN);
    expect(deps.activity.mock.calls.map((c) => c as unknown[])).toEqual([[RUN, -1], [RUN, 1]]);
    expect(store.linesOf(RUN).items.map((i) => i.seq)).toEqual([0, 1, 2]);
    expect(store.linesOf(RUN).plan).toEqual([{ content: 'a', status: 'completed' }]);
    expect(store.linesOf(RUN).loading).toBe(false);
    deps.activity.mockResolvedValueOnce({ run: head(), plan: [], items: [item(3)], hasMore: false });
    await store.loadActivity(RUN);
    expect(deps.activity.mock.calls.at(-1)).toEqual([RUN, 2]);
    expect(store.linesOf(RUN).items.map((i) => i.seq)).toEqual([0, 1, 2, 3]);
  });

  it('a call while it reads shares the read; a failure keeps what was read', async () => {
    const { store, deps } = setup();
    deps.activity.mockResolvedValueOnce({ run: head(), plan: [], items: [item(0)], hasMore: true }).mockRejectedValueOnce(new Error('down'));
    const a = store.loadActivity(RUN);
    const b = store.loadActivity(RUN);
    expect(a).toBe(b);
    await a;
    expect(store.linesOf(RUN).items.map((i) => i.seq)).toEqual([0]);
    expect(store.linesOf(RUN).loading).toBe(false);
  });
});

describe('the lines of a run, asked for again while they are read', () => {
  const item = (seq: number) => ({ seq, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'thinking' as const, seconds: 1 } });

  it('a call that joins a read in flight makes it read once more, so a line written meanwhile is not lost', async () => {
    const { store, deps } = setup();
    let finish: (v: RunActivityResponse) => void = () => undefined;
    deps.activity.mockImplementationOnce(
      () =>
        new Promise<RunActivityResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const first = store.loadActivity(RUN);
    await flush();
    const joined = store.loadActivity(RUN); // a run.activity push said there is a new line
    expect(joined).toBe(first);
    deps.activity.mockResolvedValueOnce({ run: head(), plan: [], items: [item(1)], hasMore: false });
    finish({ run: head(), plan: [], items: [item(0)], hasMore: false });
    await first;
    expect(deps.activity.mock.calls.map((c) => c as unknown[])).toEqual([[RUN, -1], [RUN, 0]]);
    expect(store.linesOf(RUN).items.map((i) => i.seq)).toEqual([0, 1]);
    expect(store.linesOf(RUN).loading).toBe(false);
  });
});

describe('Stop', () => {
  it('says "stopping" at once and asks the server', async () => {
    const { store, deps } = setup();
    store.open(ROOT);
    await flush();
    const done = store.stop(ROOT, RUN);
    expect(store.stateOf(ROOT).runs[0]!.state).toBe('stopping');
    await done;
    expect(deps.stop).toHaveBeenCalledWith(RUN);
  });

  it('puts the card back and throws when the server refuses', async () => {
    const { store, deps } = setup();
    deps.stop.mockRejectedValue(new Error('403'));
    store.open(ROOT);
    await flush();
    await expect(store.stop(ROOT, RUN)).rejects.toThrow('403');
    expect(store.stateOf(ROOT).runs[0]!.state).toBe('working');
  });

  it('reads the runs again when the run had already ended', async () => {
    const { store, deps, state } = setup();
    deps.stop.mockResolvedValue({ stopped: false });
    store.open(ROOT);
    await flush();
    state.runs = [head({ state: 'done', canStop: false })];
    await store.stop(ROOT, RUN);
    await flush();
    expect(store.stateOf(ROOT).runs[0]!.state).toBe('done');
  });
});
