// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Owner 2026-11-23: with the switch on, an incoming voice message in an open thread or direct-message conversation plays by itself, one after another, in
// place (nothing opens); a small player in the top right corner pauses and resumes it. Playback itself is a stand-in here (the real one needs an audio element).

const played: string[] = [];
let playing = false;
const ended: Array<() => void> = [];
const toggles: string[] = [];
vi.mock('../src/channels/voice/usePlayback', () => ({
  clipPlaying: () => playing,
  onClipEnded: (fn: () => void) => {
    ended.push(fn);
    return () => undefined;
  },
  toggleClip: (fileId: string) => {
    played.push(fileId);
    playing = true;
  },
  usePlayback: (fileId: string) => ({ active: true, status: 'ready', playing, positionMs: 1000, speed: 1, toggle: () => toggles.push(fileId), seek: () => undefined, cycleSpeed: () => undefined }),
}));
const auto = await import('../src/channels/voice/autoplay');
const { AutoplayMini } = await import('../src/channels/voice/AutoplayMini');
const { AutoplaySwitch } = await import('../src/channels/voice/AutoplaySwitch');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  played.length = 0;
  toggles.length = 0;
  playing = false;
  auto.setAutoplay(true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  auto.setAutoplay(false);
  vi.useRealTimers();
});

const now = Date.parse('2026-11-23T10:00:00.000Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

describe('which voice messages play by themselves', () => {
  it('only an incoming one from someone else, in an open thread or DM, not yet played, with the switch on', () => {
    const base = { on: true, zone: true, own: false, played: false, createdAt: at(2_000), now };
    expect(auto.shouldAutoplay(base)).toBe(true);
    expect(auto.shouldAutoplay({ ...base, on: false })).toBe(false);
    expect(auto.shouldAutoplay({ ...base, zone: false })).toBe(false);
    expect(auto.shouldAutoplay({ ...base, own: true })).toBe(false);
    expect(auto.shouldAutoplay({ ...base, played: true })).toBe(false);
    // the history drawn when a thread opens is not played
    expect(auto.shouldAutoplay({ ...base, createdAt: at(auto.INCOMING_MS + 1_000) })).toBe(false);
  });
});

describe('the autoplay queue and the corner player', () => {
  it('plays messages one after another, each once, shows who speaks and how many wait, and pauses from the corner', async () => {
    await act(async () => {
      root.render(createElement(AutoplayMini));
    });
    expect(host.querySelector('[data-testid="voice-autoplay-mini"]')).toBeNull();
    await act(async () => {
      auto.autoplayIncoming({ messageId: 'm1', fileId: 'f1', durationMs: 4000, who: 'Nadia' });
      auto.autoplayIncoming({ messageId: 'm2', fileId: 'f2', durationMs: 3000, who: 'Rafi' });
      auto.autoplayIncoming({ messageId: 'm1', fileId: 'f1', durationMs: 4000, who: 'Nadia' });
    });
    expect(played).toEqual(['f1']);
    const mini = host.querySelector('[data-testid="voice-autoplay-mini"]')!;
    expect(mini.textContent).toContain('Nadia');
    expect(mini.textContent).toContain('1 more');
    // the corner's button pauses and plays the clip in place: nothing navigates
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="voice-autoplay-toggle"]')!.click();
    });
    expect(toggles).toEqual(['f1']);
    // the first ends: the second plays a moment later, and the corner says who
    playing = false;
    await act(async () => {
      for (const fn of ended) fn();
      vi.advanceTimersByTime(500);
    });
    expect(played).toEqual(['f1', 'f2']);
    expect(host.querySelector('[data-testid="voice-autoplay-mini"]')!.textContent).toContain('Rafi');
    // the last ends: the corner player goes
    playing = false;
    await act(async () => {
      for (const fn of ended) fn();
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector('[data-testid="voice-autoplay-mini"]')).toBeNull();
  });

  it('close lets the clip end and plays nothing more; the switch turns it off', async () => {
    await act(async () => {
      root.render(createElement('div', null, createElement(AutoplayMini), createElement(AutoplaySwitch)));
    });
    await act(async () => {
      auto.autoplayIncoming({ messageId: 'm3', fileId: 'f3', durationMs: 4000, who: 'Nadia' });
      auto.autoplayIncoming({ messageId: 'm4', fileId: 'f4', durationMs: 3000, who: 'Rafi' });
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="voice-autoplay-close"]')!.click();
    });
    expect(host.querySelector('[data-testid="voice-autoplay-mini"]')).toBeNull();
    playing = false;
    await act(async () => {
      for (const fn of ended) fn();
      vi.advanceTimersByTime(500);
    });
    expect(played).toEqual(['f3']);
    const box = host.querySelector<HTMLInputElement>('[data-testid="voice-autoplay-box"]')!;
    expect(box.checked).toBe(true);
    await act(async () => {
      box.click();
    });
    expect(auto.autoplayOn()).toBe(false);
  });
});
