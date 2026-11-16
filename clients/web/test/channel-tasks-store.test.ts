import type { ActiveChannelRunsResponse, Approval, BotId, ChannelId, MessageId, RunActivityResponse, RunHead, RunId, ThreadTodo } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelTasksStore, EMPTY_TASK_VIEW, READ_DEBOUNCE_MS, STEPS_EVERY_MS, type ChannelTasksDeps } from '../src/taskview/channelTasks';

// The data layer of the task view under a channel's roots (P29-04): one lease for the channel, three batched reads, pushes that move what is held, a debounced read for what is
// unknown, the last steps read at most once per three seconds, and a shared empty state for a root with nothing.

const CH = '00000000-0000-7000-8000-0000000f0001' as ChannelId;
const OTHER_CH = '00000000-0000-7000-8000-0000000f0002' as ChannelId;
const ROOT = '00000000-0000-7000-8000-0000000e0001' as MessageId;
const ROOT2 = '00000000-0000-7000-8000-0000000e0002' as MessageId;
const RUN = '00000000-0000-7000-8000-000000a00001' as RunId;
const RUN2 = '00000000-0000-7000-8000-000000a00002' as RunId;
const BOT = '00000000-0000-7000-8000-000000b00001' as BotId;
const LEASE = '00000000-0000-4000-8000-0000000c0001';

const head = (over: Partial<RunHead> = {}): RunHead => ({
  state: 'working',
  now: null,
  counts: { steps: 0, failed: 0, commands: 0, filesChanged: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 },
  plan: { done: 0, total: 0, current: null },
  planVersion: 0,
  helpers: [],
  seq: 3,
  stoppedBy: null,
  runId: RUN,
  botId: BOT,
  botActorId: null,
  botName: 'Engineer',
  channelId: CH,
  threadRootId: ROOT,
  askerActorId: null,
  conversation: false,
  startedAt: '2026-11-16T10:00:00.000Z',
  endedAt: null,
  stopReason: null,
  cost: null,
  canStop: true,
  ...over,
});

const todo = (rootId: MessageId, version = 1, status: 'working' | 'done' = 'working'): ThreadTodo =>
  ({ rootId, channelId: CH, messageId: null, botActorId: '00000000-0000-7000-8000-000000aa0001', title: 'Plan', items: [{ id: 'a', text: 'One', status }], version, updatedAt: '2026-11-16T10:00:00.000Z' }) as ThreadTodo;

const question = (id: string, rootId: MessageId): Approval => ({ id, threadRootId: rootId, channelId: CH, status: 'pending' }) as unknown as Approval;

const activityPush = (over: Record<string, unknown> = {}) => ({
  type: 'run.activity',
  payload: { runId: RUN, channelId: CH, threadRootId: ROOT, state: 'working', now: null, counts: head().counts, plan: head().plan, planVersion: 0, helpers: [], seq: 5, stoppedBy: null, ...over },
});

