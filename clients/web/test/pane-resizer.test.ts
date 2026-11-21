// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneResizer } from '../src/kernel/panes/PaneResizer';
import { PANES, PANE_STEP, applyPaneWidths, clampPane, forgetPaneWidths, widthForPointer } from '../src/kernel/panes/paneWidth';
import { clampPanelWidth, maxPanelWidth, threadLayout, CENTER_MIN, PANEL_MIN } from '../src/kernel/panel/panelSize';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cssWidth = (id: string): string => document.documentElement.style.getPropertyValue(`--pane-${id}`);

describe('pane widths (owner 2026-11-21: a resizer on every side-by-side pane)', () => {
  it('keep a width within the pane\'s own limits, the default for anything that is not a number', () => {
    expect(clampPane(PANES.list, 100)).toBe(PANES.list.min);
    expect(clampPane(PANES.list, 5000)).toBe(PANES.list.max);
    expect(clampPane(PANES.list, 500.4)).toBe(500);
    expect(clampPane(PANES.list, Number.NaN)).toBe(PANES.list.def);
  });

  it('follow the pointer from the pane\'s start for a bar on its end edge, from its end for a bar on its start edge', () => {
    const rect = { left: 248, right: 668 };
    expect(widthForPointer(PANES.list, 'end', 748, rect, 1600)).toBe(500);
    expect(widthForPointer(PANES.threadRail, 'start', 300, { left: 200, right: 700 }, 1600)).toBe(400);
  });

  it('leave the neighbour its room while dragged, and never go under the pane\'s least', () => {
    expect(widthForPointer(PANES.list, 'end', 2000, { left: 0, right: 420 }, 900)).toBe(900 - PANES.list.rest);
    expect(widthForPointer(PANES.list, 'end', 2000, { left: 0, right: 420 }, 500)).toBe(PANES.list.min);
  });

  it('give the right panel the room the sidebar leaves, whatever its width', () => {
    expect(maxPanelWidth(1440, 248)).toBe(1440 - 248 - CENTER_MIN);
    expect(maxPanelWidth(1440, 440)).toBe(1440 - 440 - CENTER_MIN);
    expect(clampPanelWidth(900, 1440, 440)).toBe(1440 - 440 - CENTER_MIN);
    // a wide sidebar makes a thread fill the area sooner
    expect(threadLayout({ viewport: 1000, narrow: false, isThread: true, expanded: false, rail: 248 })).toBe('side');
    expect(threadLayout({ viewport: 1000, narrow: false, isThread: true, expanded: false, rail: 440 })).toBe('fill');
    expect(440 + CENTER_MIN + PANEL_MIN).toBeGreaterThan(1000);
  });
});

describe('PaneResizer', () => {
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
  const key = (k: string): void => {
    act(() => {
      bar().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  };

  it('is a labelled separator that the arrow keys move, keeps the width and hands it to the stylesheet', () => {
    act(() => root.render(createElement('div', null, createElement(PaneResizer, { spec: PANES.list, edge: 'end' }))));
    expect(bar().getAttribute('aria-label')).toBe('Resize list');
    expect(bar().getAttribute('aria-valuenow')).toBe(String(PANES.list.def));
    // jsdom lays nothing out: the pane measures 0, so a key press starts from the kept width
    key('ArrowRight');
    expect(bar().getAttribute('aria-valuenow')).toBe(String(PANES.list.def + PANE_STEP));
    expect(cssWidth('list')).toBe(`${PANES.list.def + PANE_STEP}px`);
    expect(window.localStorage.getItem('manythreads.pane-width.list')).toBe(String(PANES.list.def + PANE_STEP));
  });

  it('on a pane\'s start edge, left makes it wider', () => {
    act(() => root.render(createElement('div', null, createElement(PaneResizer, { spec: PANES.threadRail, edge: 'start' }))));
    key('ArrowLeft');
    expect(bar().getAttribute('aria-valuenow')).toBe(String(PANES.threadRail.def + PANE_STEP));
  });

  it('a double click restores the default and forgets the kept width', () => {
    act(() => root.render(createElement('div', null, createElement(PaneResizer, { spec: PANES.sidebar, edge: 'end' }))));
    key('ArrowRight');
    act(() => {
      bar().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(bar().getAttribute('aria-valuenow')).toBe(String(PANES.sidebar.def));
    expect(cssWidth('sidebar')).toBe('');
    expect(window.localStorage.getItem('manythreads.pane-width.sidebar')).toBeNull();
  });

  it('a width kept earlier reaches the stylesheet when the app starts, clamped to the pane\'s limits', () => {
    window.localStorage.setItem('manythreads.pane-width.files-tree', '9999');
    window.localStorage.setItem('manythreads.pane-width.chat-history', 'wide');
    forgetPaneWidths();
    applyPaneWidths();
    expect(cssWidth('files-tree')).toBe(`${PANES.filesTree.max}px`);
    expect(cssWidth('chat-history')).toBe('');
  });
});
