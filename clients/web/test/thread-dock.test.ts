// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { Approval, RunHead, ThreadTodo } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P29-12: the dock above a thread's composer: the to-do and the run in one place that follows the bots' updates, the pending question below them, never folded away.

const ROOT = '00000000-0000-7000-8000-0000000e0001';
const CH = '00000000-0000-7000-8000-0000000f0001';
const counts = { steps: 6, failed: 0, commands: 2, filesChanged: 1, added: 10, removed: 2, helpers: 0, thinkingSeconds: 0, omitted: 0 };
const run = (over: Partial<RunHead> = {}): RunHead =>
  ({ state: 'working', now: { kind: 'execute', title: 'pnpm lint', paths: [], helper: null, count: 1 }, counts, plan: { done: 0, total: 0, current: null }, planVersion: 0, helpers: [], seq: 9, stoppedBy: null,
    runId: 'r1', botId: 'b1', botActorId: null, botName: 'Engineer', channelId: CH, threadRootId: ROOT, askerActorId: null, conversation: false,
    startedAt: new Date(Date.now() - 30_000).toISOString(), endedAt: null, stopReason: null, cost: null, canStop: true, ...over }) as unknown as RunHead;
const todo = (done = 1): ThreadTodo =>
  ({ rootId: ROOT, channelId: CH, messageId: null, botActorId: null, title: 'Ship it', version: 1, updatedAt: new Date().toISOString(),
    items: [{ id: 'a', text: 'Migration', status: done >= 1 ? 'done' : 'working' }, { id: 'b', text: 'Lint', status: done >= 2 ? 'done' : 'working' }, { id: 'c', text: 'Open the PR', status: 'waiting' }, { id: 'd', text: 'Deploy', status: 'waiting' }] }) as unknown as ThreadTodo;
const ask = (id: string, at: string, summary = 'Deploy to the test site?'): Approval =>
  ({ id, source: 'agent', status: 'pending', tool: 'approvals.ask', summary, argsPreview: {}, argsTruncated: false, botName: 'Engineer', requesterName: 'Engineer', createdAt: at,
    channelId: CH, threadRootId: ROOT, approvers: { roles: [], people: [], leads: true }, canDecide: true, blockReason: null, decision: null }) as unknown as Approval;

const decideApproval = vi.fn();
vi.mock('../src/runs/useThreadRuns', () => ({
  useRunLines: () => ({ items: [{ seq: 9, at: '2026-11-16T10:00:00.000Z', payload: { kind: 'tool', stepId: 's9', stepKind: 'execute', title: 'pnpm lint' } }], plan: [], loading: false }),
}));
vi.mock('../src/screens/approvals/api', async (importOriginal) => ({ ...(await importOriginal<object>()), decideApproval: (...a: unknown[]) => decideApproval(...a), fetchThreadApprovals: vi.fn() }));
const { ThreadDock, foldedLine } = await import('../src/taskview/ThreadDock');
const { forgetDockFolded } = await import('../src/taskview/storage');
const { shownNow, forgetShownQuestions } = await import('../src/channels/run-card/shownQuestions');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const people = { botAvatar: () => undefined, byActor: () => undefined, botName: () => undefined } as never;

