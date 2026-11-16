// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Approval } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';

// P29-05: answering an approval is one set of rules wherever the card is drawn. When the preview is cut short the people who may decide get the whole call by itself (one read, no
// button) and Yes waits for it (the run card's variant used to disable Yes and never draw the button that opened the call), one answer at a time, and a second answer (409) is a sentence, not an error.

const decideApproval = vi.fn();
const fetchApprovalArgs = vi.fn();
vi.mock('../src/screens/approvals/api', () => ({
  decideApproval: (...a: unknown[]) => decideApproval(...a),
  fetchApprovalArgs: (...a: unknown[]) => fetchApprovalArgs(...a),
}));
const { ApprovalCard } = await import('../src/screens/approvals/ApprovalCard');
const { useApprovalsChanged } = await import('../src/screens/approvals/live');
const { channelTasksStore } = await import('../src/taskview/store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: '00000000-0000-7000-8000-0000000a0001',
  workspaceId: '00000000-0000-7000-8000-0000000a0002',
  teamId: '00000000-0000-7000-8000-0000000a0003',
  source: 'agent',
  status: 'pending',
  outcome: 'none',
  outcomeDetail: '',
  expiresAt: '2026-11-17T10:00:00.000Z',
  startedAt: null,
  tool: 'approvals.ask',
  summary: 'Deploy commit 6456bfd to the test site?',
  argsPreview: { question: 'Deploy commit 6456bfd to the test site?' },
  argsTruncated: false,
  botId: '00000000-0000-7000-8000-0000000a0004',
  botSlug: 'engineer',
  botName: 'Engineer',
  requesterId: '00000000-0000-7000-8000-0000000a0005',
  requesterName: 'Nadia',
  channelId: '00000000-0000-7000-8000-0000000a0006',
  threadRootId: '00000000-0000-7000-8000-0000000a0007',
  approvers: { roles: [], people: [], leads: true },
  canDecide: true,
  blockReason: null,
  decision: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  ...over,
} as Approval);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  decideApproval.mockReset();
  fetchApprovalArgs.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = async (a: Approval, variant: 'run' | 'thread' | 'detail' = 'run'): Promise<void> => {
  await act(async () => {
    root.render(createElement(ApprovalCard, { approval: a, slug: 'engineering', variant }));
  });
};
const byId = (id: string): HTMLButtonElement | null => host.querySelector(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null): Promise<void> => {
  await act(async () => el?.click());
};

