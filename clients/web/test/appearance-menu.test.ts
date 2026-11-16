// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appearance } from '@manythreads/shared';

// P30-01: the Appearance entry of the account menu (the gear at the bottom left). A choice in its submenu draws the look at once, saves it the way Settings →
// Appearance does, and leaves the menu open; the keys and the focus follow the menu pattern; a failed save puts the old look back.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const state = { appearance: { theme: 'light', density: 'comfortable', palette: 'graphite' } as { theme: string; density: string; palette: string }, listeners: new Set<() => void>() };
  return { state, save: vi.fn() };
});

vi.mock('../src/app/session', async () => {
  const { useSyncExternalStore } = await import('react');
  const snapshot = () => h.state.appearance;
  const subscribe = (cb: () => void) => {
    h.state.listeners.add(cb);
    return () => void h.state.listeners.delete(cb);
  };
  const useFakeSession = () => ({ role: 'member', person: { id: 'p1', name: 'Omar', avatar: null, appearance: useSyncExternalStore(subscribe, snapshot) } });
  return {
    isAdmin: () => false,
    useSession: useFakeSession,
    useSessionState: () => ({
      setSession: (s: { person: { appearance: typeof h.state.appearance } } | null) => {
        if (!s) return;
        h.state.appearance = s.person.appearance;
        h.state.listeners.forEach((l) => l());
      },
    }),
  };
});
vi.mock('../src/screens/account/appearanceApi', () => ({ saveMyAppearance: (body: Partial<Appearance>) => h.save(body) }));
vi.mock('../src/presence/DndIndicators', () => ({ DndStrip: () => null }));
vi.mock('../src/presence/hooks', () => ({ useMyDnd: () => ({ supported: false, banner: null, customStatus: null }) }));
vi.mock('../src/shell/context', () => ({ useShell: () => ({ guest: false }) }));
vi.mock('../src/notifications/push', () => ({ disablePush: () => Promise.resolve() }));
vi.mock('../src/api/endpoints', () => ({ signOut: () => Promise.resolve() }));

const { AccountMenu } = await import('../src/shell/AccountMenu');
const { APPEARANCE_KEY } = await import('../src/shell/appearance');

let host: HTMLDivElement;
let root: Root;
const html = document.documentElement;

const mount = (): void => {
  act(() => root.render(createElement(MemoryRouter, null, createElement(AccountMenu))));
};
const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (!el) throw new Error(`no ${testId}`);
  return el;
};
const gear = (): HTMLElement => must('account-gear');
const click = (el: HTMLElement): void => void act(() => el.click());
const key = (el: Element, k: string): void => void act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const settle = (): Promise<void> => act(async () => void (await Promise.resolve()));
const openAppearance = (): void => {
  click(gear());
  click(must('menu-appearance'));
};

