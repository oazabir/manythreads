import type { BotId, ChannelId, ListThreadRunsResponse, MessageId, RunActivityResponse, RunHead, RunId } from '@manythreads/shared';
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function setup(runs: RunHead[] = [head()]) {
  const state = { runs };
  const deps = {
    listRuns: vi.fn(async (): Promise<ListThreadRunsResponse> => ({ runs: state.runs })),
    activity: vi.fn(async (): Promise<RunActivityResponse> => ({ run: head(), plan: [], items: [], hasMore: false })),
    watch: vi.fn(async () => ({ expiresAt: 'x' })),
    unwatch: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ stopped: true })),
  } satisfies ThreadRunsDeps;
  const store = new ThreadRunsStore(deps);
  return { store, deps, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the lease of an open thread', () => {
  it('is taken when a panel opens, renewed every 30 seconds, and let go when the last panel closes', async () => {
    const { store, deps } = setup();
    const closeA = store.open(ROOT);
    const closeB = store.open(ROOT);
    expect(deps.watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.watch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.watch).toHaveBeenCalledTimes(3);
    closeA();
    expect(deps.unwatch).not.toHaveBeenCalled();
    closeB();
    closeB();
    expect(deps.unwatch).toHaveBeenCalledTimes(1);
    expect(deps.unwatch).toHaveBeenCalledWith(ROOT);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.watch).toHaveBeenCalledTimes(3);
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
  const started = (runId: string) => ({ runId, channelId: CH, threadRootId: ROOT, botId: BOT, botActorId: null, botName: 'Coder', startedAt: '2026-11-14T10:00:00.000Z' });

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
