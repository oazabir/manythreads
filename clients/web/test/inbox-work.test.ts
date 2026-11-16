import type { ActiveChannelRun, Approval, ThreadTodo } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxWork, NO_WORK, WORK_DEBOUNCE_MS } from '../src/inbox/work';

// P29-15: the Threads view reads what is going on in the listed threads in three batches, never per row, and keeps what it has when a read fails.

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const todo = (root: number, version = 1): ThreadTodo => ({ rootId: id(root), title: 't', version, updatedAt: `2026-11-16T10:00:0${version}.000Z`, items: [] }) as unknown as ThreadTodo;
const run = (root: number, seq = 1): ActiveChannelRun => ({ runId: id(300 + root), threadRootId: id(root), botName: 'Engineer', head: { seq, state: 'working', now: null } }) as unknown as ActiveChannelRun;
const question = (root: number, n = 1): Approval => ({ id: id(700 + n), threadRootId: id(root), status: 'pending', canDecide: true }) as unknown as Approval;

function make(state: { runs?: ActiveChannelRun[]; todos?: ThreadTodo[]; approvals?: Approval[]; fail?: Set<string> } = {}) {
  const calls = { runs: [] as string[][], todos: [] as string[][], approvals: [] as string[][] };
  const deps = {
    runs: vi.fn((roots: readonly string[]) => {
      calls.runs.push([...roots]);
      return state.fail?.has('runs') ? Promise.reject(new Error('down')) : Promise.resolve({ runs: (state.runs ?? []).filter((r) => roots.includes(r.threadRootId)) });
    }),
    todos: vi.fn((roots: readonly string[]) => {
      calls.todos.push([...roots]);
      return state.fail?.has('todos') ? Promise.reject(new Error('down')) : Promise.resolve({ todos: (state.todos ?? []).filter((t) => roots.includes(t.rootId)) });
    }),
    approvals: vi.fn((roots: readonly string[]) => {
      calls.approvals.push([...roots]);
      return state.fail?.has('approvals') ? Promise.reject(new Error('down')) : Promise.resolve({ items: (state.approvals ?? []).filter((a) => a.threadRootId !== null && roots.includes(a.threadRootId)) });
    }),
  };
  return { work: new InboxWork(deps as never), deps, calls, state };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('what is going on in the listed threads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the three kinds once for the whole page, not once per row', async () => {
    const { work, calls } = make({ todos: [todo(1)], runs: [run(2)], approvals: [question(3)] });
    work.setRoots([id(1), id(2), id(3)]);
    await settle();
    expect(calls.runs).toEqual([[id(1), id(2), id(3)]]);
    expect(calls.todos).toHaveLength(1);
    expect(calls.approvals).toHaveLength(1);
    expect(work.of(id(1)).todo?.rootId).toBe(id(1));
    expect(work.of(id(2)).run?.runId).toBe(id(302));
    expect(work.of(id(3)).questions.map((q) => q.id)).toEqual([id(701)]);
    expect(work.of(id(4))).toBe(NO_WORK);
  });

  it('cuts a longer page into batches of fifty', async () => {
    const { work, calls } = make();
    work.setRoots(Array.from({ length: 120 }, (_, i) => id(i + 1)));
    await settle();
    expect(calls.todos.map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('reads nothing when the roots did not change, and reads again at once when they did', async () => {
    const { work, deps } = make();
    work.setRoots([id(1)]);
    await settle();
    work.setRoots([id(1)]);
    await settle();
    expect(deps.todos).toHaveBeenCalledTimes(1);
    work.setRoots([id(1), id(2)]);
    await settle();
    expect(deps.todos).toHaveBeenCalledTimes(2);
  });

  it('turns a burst of pushes into one read after the debounce, and tells the listeners only when something changed', async () => {
    const { work, deps, state } = make({ todos: [todo(1, 1)] });
    work.setRoots([id(1)]);
    await settle();
    const seen = vi.fn();
    work.subscribe(seen);
    work.refreshSoon();
    work.refreshSoon();
    work.refreshSoon();
    expect(deps.todos).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS + 1);
    await settle();
    expect(deps.todos).toHaveBeenCalledTimes(2);
    expect(seen).not.toHaveBeenCalled(); // nothing changed: nobody re-renders
    const before = work.of(id(1));
    state.todos = [todo(1, 2)];
    work.refreshSoon();
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS + 1);
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(work.of(id(1))).not.toBe(before);
    expect(work.of(id(1)).todo?.version).toBe(2);
  });

  it('keeps the same object for a row whose work did not change while another row changed', async () => {
    const { work, state } = make({ todos: [todo(1), todo(2)] });
    work.setRoots([id(1), id(2)]);
    await settle();
    const one = work.of(id(1));
    state.todos = [todo(1), todo(2, 2)];
    work.refreshSoon();
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS + 1);
    await settle();
    expect(work.of(id(1))).toBe(one);
    expect(work.of(id(2)).todo?.version).toBe(2);
  });

  it('forgets a run that ended and a question that was answered', async () => {
    const { work, state } = make({ runs: [run(1)], approvals: [question(1)] });
    work.setRoots([id(1)]);
    await settle();
    expect(work.of(id(1)).run).not.toBeNull();
    state.runs = [];
    state.approvals = [];
    work.refreshSoon();
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS + 1);
    await settle();
    expect(work.of(id(1))).toBe(NO_WORK);
  });

  it('keeps what a row had of a kind whose read failed, and updates the others', async () => {
    const { work, state } = make({ todos: [todo(1)], runs: [run(1)] });
    work.setRoots([id(1)]);
    await settle();
    state.fail = new Set(['runs']);
    state.todos = [];
    work.refreshSoon();
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS + 1);
    await settle();
    expect(work.of(id(1)).run).not.toBeNull(); // the failed read changes nothing
    expect(work.of(id(1)).todo).toBeNull(); // the one that worked did
  });

  it('does nothing after it was stopped', async () => {
    const { work, deps } = make();
    work.setRoots([id(1)]);
    await settle();
    work.stop();
    work.refreshSoon();
    await vi.advanceTimersByTimeAsync(WORK_DEBOUNCE_MS * 3);
    expect(deps.todos).toHaveBeenCalledTimes(1);
  });
});
