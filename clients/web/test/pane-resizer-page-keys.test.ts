// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneResizer } from '../src/kernel/panes/PaneResizer';
import { forgetPaneWidths, PANES, PANE_STEP } from '../src/kernel/panes/paneWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PaneResizer PageUp/PageDown', () => {
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

  for (const [spec, edge, growArrow] of [
    [PANES.sidebar, 'end', 'ArrowRight'],
    [PANES.boardPanel, 'start', 'ArrowLeft'],
  ] as const) {
    it(`moves five steps in either direction and clamps at both limits on the ${edge} edge`, () => {
      act(() => root.render(createElement('div', null, createElement(PaneResizer, { spec, edge }))));
      const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
      separator.focus();

      const press = (key: string, width: number): void => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => {
          separator.dispatchEvent(event);
        });
        expect(separator.getAttribute('aria-valuenow')).toBe(String(width));
        expect(document.documentElement.style.getPropertyValue(`--pane-${spec.id}`)).toBe(`${width}px`);
        expect(window.localStorage.getItem(`manythreads.pane-width.${spec.id}`)).toBe(String(width));
        expect(event.defaultPrevented).toBe(true);
      };

      const start = spec.def + PANE_STEP;
      const expanded = start + 5 * PANE_STEP;
      press(growArrow, start);
      press('PageUp', expanded);
      press('PageDown', start);

      press('End', spec.max);
      const shrinkArrow = edge === 'end' ? 'ArrowLeft' : 'ArrowRight';
      press(shrinkArrow, spec.max - PANE_STEP);
      press('PageUp', spec.max);
      press('PageUp', spec.max);

      press('Home', spec.min);
      press(growArrow, spec.min + PANE_STEP);
      press('PageDown', spec.min);
      press('PageDown', spec.min);
    });
  }
});