function setup(init: { runs?: ActiveChannelRunsResponse; todos?: ThreadTodo[]; questions?: Approval[] } = {}) {
  const state = {
    runs: init.runs ?? ({ runs: [{ runId: RUN, channelId: CH, threadRootId: ROOT, botId: BOT, botActorId: null, botName: 'Engineer', startedAt: head().startedAt, head: head() }] } as ActiveChannelRunsResponse),
    todos: init.todos ?? [],
    questions: init.questions ?? [],
  };
  const deps = {
    activeRuns: vi.fn(async () => state.runs),
    todos: vi.fn(async () => ({ todos: state.todos })),
    approvals: vi.fn(async () => ({ items: state.questions })),
    activity: vi.fn(async (): Promise<RunActivityResponse> => ({ run: head(), plan: [], items: [], hasMore: false })),
    watch: vi.fn(async () => ({ expiresAt: 'x' })),
    unwatch: vi.fn(async () => ({ ok: true })),
    newLeaseId: () => LEASE,
    now: () => Date.now(),
  } satisfies ChannelTasksDeps;
  const store = new ChannelTasksStore(deps);
  return { store, deps, state };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('opening a channel', () => {
  it('takes ONE lease and makes three reads for the whole channel, whatever rows are on screen', async () => {
    const { store, deps } = setup({ todos: [todo(ROOT)], questions: [question('q1', ROOT)] });
    store.track(CH);
    await settle();
    expect(deps.watch).toHaveBeenCalledTimes(1);
    expect(deps.watch).toHaveBeenCalledWith(CH, LEASE);
    expect(deps.activeRuns).toHaveBeenCalledTimes(1);
    expect(deps.todos).toHaveBeenCalledTimes(1);
    expect(deps.approvals).toHaveBeenCalledTimes(1);
    const view = store.stateOf(ROOT);
    expect(view.run?.runId).toBe(RUN);
    expect(view.todo?.version).toBe(1);
    expect(view.questions.map((q) => q.id)).toEqual(['q1']);
  });

  it('renews the lease every 20 seconds and lets go when the last page leaves, and a second page of the channel shares everything', async () => {
    const { store, deps } = setup();
    const a = store.track(CH);
    const b = store.track(CH);
    await settle();
    expect(deps.watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.watch).toHaveBeenCalledTimes(2);
    a();
    expect(deps.unwatch).not.toHaveBeenCalled();
    b();
    await settle();
    expect(deps.unwatch).toHaveBeenCalledWith(CH, LEASE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.watch).toHaveBeenCalledTimes(2);
  });

  it('a root with nothing answers the one shared empty state', async () => {
    const { store } = setup();
    store.track(CH);
    await settle();
    expect(store.stateOf(ROOT2)).toBe(EMPTY_TASK_VIEW);
    expect(store.stateOf('never-seen' as MessageId)).toBe(EMPTY_TASK_VIEW);
  });
});

describe('pushes', () => {
  it('run.activity moves the head that is held, and only the root of that run is told', async () => {
    const { store } = setup();
    store.track(CH);
    await settle();
    const mine = vi.fn();
    const other = vi.fn();
    store.subscribe(ROOT, mine);
    store.subscribe(ROOT2, other);
    store.handlePush(activityPush({ seq: 6, now: { kind: 'execute', title: 'Run pnpm lint', paths: [], helper: null, count: 1 } }) as never);
    expect(store.stateOf(ROOT).run?.seq).toBe(6);
    expect(mine).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('a run the page does not know makes ONE debounced read of the channel\'s runs, however many pushes, and never a read of a thread', async () => {
    const { store, deps, state } = setup({ runs: { runs: [] } as ActiveChannelRunsResponse });
    store.track(CH);
    await settle();
    expect(deps.activeRuns).toHaveBeenCalledTimes(1);
    state.runs = { runs: [{ runId: RUN2, channelId: CH, threadRootId: ROOT2, botId: BOT, botActorId: null, botName: 'Coder', startedAt: head().startedAt, head: head({ runId: RUN2, threadRootId: ROOT2 }) }] } as ActiveChannelRunsResponse;
    for (let i = 0; i < 5; i += 1) store.handlePush(activityPush({ runId: RUN2, threadRootId: ROOT2, seq: i }) as never);
    store.handlePush({ type: 'run.started', payload: { runId: RUN2, channelId: CH, threadRootId: ROOT2, botId: BOT, botActorId: null, botName: 'Coder', startedAt: head().startedAt } } as never);
    expect(deps.activeRuns).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    expect(deps.activeRuns).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT2).run?.runId).toBe(RUN2);
  });

  it('run.ended makes one debounced read, and the run then shows as ended (from `recent`), not as working', async () => {
    const { store, state } = setup();
    store.track(CH);
    await settle();
    state.runs = { runs: [], recent: [head({ state: 'done', endedAt: '2026-11-16T10:05:00.000Z', now: null })] } as ActiveChannelRunsResponse;
    store.handlePush({ type: 'run.ended', payload: { runId: RUN, channelId: CH, threadRootId: ROOT, status: 'done' } } as never);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    const view = store.stateOf(ROOT);
    expect(view.run).toBeNull();
    expect(view.ended?.state).toBe('done');
  });

  it('todo.changed reads the channel\'s lists once when its version is newer, and not for an older one or another channel', async () => {
    const { store, deps, state } = setup({ todos: [todo(ROOT, 2)] });
    store.track(CH);
    await settle();
    store.handlePush({ type: 'todo.changed', payload: { channelId: CH, rootId: ROOT, version: 2 } } as never);
    store.handlePush({ type: 'todo.changed', payload: { channelId: OTHER_CH, rootId: ROOT, version: 9 } } as never);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    expect(deps.todos).toHaveBeenCalledTimes(1);
    state.todos = [todo(ROOT, 3)];
    for (let i = 0; i < 4; i += 1) store.handlePush({ type: 'todo.changed', payload: { channelId: CH, rootId: ROOT, version: 3 } } as never);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    expect(deps.todos).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).todo?.version).toBe(3);
  });

  it('approval.changed reads the questions only for this channel; one that names no channel costs nothing', async () => {
    const { store, deps, state } = setup();
    store.track(CH);
    await settle();
    store.handlePush({ type: 'approval.changed', payload: { teamId: '00000000-0000-7000-8000-0000000d0001', approvalId: '00000000-0000-7000-8000-0000000a0001' } } as never);
    store.handlePush({ type: 'approval.changed', payload: { teamId: '00000000-0000-7000-8000-0000000d0001', approvalId: '00000000-0000-7000-8000-0000000a0001', channelId: OTHER_CH, threadRootId: ROOT } } as never);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    expect(deps.approvals).toHaveBeenCalledTimes(1);
    state.questions = [question('q9', ROOT)];
    store.handlePush({ type: 'approval.changed', payload: { teamId: '00000000-0000-7000-8000-0000000d0001', approvalId: '00000000-0000-7000-8000-0000000a0002', channelId: CH, threadRootId: ROOT } } as never);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10);
    expect(deps.approvals).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).questions.map((q) => q.id)).toEqual(['q9']);
  });
});

