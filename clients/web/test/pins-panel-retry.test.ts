// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setTransport, type TransportResponse } from '../src/api/client';
import { PinsPanel } from '../src/channels/PinsPanel';

vi.mock('../src/shell/messageLink', () => ({ useOpenMessage: () => vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channelId = '00000000-0000-7000-8000-000000000001';
const pin = {
  id: '00000000-0000-7000-8000-000000000002',
  workspaceId: '00000000-0000-7000-8000-000000000003',
  channelId,
  authorId: '00000000-0000-7000-8000-000000000004',
  body: 'Remember the release checklist',
  bodyPlain: 'Remember the release checklist',
  threadRootId: null,
  editedAt: null,
  deletedAt: null,
  meta: {},
  createdAt: '2026-11-20T09:00:00.000Z',
  reactions: [],
  replyCount: 0,
  lastReplyAt: null,
};

it('retries a failed pinned-messages load and shows the pins after loading', async () => {
  let resolveRetry!: (response: TransportResponse) => void;
  const retry = new Promise<TransportResponse>((resolve) => {
    resolveRetry = resolve;
  });
  const fetchPins = vi.fn<() => Promise<TransportResponse>>()
    .mockResolvedValueOnce({ status: 500, body: {} })
    .mockReturnValueOnce(retry);
  setTransport(async ({ method, url }) => (
    method === 'GET' && url === `/api/channels/${channelId}/pins`
      ? fetchPins()
      : { status: 404, body: {} }
  ));

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PinsPanel, { entry: { type: 'pins', id: channelId } })));
    expect(fetchPins).toHaveBeenCalledTimes(1);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not load the pinned messages.');
    const button = alert?.querySelector('button');
    expect(button?.textContent).toBe('Try again');

    await act(async () => button?.click());
    expect(fetchPins).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[aria-busy="true"]')?.textContent).toBe('Loading…');

    await act(async () => resolveRetry({ status: 200, body: { items: [pin] } }));
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pinned messages"] [data-testid="pin-row"]')?.textContent).toContain(pin.body);
    expect(fetchPins).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('offers another retry when the pinned-messages retry fails', async () => {
  const fetchPins = vi.fn<() => Promise<TransportResponse>>()
    .mockResolvedValueOnce({ status: 500, body: {} })
    .mockResolvedValueOnce({ status: 503, body: {} })
    .mockResolvedValueOnce({ status: 200, body: { items: [pin] } });
  setTransport(async ({ method, url }) => (
    method === 'GET' && url === `/api/channels/${channelId}/pins`
      ? fetchPins()
      : { status: 404, body: {} }
  ));

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PinsPanel, { entry: { type: 'pins', id: channelId } })));
    const firstButton = host.querySelector<HTMLButtonElement>('[role="alert"] button.btn.s');
    expect(firstButton?.textContent).toBe('Try again');

    await act(async () => firstButton?.click());
    expect(fetchPins).toHaveBeenCalledTimes(2);
    const retryAlert = host.querySelector('[role="alert"]');
    expect(retryAlert?.textContent).toContain('Could not load the pinned messages.');
    const nextButton = retryAlert?.querySelector<HTMLButtonElement>('button.btn.s');
    expect(nextButton?.textContent).toBe('Try again');

    await act(async () => nextButton?.click());
    expect(fetchPins).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pinned messages"] [data-testid="pin-row"]')?.textContent).toContain(pin.body);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
