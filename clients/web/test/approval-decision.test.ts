// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Approval } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';

// P29-05: answering an approval is one set of rules wherever the card is drawn. Yes waits for the full call when the preview is cut short (the run card's variant used to disable
// Yes and never draw the button that opens the call), one answer at a time, and a second answer (409) is a sentence, not an error.

const decideApproval = vi.fn();
const fetchApprovalArgs = vi.fn();
vi.mock('../src/screens/approvals/api', () => ({
  decideApproval: (...a: unknown[]) => decideApproval(...a),
  fetchApprovalArgs: (...a: unknown[]) => fetchApprovalArgs(...a),
}));
const { ApprovalCard } = await import('../src/screens/approvals/ApprovalCard');
const { useApprovalsChanged } = await import('../src/screens/approvals/live');

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
    it(`keeps Yes disabled in the ${variant} card until the full call is opened, and offers the button to open it`, async () => {
      await show(approval({ argsTruncated: true }), variant);
      expect(byId('approval-approve')?.disabled).toBe(true);
      expect(byId('approval-open-full')).not.toBeNull();
      fetchApprovalArgs.mockResolvedValue({ args: { question: 'the whole of it' } });
      await click(byId('approval-open-full'));
      expect(fetchApprovalArgs).toHaveBeenCalledOnce();
      expect(byId('approval-approve')?.disabled).toBe(false);
      expect(byId('approval-full')?.textContent).toContain('the whole of it');
    });
  }

  it('does not offer the button to a person who cannot decide', async () => {
    await show(approval({ argsTruncated: true, canDecide: false, blockReason: 'not_approver' }));
    expect(byId('approval-open-full')).toBeNull();
    expect(byId('approval-approve')).toBeNull();
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
  });

  it('shows a refusal (403) as an error and keeps the buttons', async () => {
    decideApproval.mockRejectedValue(new ApiError({ code: 'forbidden', message: 'You are not one of the people who can decide this', status: 403 }));
    await show(approval());
    await click(byId('approval-approve'));
    expect(byId('approval-error')?.textContent).toContain('not one of the people');
    expect(byId('approval-approve')).not.toBeNull();
  });
});
