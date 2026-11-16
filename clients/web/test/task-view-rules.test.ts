import type { RunHead, ThreadTodo } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_TASK_VIEW, type TaskViewState } from '../src/taskview/channelTasks';
import { ENDED_BAD_MS, ENDED_GOOD_MS, planTaskView, TODO_DONE_MS } from '../src/taskview/rules';
import { readHidden, writeHidden } from '../src/taskview/storage';

// P29-06: when the cards under a root show and when they go, as a pure function of the state and the clock (docs/plans/channel-task-view.md section 2).

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const counts = { steps: 4, failed: 0, commands: 1, filesChanged: 1, added: 3, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 };
const head = (over: Partial<RunHead> = {}): RunHead => ({ state: 'working', counts, runId: 'r1', botName: 'Engineer', startedAt: new Date(T0).toISOString(), endedAt: null, ...over }) as unknown as RunHead;
const todo = (done: boolean, updatedAt = new Date(T0).toISOString()): ThreadTodo =>
  ({ title: 'Plan', items: [{ id: 'a', text: 'One', status: done ? 'done' : 'working' }], updatedAt }) as unknown as ThreadTodo;
const view = (over: Partial<TaskViewState> = {}): TaskViewState => ({ ...EMPTY_TASK_VIEW, ...over });
const off = { hidden: false, openInPanel: false };

describe('the run card', () => {
  it('shows live while a run goes, and one folded line for a good run only five minutes', () => {
    expect(planTaskView(view({ run: head() }), T0, off).run).toBe('live');
    const ended = head({ state: 'done', endedAt: new Date(T0).toISOString() });
    expect(planTaskView(view({ ended }), T0 + ENDED_GOOD_MS - 1000, off).run).toBe('ended');
    expect(planTaskView(view({ ended }), T0 + ENDED_GOOD_MS + 1000, off).run).toBeNull();
  });

  it('keeps a failed or stopped run for thirty minutes', () => {
    for (const state of ['failed', 'stopped'] as const) {
      const ended = head({ state, endedAt: new Date(T0).toISOString() });
      expect(planTaskView(view({ ended }), T0 + 29 * 60_000, off).run).toBe('ended');
      expect(planTaskView(view({ ended }), T0 + ENDED_BAD_MS + 1000, off).run).toBeNull();
    }
  });

  it('draws nothing for a good run that did no work', () => {
    const ended = head({ state: 'done', endedAt: new Date(T0).toISOString(), counts: { ...counts, steps: 0, filesChanged: 0, helpers: 0 } });
    expect(planTaskView(view({ ended }), T0 + 1000, off).run).toBeNull();
  });

  it('says how many more runs are working, only while a card is shown', () => {
    expect(planTaskView(view({ run: head(), moreRuns: 2 }), T0, off).moreRuns).toBe(2);
    expect(planTaskView(view({ run: head(), moreRuns: 2 }), T0, { hidden: true, openInPanel: false }).moreRuns).toBe(0);
  });
});

describe('the to-do card', () => {
  it('shows while an item is open (the server sends only lists changed within a day)', () => {
    expect(planTaskView(view({ todo: todo(false, new Date(T0 - 20 * 3_600_000).toISOString()) }), T0, off).todo).toBe(true);
  });

  it('shows a finished list ("4 of 4 done") for five minutes and then goes', () => {
    expect(planTaskView(view({ todo: todo(true) }), T0 + TODO_DONE_MS - 1000, off).todo).toBe(true);
    expect(planTaskView(view({ todo: todo(true) }), T0 + TODO_DONE_MS + 1000, off).todo).toBe(false);
  });

  it('shows nothing for an empty list or none', () => {
    expect(planTaskView(view({ todo: { ...todo(false), items: [] } }), T0, off).any).toBe(false);
    expect(planTaskView(view(), T0, off).any).toBe(false);
  });
});

describe('folding to the chip', () => {
  it('folds the cards but not the questions when a person hid them', () => {
    const q = [{ id: 'q1' }] as unknown as TaskViewState['questions'];
    const p = planTaskView(view({ run: head(), todo: todo(false), questions: q }), T0, { hidden: true, openInPanel: false });
    expect(p.folded).toBe('hidden');
    expect(p.todo || p.run !== null).toBe(false);
    expect(p.questions).toHaveLength(1);
  });

  it('folds everything, questions too, while the root is open in the right panel (the thread answers there, once)', () => {
    const q = [{ id: 'q1' }] as unknown as TaskViewState['questions'];
    const p = planTaskView(view({ run: head(), questions: q }), T0, { hidden: false, openInPanel: true });
    expect(p.folded).toBe('panel');
    expect(p.questions).toHaveLength(0);
    expect(p.run).toBeNull();
  });

  it('has no chip when there is nothing to fold', () => {
    expect(planTaskView(view(), T0, { hidden: true, openInPanel: true }).folded).toBeNull();
  });
});

describe('Hide is remembered per thread, and a blocked storage is not an error', () => {
  it('remembers, and forgets', () => {
    writeHidden('root-a', true);
    expect(readHidden('root-a')).toBe(true);
    expect(readHidden('root-b')).toBe(false);
    writeHidden('root-a', false);
    expect(readHidden('root-a')).toBe(false);
  });

  it('still works when localStorage throws', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      expect(() => writeHidden('root-c', true)).not.toThrow();
      expect(readHidden('root-c')).toBe(true);
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
