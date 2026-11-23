// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneResizer } from '../src/kernel/panes/PaneResizer';
import { PANES, PANE_STEP, applyPaneWidths, forgetPaneWidths, type PaneSpec } from '../src/kernel/panes/paneWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cssWidth = (id: string): string => document.documentElement.style.getPropertyValue(`--pane-${id}`);
const stored = (id: string): string | null => window.localStorage.getItem(`manythreads.pane-width.${id}`);

describe('PaneResizer Home/End on every pane, after a reload and with storage blocked', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.localStorage.clear();
    forgetPaneWidths();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
  });

  const bar = (): HTMLElement => host.querySelector<HTMLElement>('[role="separator"]')!;
  const key = (k: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => {
      bar().dispatchEvent(event);
    });
    return event;
  };
  const render = (spec: PaneSpec, edge: 'start' | 'end'): void => {
    act(() => root.render(createElement('div', null, createElement(PaneResizer, { spec, edge }))));
  };
  const expectWidth = (spec: PaneSpec, width: number): void => {
    expect(bar().getAttribute('aria-valuenow')).toBe(String(width));
    expect(cssWidth(spec.id)).toBe(`${width}px`);
    expect(stored(spec.id)).toBe(String(width));
  };
  /** What a page reload does: the tab forgets what it read, the app applies the kept widths, the bar is drawn again. */
  const reload = (spec: PaneSpec, edge: 'start' | 'end'): void => {
    act(() => root.unmount());
    forgetPaneWidths();
    applyPaneWidths();
    root = createRoot(host);
    render(spec, edge);
  };

  for (const spec of Object.values(PANES) as PaneSpec[]) {
    for (const edge of ['start', 'end'] as const) {
      it(`${spec.id} on the ${edge} edge: Home gives ${spec.min} and End gives ${spec.max}`, () => {
        render(spec, edge);
        const end = key('End');
        expect(end.defaultPrevented).toBe(true);
        expectWidth(spec, spec.max);
        const home = key('Home');
        expect(home.defaultPrevented).toBe(true);
        expectWidth(spec, spec.min);
      });
    }
  }

  it('Home at the least width and End at the most stay there and are still prevented', () => {
    const spec = PANES.sidebar;
    render(spec, 'end');
    key('Home');
    const again = key('Home');
    expect(again.defaultPrevented).toBe(true);
    expectWidth(spec, spec.min);
    key('End');
    const endAgain = key('End');
    expect(endAgain.defaultPrevented).toBe(true);
    expectWidth(spec, spec.max);
  });

  it('the arrows move on from the width Home and End set', () => {
    const spec = PANES.threadRail;
    render(spec, 'start');
    key('Home');
    key('ArrowLeft'); // on a start edge, left is wider
    expectWidth(spec, spec.min + PANE_STEP);
    key('End');
    key('ArrowRight');
    expectWidth(spec, spec.max - PANE_STEP);
  });

  it('the width End and Home set is the one shown after a reload', () => {
    const spec = PANES.sidebar;
    render(spec, 'end');
    key('End');
    reload(spec, 'end');
    expectWidth(spec, spec.max);
    key('Home');
    reload(spec, 'end');
    expect(stored(spec.id)).toBe('200');
    expectWidth(spec, spec.min);
  });

  it('with storage blocked, Home and End still change the shown width', () => {
    const spec = PANES.list;
    render(spec, 'end');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const end = key('End');
    expect(end.defaultPrevented).toBe(true);
    expect(bar().getAttribute('aria-valuenow')).toBe(String(spec.max));
    expect(cssWidth(spec.id)).toBe(`${spec.max}px`);
    expect(stored(spec.id)).toBeNull();
    key('Home');
    expect(bar().getAttribute('aria-valuenow')).toBe(String(spec.min));
    expect(cssWidth(spec.id)).toBe(`${spec.min}px`);
  });
});
