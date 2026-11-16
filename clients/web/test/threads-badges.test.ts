// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { WS_RUN_STARTED } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P29-19: the Threads entry of the sidebar: up to three badges (mentions, unread, tasks in progress) in that order, none for a zero, its name in words, and the two extra counts read without any
// polling of their own: once, then again when the unread summary moves, a run begins, or the socket comes back.

const api = { mentions: 0, running: 0, failRunning: false };
const fetchThreadMentions = vi.fn(async () => ({ mentions: api.mentions }));
const fetchThreadsRunning = vi.fn(async () => {
  if (api.failRunning) throw new Error('down');
  return { threads: api.running };
});
vi.mock('../src/inbox/api', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchThreadMentions: () => fetchThreadMentions(), fetchThreadsRunning: () => fetchThreadsRunning() }));
let unread = 0;
vi.mock('../src/channels/hooks', async (importOriginal) => ({ ...(await importOriginal<object>()), useUnread: () => ({ threadsUnread: unread }) }));
const pushes = new Set<(p: { type: string }) => void>();
const reconnects = new Set<() => void>();
vi.mock('../src/realtime', () => ({
  realtimeClient: () => ({
    onPush: (fn: (p: { type: string }) => void) => {
      pushes.add(fn);
      return () => pushes.delete(fn);
    },
    onReconnected: (fn: () => void) => {
      reconnects.add(fn);
      return () => reconnects.delete(fn);
    },
  }),
}));
const { ThreadsBadges, threadsLabel } = await import('../src/shell/ThreadsBadges');
const { useThreadsBadge } = await import('../src/inbox/useThreadsBadge');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.mentions = 0;
  api.running = 0;
  api.failRunning = false;
  unread = 0;
  fetchThreadMentions.mockClear();
  fetchThreadsRunning.mockClear();
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const q = (sel: string) => host.querySelector(sel);

describe('the badges and their name', () => {
  it('words only the counts that are not zero, in the order of the badges', () => {
    expect(threadsLabel({ mentions: 2, unread: 5, running: 3 })).toBe('Threads, 2 mentions, 5 unread, 3 tasks in progress');
    expect(threadsLabel({ mentions: 1, unread: 0, running: 1 })).toBe('Threads, 1 mention, 1 task in progress');
    expect(threadsLabel({ mentions: 0, unread: 0, running: 0 })).toBe('Threads');
  });

  it('draws up to three in the order mentions, unread, tasks; a zero draws nothing; none draws no box', async () => {
    await act(async () => root.render(createElement(ThreadsBadges, { mentions: 2, unread: 5, running: 3 })));
    expect([...host.querySelectorAll('.tb')].map((b) => b.getAttribute('data-testid'))).toEqual(['threads-badge-mentions', 'threads-badge-unread', 'threads-badge-running']);
    expect(q('[data-testid="threads-badge-mentions"]')?.textContent).toBe('2');
    expect(q('[data-testid="threads-badges"]')?.getAttribute('aria-hidden')).toBe('true'); // the entry's own name says it
    await act(async () => root.render(createElement(ThreadsBadges, { mentions: 0, unread: 4, running: 0 })));
    expect([...host.querySelectorAll('.tb')].map((b) => b.getAttribute('data-testid'))).toEqual(['threads-badge-unread']);
    expect(q('.tb-dot')).toBeNull();
    await act(async () => root.render(createElement(ThreadsBadges, { mentions: 0, unread: 0, running: 0 })));
    expect(q('[data-testid="threads-badges"]')).toBeNull();
  });

  it('keeps big numbers short', async () => {
    await act(async () => root.render(createElement(ThreadsBadges, { mentions: 120, unread: 0, running: 0 })));
    expect(q('[data-testid="threads-badge-mentions"]')?.textContent).toBe('99+');
  });
});

function Probe({ slug }: { slug: string | null }) {
  const b = useThreadsBadge(slug);
  return createElement('span', { 'data-testid': 'probe' }, `${b.mentions}/${b.running}`);
}
const draw = async (slug: string | null = 'engineering'): Promise<void> => {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(Probe, { slug })));
  });
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
};

describe('the two extra counts', () => {
  it('reads each once, and again when a run begins, with a burst making one read', async () => {
    api.mentions = 2;
    api.running = 1;
    await draw();
    await settle();
    expect(q('[data-testid="probe"]')?.textContent).toBe('2/1');
    const before = fetchThreadsRunning.mock.calls.length;
    api.running = 2;
    await act(async () => {
      for (const p of pushes) {
        p({ type: WS_RUN_STARTED });
        p({ type: WS_RUN_STARTED });
      }
    });
    await settle();
    expect(q('[data-testid="probe"]')?.textContent).toBe('2/2');
    expect(fetchThreadsRunning.mock.calls.length - before).toBe(1);
  });

  it('reads again when the socket comes back, and does nothing for another kind of push', async () => {
    await draw();
    await settle();
    const before = fetchThreadMentions.mock.calls.length;
    await act(async () => {
      for (const p of pushes) p({ type: 'message.created' });
    });
    await settle();
    expect(fetchThreadMentions.mock.calls.length).toBe(before);
    api.mentions = 3;
    await act(async () => {
      for (const r of reconnects) r();
    });
    await settle();
    expect(q('[data-testid="probe"]')?.textContent).toBe('3/0');
  });

  it('keeps the count it had when one read fails, and reads nothing without a team', async () => {
    api.mentions = 1;
    api.running = 4;
    await draw();
    await settle();
    expect(q('[data-testid="probe"]')?.textContent).toBe('1/4');
    api.failRunning = true;
    api.mentions = 2;
    await act(async () => {
      for (const r of reconnects) r();
    });
    await settle();
    expect(q('[data-testid="probe"]')?.textContent).toBe('2/4');
    fetchThreadMentions.mockClear();
    await draw(null);
    await settle();
    expect(fetchThreadMentions).not.toHaveBeenCalled();
    expect(q('[data-testid="probe"]')?.textContent).toBe('0/0');
  });
});
