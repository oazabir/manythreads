// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Approval } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Owner 2026-11-23: an approval opened in the inbox shows the thread it waits in, with the approval highlighted. The thread itself is a stand-in here (the
// real one needs the whole shell); it draws the approval as the thread's question strip does, with `data-approval`, or does not draw it at all.

let drawn = true;
const threadProps: Array<Record<string, unknown>> = [];
vi.mock('../src/channels/ThreadPanel', () => ({
  ThreadBody: (props: Record<string, unknown>) => {
    threadProps.push(props);
    return createElement('div', { 'data-testid': 'thread' }, drawn ? createElement('article', { 'data-approval': 'a-1', 'data-testid': 'strip' }, 'Deploy?') : null);
  },
}));
vi.mock('../src/screens/approvals/ApprovalCard', () => ({ ApprovalCard: () => createElement('div', { 'data-testid': 'approval-card' }) }));
const { ApprovalInThread } = await import('../src/screens/approvals/ApprovalInThread');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

const approval = { id: 'a-1', status: 'pending', outcome: 'none', threadRootId: 'root-1', channelId: 'chan-1' } as unknown as Approval;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  threadProps.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const show = async () => {
  await act(async () => {
    root.render(createElement(ApprovalInThread, { approval, slug: 'engineering', onDecided: () => undefined }));
  });
};

describe('an approval in its thread', () => {
  it('draws the thread the approval waits in, and highlights and scrolls to the approval in it', async () => {
    drawn = true;
    await show();
    expect(threadProps[0]).toMatchObject({ rootId: 'root-1', channelId: 'chan-1', variant: 'main' });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const strip = host.querySelector<HTMLElement>('[data-testid="strip"]')!;
    expect(strip.dataset['highlight']).toBe('true');
    expect(strip.scrollIntoView).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="approval-thread"]')?.getAttribute('data-approval-shown')).toBe('found');
    expect(host.querySelector('[data-testid="approval-card"]')).toBeNull();
  });

  it('shows the card above the thread when the thread does not draw the approval', async () => {
    drawn = false;
    await show();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(host.querySelector('[data-testid="approval-thread"]')?.getAttribute('data-approval-shown')).toBe('missing');
    expect(host.querySelector('[data-testid="approval-card"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="thread"]')).not.toBeNull();
  });
});
