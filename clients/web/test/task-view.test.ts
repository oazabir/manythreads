// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { Approval, ActiveChannelRunsResponse, RunActivityResponse, RunHead, ThreadTodo } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P29-06: the cards under a thread root in the channel, drawn from the channel's one store. Component-level: what a person sees, what the buttons call, and that no card is a
// live region (the channel has one).

const CH = '00000000-0000-7000-8000-0000000f0001';
const ROOT = '00000000-0000-7000-8000-0000000e0001';
const RUN = '00000000-0000-7000-8000-000000a00001';

const counts = { steps: 6, failed: 0, commands: 2, filesChanged: 1, added: 10, removed: 2, helpers: 0, thinkingSeconds: 0, omitted: 0 };
const head = (over: Partial<RunHead> = {}): RunHead =>
  ({
    state: 'working', now: { kind: 'execute', title: 'pnpm lint', paths: [], helper: null, count: 1 }, counts, plan: { done: 0, total: 0, current: null }, planVersion: 0, helpers: [], seq: 9, stoppedBy: null,
    runId: RUN, botId: 'b1', botActorId: null, botName: 'Engineer', channelId: CH, threadRootId: ROOT, askerActorId: null, conversation: false,
    startedAt: new Date(Date.now() - 65_000).toISOString(), endedAt: null, stopReason: null, cost: null, canStop: true, ...over,
  }) as unknown as RunHead;
const line = (seq: number, title: string) => ({ seq, at: '2026-11-16T10:00:00.000Z', payload: { kind: 'tool', stepId: `s${seq}`, stepKind: 'execute', title } });
const todo = (): ThreadTodo =>
  ({ rootId: ROOT, channelId: CH, messageId: null, botActorId: null, title: 'Ship it', version: 1, updatedAt: new Date().toISOString(),
    items: [{ id: 'a', text: 'Write the migration', status: 'done' }, { id: 'b', text: 'Run the lint', status: 'working' }, { id: 'c', text: 'Open the PR', status: 'waiting' }] }) as unknown as ThreadTodo;
const question = (over: Partial<Approval> = {}): Approval =>
  ({ id: 'q1', source: 'agent', status: 'pending', tool: 'approvals.ask', summary: 'Deploy commit 6456bfd to the test site?', argsPreview: {}, argsTruncated: false, botName: 'Engineer',
    requesterName: 'Engineer', channelId: CH, threadRootId: ROOT, approvers: { roles: [], people: [], leads: true }, canDecide: true, blockReason: null, decision: null, ...over }) as unknown as Approval;

const state: { runs: ActiveChannelRunsResponse; todos: ThreadTodo[]; questions: Approval[] } = { runs: { runs: [], recent: [] } as unknown as ActiveChannelRunsResponse, todos: [], questions: [] };
const decideApproval = vi.fn();
const stopThreadRun = vi.fn();
const fetchThreadApprovals = vi.fn();
vi.mock('../src/runs/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchActiveRuns: async () => state.runs,
  fetchRunActivity: async (): Promise<RunActivityResponse> => ({ run: head(), plan: [], items: [line(7, 'pnpm install'), line(8, 'pnpm build'), line(9, 'pnpm lint')] as never, hasMore: false }),
  stopThreadRun: (...a: unknown[]) => stopThreadRun(...a),
}));
vi.mock('../src/taskview/api', () => ({
  fetchChannelTodos: async () => ({ todos: state.todos }),
  fetchChannelApprovals: async () => ({ items: state.questions }),
  watchChannel: async () => ({ expiresAt: 'x' }),
  unwatchChannel: async () => ({ ok: true }),
}));
vi.mock('../src/screens/approvals/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decideApproval: (...a: unknown[]) => decideApproval(...a),
  fetchApprovalArgs: vi.fn(),
  fetchThreadApprovals: (...a: unknown[]) => fetchThreadApprovals(...a),
}));
const { TaskView } = await import('../src/taskview/TaskView');
const { channelTasksStore } = await import('../src/taskview/store');
const { setOpenThreadRoot } = await import('../src/taskview/openRoot');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const people = { botAvatar: () => undefined, byActor: () => undefined, botName: () => undefined } as never;

let host: HTMLDivElement;
let root: Root;
let release: () => void;
const openThread = vi.fn();
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};
async function show(): Promise<void> {
  release = channelTasksStore.track(CH);
  await flush();
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(TaskView, { rootId: ROOT, channelId: CH, teamSlug: 'engineering', people, openThread })));
  });
  await flush();
}
const q = (sel: string) => host.querySelector(sel);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.runs = { runs: [{ runId: RUN, channelId: CH, threadRootId: ROOT, botId: 'b1', botActorId: null, botName: 'Engineer', startedAt: head().startedAt, head: head() }], recent: [] } as unknown as ActiveChannelRunsResponse;
  state.todos = [todo()];
  state.questions = [];
  decideApproval.mockReset();
  stopThreadRun.mockReset();
  fetchThreadApprovals.mockReset();
  localStorage.clear();
  setOpenThreadRoot(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  release?.();
  channelTasksStore.reset();
  host.remove();
});

