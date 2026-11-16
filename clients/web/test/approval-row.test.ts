// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Approval } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Review round of P29: the inbox row never offers a one-click Approve for a bot's ask that carries details or a command (it offers Open), and its words are the one-line summary.

vi.mock('../src/screens/approvals/api', () => ({ decideApproval: vi.fn(), fetchApprovalArgs: vi.fn() }));
const { ApprovalRow } = await import('../src/screens/approvals/ApprovalRow');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ask = (over: Partial<Approval> = {}): Approval =>
  ({ id: '00000000-0000-7000-8000-0000000a0001', source: 'agent', status: 'pending', outcome: 'none', tool: 'approvals.ask', summary: 'Deploy commit 6456bfd?', argsPreview: { question: 'Deploy commit 6456bfd?' },
    argsTruncated: false, botName: 'Engineer', requesterName: 'Engineer', createdAt: '2026-11-16T10:00:00.000Z', expiresAt: '2026-11-17T10:00:00.000Z', approvers: { roles: [], people: [], leads: true },
    canDecide: true, blockReason: null, decision: null, ...over }) as unknown as Approval;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const draw = (a: Approval) => act(async () => root.render(createElement(ApprovalRow, { approval: a, slug: 'engineering', selected: false, onOpen: () => undefined, onDecided: () => undefined })));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('the inbox row', () => {
  it('offers Approve and Deny for a plain question', async () => {
    await draw(ask());
    expect(q('approval-row-approve')).not.toBeNull();
    expect(q('approval-row-open')).toBeNull();
  });

  it('offers only Open for an ask with details, however short', async () => {
    await draw(ask({ argsPreview: { question: 'Deploy commit 6456bfd?', details: 'It touches the migration.' } }));
    expect(q('approval-row-approve')).toBeNull();
    expect(q('approval-row-open')).not.toBeNull();
  });

  it('offers only Open for a command, and for a preview that is cut short', async () => {
    await draw(ask({ tool: 'agent.command', argsPreview: { command: 'rm -rf build' } }));
    expect(q('approval-row-approve')).toBeNull();
    await draw(ask({ argsTruncated: true }));
    expect(q('approval-row-approve')).toBeNull();
    expect(q('approval-row-open')).not.toBeNull();
  });

  it('says a long ask in one short line, in the row and in the labels', async () => {
    const long = `Can the owner resolve this? ${'It is needed for every release. '.repeat(100)}`;
    await draw(ask({ summary: `${long.slice(0, 299)}…`, argsPreview: { question: long } }));
    expect((q('approval-row-sentence')?.textContent ?? '').length).toBeLessThan(340);
    expect((q('approval-row-approve')?.getAttribute('aria-label') ?? '').length).toBeLessThan(350);
  });
});