describe('the last steps', () => {
  it('are read once when the head first shows, and again when seq moves, at most once per three seconds per run', async () => {
    const { store, deps } = setup();
    store.track(CH);
    await settle();
    expect(deps.activity).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i += 1) store.handlePush(activityPush({ seq: 10 + i }) as never);
    await settle();
    expect(deps.activity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STEPS_EVERY_MS + 10);
    expect(deps.activity).toHaveBeenCalledTimes(2);
    // a push that changes nothing about seq reads nothing
    store.handlePush(activityPush({ seq: 29 }) as never);
    await vi.advanceTimersByTimeAsync(STEPS_EVERY_MS * 3);
    expect(deps.activity).toHaveBeenCalledTimes(2);
  });

  it('are read from a little behind the newest line, never from the start of a long run', async () => {
    const { store, deps } = setup({ runs: { runs: [{ runId: RUN, channelId: CH, threadRootId: ROOT, botId: BOT, botActorId: null, botName: 'E', startedAt: head().startedAt, head: head({ seq: 900 }) }] } as ActiveChannelRunsResponse });
    store.track(CH);
    await settle();
    expect(deps.activity).toHaveBeenCalledWith(RUN, 860);
  });
});

describe('leaving', () => {
  it('forgets the channel: roots are empty again and a late push changes nothing', async () => {
    const { store } = setup({ todos: [todo(ROOT)] });
    const off = store.track(CH);
    await settle();
    expect(store.stateOf(ROOT).todo).not.toBeNull();
    off();
    expect(store.stateOf(ROOT)).toBe(EMPTY_TASK_VIEW);
    store.handlePush(activityPush() as never);
  });
});
