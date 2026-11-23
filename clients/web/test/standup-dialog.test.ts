// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P18-04: the lead's stand-up dialog starts from the defaults (the stand-up bot, three questions, weekdays, noon UTC) and saves what was set.

const saved: unknown[] = [];
vi.mock('../src/api/endpoints', () => ({
  fetchStandup: () => Promise.resolve({ standup: null, canManage: true }),
  saveStandup: (_c: string, s: unknown) => {
    saved.push(s);
    return Promise.resolve({ standup: s, canManage: true });
  },
}));
vi.mock('../src/screens/bots/api', () => ({
  fetchBots: () => Promise.resolve({ bots: [{ slug: 'engineer', status: 'active' }, { slug: 'standup-collector', status: 'active' }, { slug: 'old', status: 'disabled' }] }),
}));
const { StandupDialog } = await import('../src/channels/StandupDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  saved.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
};

describe('the stand-up dialog (P18-04)', () => {
  it('starts from the defaults and saves them with the pulse turned on', async () => {
    const closed = vi.fn();
    act(() => root.render(createElement(StandupDialog, { channelId: 'c-1', channelName: 'standup', teamSlug: 'engineering', onClose: closed })));
    await flush();
    const bot = document.querySelector<HTMLSelectElement>('[data-testid="standup-bot"]')!;
    expect(bot.value).toBe('standup-collector');
    expect([...bot.options].map((o) => o.value)).toEqual(['engineer', 'standup-collector']);
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="standup-questions"]')!.value.split('\n')).toHaveLength(3);
    act(() => document.querySelector<HTMLInputElement>('[data-testid="standup-pulse"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="standup-save"]')!.click());
    await flush();
    expect(saved).toEqual([expect.objectContaining({ enabled: true, botSlug: 'standup-collector', pulse: true, days: [1, 2, 3, 4, 5], digestAt: '12:00' })]);
    expect(closed).toHaveBeenCalled();
  });
});
