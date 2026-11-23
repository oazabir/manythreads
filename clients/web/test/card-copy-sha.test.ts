// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Board, Task } from '@manythreads/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CardPanel } from '../src/screens/boards/CardPanel';

vi.mock('../src/screens/boards/api', () => ({
  fetchTaskEvents: async () => ({ items: [] }),
}));

const sha = '0123456789abcdef'.repeat(4);
const task = {
  id: 'first',
  title: 'Test the change',
  description: '',
  state: 'in_progress',
  kind: 'code',
  priority: 'normal',
  ownerId: null,
  branch: 'card-first',
  baseSha: null,
  reworkCount: 0,
  handoffCount: 0,
} as Task;
const board = { columns: [] } as unknown as Board;
const writeText = vi.fn<(text: string) => Promise<void>>();
let host: HTMLDivElement;
let root: Root;
let clipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(testedSha: string | null, id = task.id) {
  await act(async () => root.render(createElement(CardPanel, {
    slug: 'team',
    task: { ...task, id, testedSha },
    board,
    roster: [],
    bots: [],
    botsAtWork: [],
    placeId: undefined,
    revision: 0,
    onMove: async () => undefined,
    onChanged: vi.fn(),
    onRefresh: vi.fn(),
  })));
}

function testedCommit() {
  return [...host.querySelectorAll('dt')].find((label) => label.textContent === 'Tested commit')?.nextElementSibling;
}

function copyButton() {
  return testedCommit()?.querySelector<HTMLButtonElement>('button');
}

async function copy() {
  const button = copyButton();
  expect(button?.textContent).toBe('Copy');
  await act(async () => button?.click());
}

function status() {
  return testedCommit()?.querySelector('[role="status"]');
}

it('offers no Copy button without a stored SHA', async () => {
  await render(null);
  expect(testedCommit()?.textContent).toBe('—');
  expect(copyButton()).toBeNull();
});

it('copies the full stored SHA and clears polite feedback after two seconds', async () => {
  await render(sha);
  expect(testedCommit()?.textContent).toContain(sha);
  expect(copyButton()?.getAttribute('aria-label')).toBe('Copy the tested commit');
  await copy();

  expect(writeText).toHaveBeenCalledExactlyOnceWith(sha);
  expect(status()?.getAttribute('aria-live')).toBe('polite');
  expect(status()?.textContent).toBe('Copied');
  act(() => vi.advanceTimersByTime(1999));
  expect(status()?.textContent).toBe('Copied');
  act(() => vi.advanceTimersByTime(1));
  expect(status()?.textContent).toBe('');
});

it('keeps refusal feedback when a retry replaces an earlier success', async () => {
  await render(sha);
  await copy();
  writeText.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  await copy();

  expect(status()?.textContent).toBe('Copy failed');
  act(() => vi.advanceTimersByTime(2000));
  expect(status()?.textContent).toBe('Copy failed');
});

it('ignores an earlier copy that settles after switching cards with the same SHA', async () => {
  let finish!: () => void;
  writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render(sha);
  await copy();
  await render(sha, 'second' as Task['id']);
  await act(async () => finish());

  expect(status()?.textContent).toBe('');
});
