import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, TOAST_UNDO_MS, ToastHost, clearToasts, dismissToast, sayToast } from '../src/kernel/toast';

// The host reads the list through useSyncExternalStore, so a server render shows what is on screen right now.
const shown = (): string[] => [...renderToStaticMarkup(createElement(ToastHost)).matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1] ?? '');
const hasUndo = (): boolean => renderToStaticMarkup(createElement(ToastHost)).includes('Undo');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe('toast queue (P21-05)', () => {
  it('shows nothing until a notice is said', () => {
    expect(shown()).toEqual([]);
  });

  it('keeps only the newest three, oldest first', () => {
    for (const t of ['a', 'b', 'c', 'd']) sayToast(t);
    expect(shown()).toEqual(['b', 'c', 'd']);
  });

  it('the same text said again replaces the earlier one and moves to the end', () => {
    sayToast('one');
    sayToast('two');
    sayToast('one');
    expect(shown()).toEqual(['two', 'one']);
  });

  it('a notice goes after 4s, one with Undo after 8s', () => {
    sayToast('plain');
    sayToast('undoable', { undo: () => {} });
    expect(hasUndo()).toBe(true);
    vi.advanceTimersByTime(TOAST_MS);
    expect(shown()).toEqual(['undoable']);
    vi.advanceTimersByTime(TOAST_UNDO_MS - TOAST_MS);
    expect(shown()).toEqual([]);
  });

  it('an explicit duration wins, and dismissing early stops the timer', () => {
    const id = sayToast('long', { ms: 20_000 });
    vi.advanceTimersByTime(19_999);
    expect(shown()).toEqual(['long']);
    dismissToast(id);
    expect(shown()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only a notice with an undo shows the button, and a testId names the text', () => {
    sayToast('no undo', { testId: 'note' });
    expect(hasUndo()).toBe(false);
    expect(renderToStaticMarkup(createElement(ToastHost))).toContain('data-testid="note"');
  });
});