function setPhone(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('width <='),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  h.state.appearance = { theme: 'light', density: 'comfortable', palette: 'graphite' };
  h.save.mockReset();
  h.save.mockImplementation((body: Partial<Appearance>) => Promise.resolve({ ...h.state.appearance, ...body }));
  html.setAttribute('data-palette', 'graphite');
  html.setAttribute('data-theme', 'light');
  html.setAttribute('data-theme-choice', 'light');
  window.localStorage.clear();
  setPhone(false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Appearance submenu on a wide screen', () => {
  it('opens beside the menu with the four palettes and System, Light, Dark, a check on the current ones', () => {
    mount();
    click(gear());
    expect(must('menu-appearance').getAttribute('aria-expanded')).toBe('false');
    click(must('menu-appearance'));
    const sub = must('appearance-menu');
    expect(sub.getAttribute('role')).toBe('menu');
    expect(sub.getAttribute('aria-label')).toBe('Appearance');
    const names = [...sub.querySelectorAll('[role="menuitemradio"]')].map((e) => e.textContent);
    expect(names).toEqual(['Graphite', 'Linen', 'Harbor', 'Classic', 'System', 'Light', 'Dark']);
    expect(must('appearance-palette-graphite').getAttribute('aria-checked')).toBe('true');
    expect(must('appearance-palette-linen').getAttribute('aria-checked')).toBe('false');
    expect(must('appearance-mode-light').getAttribute('aria-checked')).toBe('true');
    expect(sub.querySelectorAll('.am-sw')).toHaveLength(4);
    expect(must('appearance-more').getAttribute('href')).toBe('/account/appearance');
    // the first thing in the submenu with focus is the checked palette
    expect(document.activeElement).toBe(must('appearance-palette-graphite'));
  });

  it('draws a picked palette on the page at once, saves it, keeps the menu open and moves the check', async () => {
    mount();
    openAppearance();
    click(must('appearance-palette-linen'));
    expect(html.getAttribute('data-palette')).toBe('linen');
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toMatchObject({ palette: 'linen' });
    expect(h.save).toHaveBeenCalledWith({ palette: 'linen' });
    await settle();
    expect(q('appearance-menu')).not.toBeNull();
    expect(must('appearance-palette-linen').getAttribute('aria-checked')).toBe('true');
    expect(must('appearance-palette-graphite').getAttribute('aria-checked')).toBe('false');
    click(must('appearance-palette-harbor'));
    expect(html.getAttribute('data-palette')).toBe('harbor');
    expect(h.save).toHaveBeenLastCalledWith({ palette: 'harbor' });
  });

  it('draws a picked mode: Dark sets the choice and the drawn theme', async () => {
    mount();
    openAppearance();
    click(must('appearance-mode-dark'));
    expect(html.getAttribute('data-theme-choice')).toBe('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(h.save).toHaveBeenCalledWith({ theme: 'dark' });
    await settle();
    expect(must('appearance-mode-dark').getAttribute('aria-checked')).toBe('true');
    click(must('appearance-mode-system'));
    expect(html.getAttribute('data-theme-choice')).toBe('system');
    expect(html.getAttribute('data-theme')).toBe('light'); // the device is not dark here
  });

  it('puts the old look back and says so when the save fails', async () => {
    h.save.mockImplementation(() => Promise.reject(new Error('offline')));
    mount();
    openAppearance();
    click(must('appearance-palette-linen'));
    expect(html.getAttribute('data-palette')).toBe('linen');
    await settle();
    expect(html.getAttribute('data-palette')).toBe('graphite');
    expect(must('appearance-palette-graphite').getAttribute('aria-checked')).toBe('true');
    expect(must('appearance-menu-error').textContent).toMatch(/Could not save/);
    expect(q('appearance-menu')).not.toBeNull();
  });

  it('shows a palette while the pointer is over it and puts the saved one back when it leaves, keeping nothing', () => {
    mount();
    openAppearance();
    const linen = must('appearance-palette-linen');
    act(() => void linen.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    expect(html.getAttribute('data-palette')).toBe('linen');
    expect(window.localStorage.getItem(APPEARANCE_KEY)).toBeNull();
    act(() => void linen.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
    expect(html.getAttribute('data-palette')).toBe('graphite');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('puts the saved look back when the submenu closes while a palette is only being looked at', () => {
    mount();
    openAppearance();
    act(() => must('appearance-palette-harbor').focus());
    expect(html.getAttribute('data-palette')).toBe('harbor');
    key(must('appearance-palette-harbor'), 'ArrowLeft');
    expect(q('appearance-menu')).toBeNull();
    expect(html.getAttribute('data-palette')).toBe('graphite');
  });
});

describe('the keys', () => {
  it('opens the menu with focus on its first row, and Right on Appearance steps into the submenu on the checked palette', () => {
    mount();
    click(gear());
    expect(document.activeElement?.textContent).toBe('Account');
    act(() => must('menu-appearance').focus());
    key(must('menu-appearance'), 'ArrowRight');
    expect(q('appearance-menu')).not.toBeNull();
    expect(document.activeElement).toBe(must('appearance-palette-graphite'));
  });

  it('moves with Down, Up, Home and End inside the submenu only, and Enter picks', async () => {
    mount();
    openAppearance();
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(must('appearance-palette-linen'));
    key(document.activeElement as Element, 'End');
    expect(document.activeElement).toBe(must('appearance-more'));
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(must('appearance-palette-graphite'));
    key(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement).toBe(must('appearance-more'));
    key(document.activeElement as Element, 'Home');
    key(document.activeElement as Element, 'ArrowDown');
    // Enter on a button is a click: a keydown alone does not do it in jsdom, so the test presses it the way the browser does
    click(document.activeElement as HTMLElement);
    expect(html.getAttribute('data-palette')).toBe('linen');
    await settle();
  });

  it('Left closes the submenu and gives focus back to the Appearance row; Esc then closes the menu and gives focus back to the gear', () => {
    mount();
    openAppearance();
    key(document.activeElement as Element, 'ArrowLeft');
    expect(q('appearance-menu')).toBeNull();
    expect(q('menu-appearance')).not.toBeNull();
    expect(document.activeElement).toBe(must('menu-appearance'));
    key(must('menu-appearance'), 'Escape');
    expect(q('menu-appearance')).toBeNull();
    expect(document.activeElement).toBe(gear());
  });

  it('Esc inside the submenu closes only the submenu', () => {
    mount();
    openAppearance();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(q('appearance-menu')).toBeNull();
    expect(q('menu-appearance')).not.toBeNull();
    expect(document.activeElement).toBe(must('menu-appearance'));
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(q('menu-appearance')).toBeNull();
    expect(document.activeElement).toBe(gear());
  });

  it('a press outside the menu closes it', () => {
    mount();
    openAppearance();
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(q('menu-appearance')).toBeNull();
  });
});

describe('the Appearance submenu on a phone', () => {
  it('takes the place of the menu rows under a Back row, and Back brings the rows back with focus on Appearance', () => {
    setPhone(true);
    mount();
    click(gear());
    click(must('menu-appearance'));
    const sub = must('appearance-menu');
    expect(sub.getAttribute('role')).toBeNull();
    expect(q('menu-appearance')).toBeNull();
    expect(document.body.textContent).not.toContain('Sign out');
    expect(document.activeElement).toBe(must('appearance-palette-graphite'));
    click(must('appearance-palette-harbor'));
    expect(html.getAttribute('data-palette')).toBe('harbor');
    expect(q('appearance-menu')).not.toBeNull();
    click(must('appearance-back'));
    expect(q('appearance-menu')).toBeNull();
    expect(document.body.textContent).toContain('Sign out');
    expect(document.activeElement).toBe(must('menu-appearance'));
  });
});
