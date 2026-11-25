// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setTransport, type TransportRequest, type TransportResponse } from '../src/api/client';
import { SummaryPanel, forgetSummaries } from '../src/channels/SummaryPanel';
import { rememberReadStart, rememberUnread } from '../src/channels/summaryModel';

// P18-05: the Summary panel asks once per range, sends the read position the screen opened with, draws `[n]` as buttons that open the message with the summary
// kept below, and says plainly what went wrong.

const open = vi.fn();
vi.mock('../src/shell/messageLink', () => ({ useOpenMessage: () => open, messageLocation: () => ({ pathname: '/t/eng/c/dev', search: '?message=x', state: null }) }));
vi.mock('../src/shell/context', () => ({ useShell: () => ({ team: { slug: 'eng' }, teamSlug: 'eng', guest: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C = '0190c3a0-0000-7000-8000-00000000000a';
const M = '0190c3a0-0000-7000-8000-00000000000b';
const READ = '0190c3a0-0000-7000-8000-00000000000c';
const channel = {
  channel: {
    id: C,
    workspaceId: '0190c3a0-0000-7000-8000-00000000000d',
    teamId: '0190c3a0-0000-7000-8000-00000000000e',
    groupId: null,
    name: 'dev',
    kind: 'channel',
    private: false,
    purpose: '',
    dmKey: null,
    botId: null,
    position: 0,
    archivedAt: null,
    createdAt: '2026-11-20T09:00:00.000Z',
  },
  isMember: true,
  canPost: true,
  canManage: false,
};
const ready = {
  state: 'ready',
  range: 'new',
  body: '**Decisions**\n\n- Ship on Friday [1]',
  sources: [{ n: 1, messageId: M, threadRootId: null }],
  messageCount: 3,
  readCount: 3,
  leftOut: 0,
  from: '2026-11-25T09:02:00.000Z',
  to: '2026-11-25T16:40:00.000Z',
  botName: 'Brain',
};

let asked: Array<Record<string, unknown>> = [];
let answer: (body: Record<string, unknown>) => TransportResponse = () => ({ status: 200, body: ready });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  forgetSummaries();
  asked = [];
  open.mockReset();
  setTransport(async (req: TransportRequest) => {
    if (req.method === 'GET' && req.url === `/api/channels/${C}`) return { status: 200, body: channel };
    if (req.method === 'POST' && req.url === `/api/channels/${C}/summary`) {
      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      asked.push(body);
      return answer(body);
    }
    return { status: 404, body: {} };
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('starts since the last read with the position the screen opened with, and each number opens its message above the summary', async () => {
  rememberReadStart({ channelId: C, threadRootId: null }, READ);
  rememberUnread({ channelId: C, threadRootId: null }, true);
  const entry = { type: 'summary', id: C };
  await act(async () => root.render(createElement(SummaryPanel, { entry })));
  expect(asked).toEqual([{ threadRootId: null, range: 'new', afterMessageId: READ }]);
  expect(host.querySelector('[data-testid="summary-range-new"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('[data-testid="summary-body"]')?.textContent).toContain('Ship on Friday');
  expect(host.querySelector('[data-testid="summary-coverage"]')?.textContent).toContain('From 3 messages');
  expect(host.textContent).toContain('Only you see this summary');
  const marker = host.querySelector<HTMLButtonElement>('[data-testid="summary-marker"]');
  expect(marker?.textContent).toBe('1');
  await act(async () => marker?.click());
  expect(open).toHaveBeenCalledWith(
    { channelId: C, channelKind: 'channel', channelName: 'dev', teamId: channel.channel.teamId, messageId: M, threadRootId: null },
    [entry],
    { land: true },
  );

  // another range asks again, without a read position
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="summary-range-week"]')?.click());
  expect(asked.at(-1)).toEqual({ threadRootId: null, range: 'week' });
});

it('says when there is nothing new, and shows the server’s words with Try again when Brain cannot write it', async () => {
  rememberUnread({ channelId: C, threadRootId: null }, false);
  answer = (b) => (b['range'] === 'day' ? { status: 200, body: { state: 'empty', range: 'day', messageCount: 0 } } : { status: 200, body: ready });
  await act(async () => root.render(createElement(SummaryPanel, { entry: { type: 'summary', id: C } })));
  expect(host.querySelector('[data-testid="summary-empty"]')?.textContent).toContain('Nothing was written in #dev in the last 24 hours.');

  answer = () => ({ status: 409, body: { error: { code: 'conflict', message: 'Brain is turned off, so it cannot write a summary.' } } });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="summary-range-new"]')?.click());
  const alert = host.querySelector('[data-testid="summary-error"]');
  expect(alert?.textContent).toContain('Brain is turned off');
  answer = () => ({ status: 200, body: ready });
  await act(async () => alert?.querySelector('button')?.click());
  expect(host.querySelector('[data-testid="summary-body"]')).not.toBeNull();
});

it('refuses a panel address that names no channel', async () => {
  await act(async () => root.render(createElement(SummaryPanel, { entry: { type: 'summary', id: 'nope' } })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('not valid');
  expect(asked).toEqual([]);
});
