// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P18-09: in a help channel the composer shows earlier answers after a pause in typing, for a question of a few words only; closing hides them; nothing
// is sent. The server answer is a stand-in.

const asked: string[] = [];
let answer: { help: boolean; items: unknown[] } = { help: true, items: [] };
vi.mock('../src/api/endpoints', () => ({
  fetchAnsweredBefore: (_channel: string, q: string) => {
    asked.push(q);
    return Promise.resolve(answer);
  },
}));
const { AnsweredBefore, worthAsking } = await import('../src/channels/AnsweredBefore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const draw = (text: string) =>
  act(() => root.render(createElement(MemoryRouter, null, createElement(AnsweredBefore, { channelId: 'c-1', teamSlug: 'engineering', text }))));
const settle = async (ms = 800) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  asked.length = 0;
  answer = {
    help: true,
    items: [
      { kind: 'thread', rootId: '00000000-0000-4000-8000-000000000001', channelId: '00000000-0000-4000-8000-000000000002', channelName: 'help', title: 'How do I rotate the deploy token?', answer: 'Run the rotate script.', replyCount: 2, lastReplyAt: '2026-11-20T10:00:00.000Z' },
      { kind: 'knowledge', base: 'runbook', document: 'tokens.md', section: 'Tokens', text: 'Rotated every ninety days.', file: 'knowledge/runbook/tokens.md' },
    ],
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Answered before (P18-09)', () => {
  it('asks only for a question of a few words, never for a slash command', () => {
    expect(worthAsking('token?')).toBe(false);
    expect(worthAsking('/ask how do I rotate the token')).toBe(false);
    expect(worthAsking('how do I rotate the deploy token')).toBe(true);
  });

  it('asks after a pause in typing and shows the earlier thread with its answer and the passage', async () => {
    draw('how do I rotate');
    draw('how do I rotate the deploy token');
    await settle(300);
    expect(asked).toEqual([]);
    await settle();
    expect(asked).toEqual(['how do I rotate the deploy token']);
    expect(host.querySelector('[data-testid="answered-before-thread"]')?.textContent).toContain('Run the rotate script.');
    expect(host.querySelector('[data-testid="answered-before-thread"] a')?.getAttribute('href')).toContain('/open?');
    expect(host.querySelector('[data-testid="answered-before-knowledge"]')?.textContent).toContain('tokens.md');
  });

  it('shows nothing when the channel is not a help channel, and closing hides it until the box is empty', async () => {
    draw('how do I rotate the deploy token');
    await settle();
    act(() => (host.querySelector('[data-testid="answered-before-close"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="answered-before"]')).toBeNull();
    draw('how do I rotate the deploy token for preview');
    await settle();
    expect(host.querySelector('[data-testid="answered-before"]')).toBeNull();
    expect(asked).toHaveLength(1);
    draw('');
    answer = { help: false, items: [] };
    draw('where is the staging database password kept');
    await settle();
    expect(host.querySelector('[data-testid="answered-before"]')).toBeNull();
    expect(asked).toHaveLength(2);
  });
});
