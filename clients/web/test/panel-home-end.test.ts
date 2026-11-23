// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../src/kernel/panel/RightPanel';
import { PANEL_MIN } from '../src/kernel/panel/panelSize';

vi.mock('../src/kernel/panel/builtins', () => ({}));

const storageKey = 'manythreads.panel-width';
const viewport = window.innerWidth;

describe('RightPanel keyboard width bounds', () => {
  let host: HTMLDivElement;
  let root: Root;

  const resize = (width: number): void => {
    window.innerWidth = width;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };
  const separator = (): HTMLElement => host.querySelector<HTMLElement>('[role="separator"]')!;
  const press = (key: string): KeyboardEvent => {
    const bar = separator();
    bar.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      bar.dispatchEvent(event);
    });
    return event;
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resize(1200);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(createElement(MemoryRouter, { initialEntries: ['/?panel=example:item'] }, createElement(RightPanel))));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.removeItem(storageKey);
    window.innerWidth = viewport;
    vi.unstubAllGlobals();
  });

  it('Home selects and saves the advertised minimum width', () => {
    const min = separator().getAttribute('aria-valuemin');
    expect(min).toBe(String(PANEL_MIN));
    expect(separator().getAttribute('aria-valuenow')).not.toBe(min);

    expect(press('Home').defaultPrevented).toBe(true);
    expect(separator().getAttribute('aria-valuenow')).toBe(min);
    expect(window.localStorage.getItem(storageKey)).toBe(min);
  });

  it('End selects and saves the advertised maximum after a viewport change', () => {
    const previousMax = separator().getAttribute('aria-valuemax');
    resize(1440);
    const max = separator().getAttribute('aria-valuemax');
    expect(Number(max)).toBeGreaterThan(Number(previousMax));
    expect(separator().getAttribute('aria-valuenow')).not.toBe(max);

    expect(press('End').defaultPrevented).toBe(true);
    expect(separator().getAttribute('aria-valuenow')).toBe(max);
    expect(window.localStorage.getItem(storageKey)).toBe(max);
  });
});