describe('a cut-short call', () => {
  for (const variant of ['run', 'thread', 'detail'] as const) {
    it(`loads the whole call by itself in the ${variant} card (one read, no button), shows it in place of the preview, and enables Yes once it has come`, async () => {
      let arrive: (v: unknown) => void = () => undefined;
      fetchApprovalArgs.mockReturnValue(new Promise((r) => (arrive = r)));
      await show(approval({ argsTruncated: true }), variant);
      // while it loads: a small waiting line, Yes disabled, no button to press
      expect(byId('approval-full-loading')).not.toBeNull();
      expect(byId('approval-open-full')).toBeNull();
      expect(byId('approval-approve')?.disabled).toBe(true);
      await act(async () => arrive({ args: { question: 'the whole of it', details: 'line one\nline two' } }));
      expect(fetchApprovalArgs).toHaveBeenCalledOnce();
      expect(byId('approval-approve')?.disabled).toBe(false);
      expect(byId('approval-truncated')).toBeNull();
      expect(host.textContent).toContain('line one');
      expect(host.textContent).not.toContain('cut short');
    });
  }

  it('shows a failure with Retry, keeps Yes disabled, and loads on Retry', async () => {
    fetchApprovalArgs.mockRejectedValueOnce(new ApiError({ code: 'internal', message: 'The server is busy', status: 500 }));
    await show(approval({ argsTruncated: true }), 'detail');
    expect(byId('approval-full-error')?.textContent).toContain('The server is busy');
    expect(byId('approval-approve')?.disabled).toBe(true);
    fetchApprovalArgs.mockResolvedValue({ args: { details: 'now it came' } });
    await click(byId('approval-open-full'));
    expect(byId('approval-approve')?.disabled).toBe(false);
    expect(host.textContent).toContain('now it came');
  });

  it('enables Yes when the server holds no more than the preview, and says so', async () => {
    fetchApprovalArgs.mockResolvedValue({ args: null });
    await show(approval({ argsTruncated: true }), 'detail');
    expect(byId('approval-approve')?.disabled).toBe(false);
    expect(byId('approval-truncated')?.textContent).toContain('not stored');
  });

  it('does not read anything for a person who cannot decide, and says the preview is cut short', async () => {
    await show(approval({ source: 'grant', tool: 'pages.write', summary: 'pages.write · pages/a.md', argsPreview: { path: 'pages/a.md' }, argsTruncated: true, canDecide: false, blockReason: 'not_approver' }));
    expect(fetchApprovalArgs).not.toHaveBeenCalled();
    expect(byId('approval-open-full')).toBeNull();
    expect(byId('approval-approve')).toBeNull();
    expect(byId('approval-truncated')?.textContent).toContain('cut short');
  });

  it('gives anyone who reads a bot ask its whole text (the lists carry the first 300 characters of the details), the people who cannot decide included', async () => {
    fetchApprovalArgs.mockResolvedValue({ args: { question: 'Deploy?', details: 'the whole details\nline two' } });
    await show(approval({ argsPreview: { question: 'Deploy?', details: 'the whole…' }, argsTruncated: true, canDecide: false, blockReason: 'not_approver' }), 'detail');
    expect(fetchApprovalArgs).toHaveBeenCalledTimes(1);
    expect(byId('approval-details')?.textContent).toBe('the whole details\nline two');
    expect(byId('approval-approve')).toBeNull();
  });

  it('draws a bot ask whole: the long question as the headline and the context kept line by line', async () => {
    const question = `Can the platform owner resolve Deployer's preview secret-read permission? ${'It is needed for every release. '.repeat(15)}`;
    await show(approval({ summary: `${question.slice(0, 299)}…`, argsPreview: { question, details: 'first line\nsecond line' } }), 'detail');
    expect(byId('approval-sentence')?.textContent).toContain(question.trim());
    expect(byId('approval-details')?.textContent).toBe('first line\nsecond line');
    expect(fetchApprovalArgs).not.toHaveBeenCalled();
    expect(byId('approval-approve')?.disabled).toBe(false);
  });
});

describe('answering', () => {
  it('sends one decision at a time', async () => {
    let finish: (v: unknown) => void = () => undefined;
    decideApproval.mockReturnValue(new Promise((r) => (finish = r)));
    await show(approval());
    await click(byId('approval-approve'));
    await click(byId('approval-approve'));
    await click(byId('approval-deny'));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0]?.[2]).toBe('approve');
    await act(async () => finish({ approval: approval({ status: 'approved' }) }));
  });

  it('says "Already answered" for a second answer (409), without an error, and tells every list to read again', async () => {
    const changed = vi.fn();
    const refresh = vi.spyOn(channelTasksStore, 'refreshAllQuestions').mockImplementation(() => undefined);
    function Probe() {
      useApprovalsChanged(changed);
      return null;
    }
    await act(async () => root.render(createElement('div', null, createElement(Probe), createElement(ApprovalCard, { approval: approval(), slug: 'engineering', variant: 'run' }))));
    decideApproval.mockRejectedValue(new ApiError({ code: 'conflict', message: 'This approval was already decided', status: 409 }));
    await click(byId('approval-approve'));
    expect(byId('approval-answered')).not.toBeNull();
    expect(byId('approval-error')).toBeNull();
    expect(byId('approval-approve')).toBeNull();
    expect(changed).toHaveBeenCalled();
    // the channel's own list of questions reads again too
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a refusal (403) as an error and keeps the buttons', async () => {
    decideApproval.mockRejectedValue(new ApiError({ code: 'forbidden', message: 'You are not one of the people who can decide this', status: 403 }));
    await show(approval());
    await click(byId('approval-approve'));
    expect(byId('approval-error')?.textContent).toContain('not one of the people');
    expect(byId('approval-approve')).not.toBeNull();
  });
});
