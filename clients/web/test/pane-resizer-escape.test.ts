// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneResizer } from '../src/kernel/panes/PaneResizer';
import { applyPaneWidths, forgetPaneWidths, PANES } from '../src/kernel/panes/paneWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storageKey = 'manythreads.pane-width.sidebar';
const startingWidth = 280;
const pointerId = 1;
const cssWidth = (): string => document.documentElement.style.getPropertyValue('--pane-sidebar');

describe('PaneResizer Escape', () => {
  let host: HTMLDivElement;
  let root: Root;
  let bar: HTMLElement;
  let button: HTMLButtonElement;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(storageKey, String(startingWidth));
    forgetPaneWidths();
    applyPaneWidths();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => root.render(createElement('div', null,
      createElement('button', null, 'Outside'),
      createElement('div', null, createElement(PaneResizer, { spec: PANES.sidebar, edge: 'end' })),
    )));
    bar = host.querySelector<HTMLElement>('[role="separator"]')!;
    button = host.querySelector('button')!;
    vi.spyOn(bar.parentElement!.parentElement!, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 1200, 600));

    let capturedPointer: number | undefined;
    bar.setPointerCapture = vi.fn((id: number) => { capturedPointer = id; });
    bar.hasPointerCapture = (id: number) => capturedPointer === id;
    bar.releasePointerCapture = vi.fn(() => { capturedPointer = undefined; });
    button.focus();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    window.localStorage.clear();
    forgetPaneWidths();
  });

  const pointer = (type: string, clientX: number): void => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    act(() => { bar.dispatchEvent(event); });
  };

  const escape = (): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { button.dispatchEvent(event); });
    return event;
  };

  it('restores the width without saving when Escape bubbles from a focused element outside the separator', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    expect(document.activeElement).toBe(button);

    pointer('pointerdown', startingWidth);
    expect(document.activeElement).toBe(button);
    expect(bar.hasPointerCapture(pointerId)).toBe(true);
    pointer('pointermove', 340);
    expect(cssWidth()).toBe('340px');
    expect(bar.getAttribute('aria-valuenow')).toBe('340');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    expect(escape().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(cssWidth()).toBe('280px');
    expect(bar.getAttribute('aria-valuenow')).toBe('280');
    expect(bar.hasAttribute('data-dragging')).toBe(false);
    expect(bar.hasPointerCapture(pointerId)).toBe(false);

    pointer('pointermove', 370);
    pointer('pointerup', 370);
    expect(cssWidth()).toBe('280px');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(storageKey)).toBe('280');

    pointer('pointerdown', startingWidth);
    pointer('pointermove', 310);
    expect(cssWidth()).toBe('310px');
    pointer('pointerup', 320);
    expect(cssWidth()).toBe('320px');
    expect(write).toHaveBeenCalledExactlyOnceWith(storageKey, '320');
    expect(window.localStorage.getItem(storageKey)).toBe('320');
    expect(escape().defaultPrevented).toBe(false);
    expect(cssWidth()).toBe('320px');
  });

  it('leaves idle Escape available to the focused element', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    expect(escape().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(cssWidth()).toBe('280px');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
