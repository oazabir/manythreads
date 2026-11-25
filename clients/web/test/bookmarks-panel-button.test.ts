// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P37-08: the Bookmarks button at the top right is a toggle for the right-hand Bookmarks panel: pressed while the panel is open, a second press hides it,
// Esc and Close hide it too, and focus goes back to the button. (The rows of the list are the page's, tested with it.)

const api = vi.hoisted(() => ({ fetchBookmarkKeys: vi.fn(async () => ({ items: [], total: 0 })) }));
vi.mock('../src/api/endpoints', async (actual) => ({ ...(await actual<Record<string, unknown>>()), ...api }));

import { BookmarksLink } from '../src/bookmarks/BookmarksLink';
import { ShellContext, type ShellValue } from '../src/shell/context';
import { useEscapeToClose, usePanel } from '../src/kernel/panel/usePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shell = { teams: [], teamsLoading: false, team: { slug: 'eng', name: 'Engineering' }, teamSlug: 'eng', guest: false, counts: {} } as unknown as ShellValue;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** What the right panel does for Esc (kernel/panel/RightPanel.tsx), without drawing the panel. */
function EscProbe() {
  const panel = usePanel();
  useEscapeToClose(panel.open, panel.close);
  return null;
}

function Where({ children }: { children?: ReactNode }) {
  const loc = useLocation();
  return createElement('div', null, createElement('output', { 'data-testid': 'where' }, loc.search), children);
}

const mount = (start: string): void => {
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [start] },
        createElement(ShellContext.Provider, { value: shell }, createElement(Where, null, createElement(BookmarksLink), createElement(EscProbe))),
      ),
    ),
  );
};
const button = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-testid="header-bookmarks"]')!;
const where = (): string => host.querySelector('[data-testid="where"]')!.textContent ?? '';

describe('the Bookmarks button', () => {
  it('is a button, not a link, named Bookmarks, and not pressed while the panel is closed', async () => {
    mount('/t/eng/threads');
    await act(async () => undefined);
    expect(button().tagName).toBe('BUTTON');
    expect(button().getAttribute('aria-label')).toBe('Bookmarks');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(button().hasAttribute('href')).toBe(false);
  });

  it('the first press opens the panel and reads as pressed, the second hides it', async () => {
    mount('/t/eng/threads');
    await act(async () => undefined);
    act(() => button().click());
    expect(decodeURIComponent(where())).toBe('?panel=bookmarks:thread');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('aria-expanded')).toBe('true');
    act(() => button().click());
    expect(where()).toBe('');
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('over a thread, the second press shows the thread again instead of closing everything', async () => {
    mount('/t/eng/c/dev?panel=thread:abc');
    await act(async () => undefined);
    act(() => button().click());
    expect(decodeURIComponent(where())).toContain('panel=bookmarks:thread');
    act(() => button().click());
    expect(decodeURIComponent(where())).toContain('panel=thread:abc');
  });

  it('a panel open from a pasted link reads as pressed; Esc hides it and the focus is back on the button', async () => {
    mount('/t/eng/threads?panel=bookmarks:file');
    await act(async () => undefined);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    act(() => button().focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(where()).toBe('');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(button());
  });

  it('draws nothing without a team in sight, and for a guest uses the shared one', async () => {
    act(() => root.render(createElement(MemoryRouter, null, createElement(ShellContext.Provider, { value: { ...shell, team: null, teamSlug: null } }, createElement(BookmarksLink)))));
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="header-bookmarks"]')).toBeNull();
    act(() => root.render(createElement(MemoryRouter, null, createElement(ShellContext.Provider, { value: { ...shell, team: null, teamSlug: null, guest: true } }, createElement(BookmarksLink)))));
    expect(host.querySelector('[data-testid="header-bookmarks"]')).not.toBeNull();
  });
});