let host: HTMLDivElement;
let root: Root;
const reload = vi.fn();
type P = { runs?: RunHead[]; todo?: ThreadTodo | null; approvals?: Approval[]; railOpen?: boolean };
const draw = async (p: P): Promise<void> => {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(ThreadDock, { rootId: ROOT, slug: 'engineering', people, runs: p.runs ?? [], todo: p.todo ?? null, approvals: p.approvals ?? [], railOpen: p.railOpen ?? false, reloadApprovals: reload })));
  });
};
const q = (sel: string) => host.querySelector(sel);
const setNarrow = (on: boolean): void => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('480'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false })) as never;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
  decideApproval.mockReset();
  reload.mockReset();
  forgetShownQuestions();
  forgetDockFolded();
  setNarrow(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('what the dock holds', () => {
  it('shows the to-do, the run and the question in that order, the question lowest (next to the composer)', async () => {
    await draw({ runs: [run()], todo: todo(), approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    const dock = q('[data-testid="thread-dock"]')!;
    const order = [...dock.querySelectorAll('[data-testid="tv-todo"], [data-testid="tv-run"], [data-testid="tv-question"]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['tv-todo', 'tv-run', 'tv-question']);
    expect(q('[data-testid="tv-run-steps"]')).not.toBeNull();
    expect(q('[data-testid="tv-open-thread"]')).toBeNull(); // already in the thread
  });

  it('follows the bots: a to-do tick and a new step show on the next draw, no reload', async () => {
    await draw({ runs: [run()], todo: todo(1) });
    expect(q('[data-testid="tv-todo-count"]')?.textContent).toBe('1 of 4');
    await draw({ runs: [run({ now: { kind: 'read', title: 'package.json', paths: [], helper: null, count: 1 } as never })], todo: todo(2) });
    expect(q('[data-testid="tv-todo-count"]')?.textContent).toBe('2 of 4');
    expect(q('[data-testid="tv-run-now"]')?.textContent).toContain('Reading');
  });

  it('shows a waiting question with no run and no to-do at all', async () => {
    await draw({ approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    expect(q('[data-testid="tv-question"]')).not.toBeNull();
    expect(q('[data-testid="dock-toggle"]')).toBeNull();
  });

  it('draws nothing when nothing is going and nothing waits', async () => {
    await draw({});
    expect(q('[data-testid="thread-dock"]')).toBeNull();
  });

  it('claims the questions it draws, so the thread strip and the run card leave them out, and gives them back', async () => {
    await draw({ approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    expect([...shownNow(ROOT)]).toEqual(['q1']);
    await draw({});
    expect([...shownNow(ROOT)]).toEqual([]);
  });

  it('answers in place through the one decide path', async () => {
    decideApproval.mockResolvedValue({ approval: ask('q1', '2026-11-16T10:00:00.000Z') });
    await draw({ approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    await act(async () => (q('[data-testid="tv-question-yes"]') as HTMLButtonElement).click());
    expect(decideApproval).toHaveBeenCalledWith('engineering', 'q1', 'approve', '');
    expect(reload).toHaveBeenCalled();
  });

  it('with several waiting shows the newest and "1 more question"', async () => {
    await draw({ approvals: [ask('old', '2026-11-16T10:00:00.000Z', 'The old one?'), ask('new', '2026-11-16T10:05:00.000Z', 'The new one?')] });
    expect(q('[data-testid="tv-question-text"]')?.textContent).toBe('The new one?');
    expect(q('[data-testid="tv-questions-more"]')?.textContent).toBe('1 more question');
  });

  it('says a question to a screen reader once, and the cards are not live regions', async () => {
    await draw({ runs: [run()], todo: todo(), approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(q('[data-testid="dock-said"]')?.textContent).toBe('Needs you: Deploy to the test site?');
  });
});

describe('folding', () => {
  it('keeps one line of the to-do and the run while the side rail draws them, never the question, and gives the cards back when the rail closes (P29-20)', async () => {
    await draw({ runs: [run()], todo: todo(), approvals: [ask('q1', '2026-11-16T10:00:00.000Z')], railOpen: true });
    expect(q('[data-testid="tv-todo"]')).toBeNull();
    expect(q('[data-testid="dock-line-rail"]')?.textContent).toBe('Engineer · Running pnpm lint · 1 of 4');
    expect(q('[data-testid="dock-toggle"]')).toBeNull(); // nothing to press: the rail has the details
    expect(q('[data-testid="tv-question"]')).not.toBeNull();
    expect(localStorage.getItem(`mt.tv.dock.${ROOT}`)).toBeNull();
    await draw({ runs: [run()], todo: todo(), approvals: [], railOpen: false });
    expect(q('[data-testid="tv-todo"]')).not.toBeNull();
  });


  it('folds the to-do and the run to one line, keeps the question, and remembers per thread', async () => {
    await draw({ runs: [run()], todo: todo(), approvals: [ask('q1', '2026-11-16T10:00:00.000Z')] });
    await act(async () => (q('[data-testid="dock-toggle"]') as HTMLButtonElement).click());
    expect(q('[data-testid="tv-todo"]')).toBeNull();
    expect(q('[data-testid="tv-run"]')).toBeNull();
    expect(q('[data-testid="dock-line"]')?.textContent).toBe('Engineer · Running pnpm lint · 1 of 4');
    expect(q('[data-testid="tv-question"]')).not.toBeNull();
    expect(localStorage.getItem(`mt.tv.dock.${ROOT}`)).toBe('1');
    await act(async () => (q('[data-testid="dock-toggle"]') as HTMLButtonElement).click());
    expect(q('[data-testid="tv-run"]')).not.toBeNull();
  });

  it('starts folded on a phone, unless the person chose otherwise for this thread', async () => {
    setNarrow(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw({ runs: [run()], todo: todo() });
    expect(q('[data-testid="tv-run"]')).toBeNull();
    expect(q('[data-testid="dock-line"]')).not.toBeNull();
  });

  it('the folded line for a to-do alone', () => {
    expect(foldedLine(null, todo(2))).toBe('To do · 2 of 4');
  });
});