describe('the cards', () => {
  it('draws the to-do card and the run card, compact, with the last steps and the counts', async () => {
    await show();
    expect(q('[data-testid="tv-todo-count"]')?.textContent).toBe('1 of 3');
    expect(host.querySelectorAll('[data-testid="tv-todo-items"] li')).toHaveLength(2); // the open ones only
    expect(q('[data-testid="tv-run-state"]')?.textContent).toBe('Working');
    expect(q('[data-testid="tv-run-now"]')?.textContent).toContain('pnpm lint');
    expect(host.querySelectorAll('[data-testid="tv-run-steps"] > li').length).toBeLessThanOrEqual(3);
    expect(q('[data-testid="tv-run-work"]')?.textContent).toContain('6 steps');
  });

  it('has no live region of its own and no per-card status role (the channel speaks once)', async () => {
    state.questions = [question()];
    await show();
    expect(host.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  });

  it('Stop has the bot in its name and calls the stop route once', async () => {
    stopThreadRun.mockResolvedValue({ stopped: true });
    await show();
    const stop = q('[data-testid="tv-run-stop"]') as HTMLButtonElement;
    expect(stop.getAttribute('aria-label')).toBe('Stop Engineer');
    await act(async () => stop.click());
    expect(stopThreadRun).toHaveBeenCalledWith(RUN);
    expect(q('[data-testid="tv-run-stop"]')?.textContent).toContain('Stopping');
  });

  it('"Open thread" opens the root', async () => {
    await show();
    await act(async () => (q('[data-testid="tv-open-thread"]') as HTMLButtonElement).click());
    expect(openThread).toHaveBeenCalledWith(ROOT);
  });

  it('Hide folds the cards to a chip that brings them back, and remembers for the thread', async () => {
    await show();
    await act(async () => (q('[data-testid="tv-hide"]') as HTMLButtonElement).click());
    expect(q('[data-testid="tv-run"]')).toBeNull();
    expect(q('[data-testid="tv-chip"]')?.textContent).toContain('Engineer is working');
    expect(localStorage.getItem(`mt.tv.hide.${ROOT}`)).toBe('1');
    await act(async () => (q('[data-testid="tv-chip"]') as HTMLButtonElement).click());
    expect(q('[data-testid="tv-run"]')).not.toBeNull();
  });

  it('folds to a chip while the root is open at the side, questions too', async () => {
    state.questions = [question()];
    await show();
    expect(q('[data-testid="tv-question"]')).not.toBeNull();
    await act(async () => setOpenThreadRoot(ROOT));
    expect(q('[data-testid="tv-run"]')).toBeNull();
    expect(q('[data-testid="tv-question"]')).toBeNull();
    expect(q('[data-testid="tv-chip"]')?.textContent).toContain('open at the side');
  });

  it('draws nothing for a root with nothing going', async () => {
    state.runs = { runs: [], recent: [] } as unknown as ActiveChannelRunsResponse;
    state.todos = [];
    await show();
    expect(q('[data-testid="task-view"]')).toBeNull();
  });
});

describe('the question strip', () => {
  it('shows the question in the thread\'s words with Yes and No, and answers through the one decide path', async () => {
    state.questions = [question()];
    decideApproval.mockResolvedValue({ approval: question({ status: 'approved' }) });
    await show();
    expect(q('[data-testid="tv-question-text"]')?.textContent).toBe('Deploy commit 6456bfd to the test site?');
    expect(q('[data-testid="tv-question-yes"]')?.textContent).toBe('Yes');
    expect(q('[data-testid="tv-question-no"]')?.textContent).toBe('No');
    await act(async () => (q('[data-testid="tv-question-yes"]') as HTMLButtonElement).click());
    expect(decideApproval).toHaveBeenCalledWith('engineering', 'q1', 'approve', '');
  });

  it('a person who may not decide sees who can, and no buttons', async () => {
    state.questions = [question({ canDecide: false })];
    await show();
    expect(q('[data-testid="tv-question-yes"]')).toBeNull();
    expect(q('[data-testid="tv-question-blocked"]')?.textContent).toContain('Waiting for');
  });

  it('a second answer says who answered first, from one read of the thread', async () => {
    const { ApiError } = await import('../src/api/client');
    state.questions = [question()];
    decideApproval.mockRejectedValue(new ApiError({ code: 'conflict', message: 'Already decided', status: 409 }));
    fetchThreadApprovals.mockResolvedValue({ items: [question({ status: 'approved', decision: { deciderName: 'Nadia', note: '' } as never })] });
    await show();
    await act(async () => (q('[data-testid="tv-question-yes"]') as HTMLButtonElement).click());
    await flush();
    expect(q('[data-testid="approval-answered"]')?.textContent).toBe('Already answered by Nadia.');
    expect(fetchThreadApprovals).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="tv-question-yes"]')).toBeNull();
  });

  it('with two waiting, shows the oldest and "1 more question", which opens the rest', async () => {
    state.questions = [question(), question({ id: 'q2' as Approval['id'], summary: 'Delete the branch?' })];
    await show();
    expect(host.querySelectorAll('[data-testid="tv-question"]')).toHaveLength(1);
    await act(async () => (q('[data-testid="tv-questions-more"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('[data-testid="tv-question"]')).toHaveLength(2);
  });
});
