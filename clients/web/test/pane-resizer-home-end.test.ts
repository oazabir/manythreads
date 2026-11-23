// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneResizer } from '../src/kernel/panes/PaneResizer';
import { PANES, PANE_STEP, forgetPaneWidths, type PaneSpec } from '../src/kernel/panes/paneWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cssWidth = (id: string): string => document.documentElement.style.getPropertyValue(`--pane-${id}`);
const stored = (id: string): string | null => window.localStorage.getItem(`manythreads.pane-width.${id}`);

describe('PaneResizer Home/End', () => {
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

  for (const [spec, edge, wider] of [
    [PANES.sidebar, 'end', 'ArrowRight'],
    [PANES.threadRail, 'start', 'ArrowLeft'],
  ] as const) {
    it(`on a bar on the ${edge} edge (${spec.id}), Home gives the least width and End the most, from a non-default width`, () => {
      render(spec, edge);
      key(wider); // a non-default width to start from
      expectWidth(spec, spec.def + PANE_STEP);
      const home = key('Home');
      expect(home.defaultPrevented).toBe(true);
      expectWidth(spec, spec.min);
      const end = key('End');
      expect(end.defaultPrevented).toBe(true);
      expectWidth(spec, spec.max);
    });
  }

  it('a key it does not handle is not prevented and changes nothing', () => {
    render(PANES.sidebar, 'end');
    key('ArrowRight');
    const before = PANES.sidebar.def + PANE_STEP;
    const other = key('a');
    expect(other.defaultPrevented).toBe(false);
    expectWidth(PANES.sidebar, before);
  });

  it('the arrows, Escape and the double click still work as before', () => {
    render(PANES.sidebar, 'end');
    key('End');
    const left = key('ArrowLeft');
    expect(left.defaultPrevented).toBe(true);
    expectWidth(PANES.sidebar, PANES.sidebar.max - PANE_STEP);
    // Escape without a drag does nothing to the width
    const escape = key('Escape');
    expect(escape.defaultPrevented).toBe(false);
    expectWidth(PANES.sidebar, PANES.sidebar.max - PANE_STEP);
    act(() => {
      bar().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(bar().getAttribute('aria-valuenow')).toBe(String(PANES.sidebar.def));
    expect(cssWidth('sidebar')).toBe('');
    expect(stored('sidebar')).toBeNull();
  });
});
