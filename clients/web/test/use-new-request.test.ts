// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takeNewRequest, useNewRequest, whenThere } from '../src/shell/useNewRequest';

// P38-07: a screen reads the one-shot `?new=` request once and takes it out of the address, so Back and a reload do not start it again.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('takeNewRequest', () => {
  it('reads an accepted request and removes only that parameter', () => {
    expect(takeNewRequest('?new=file&path=docs', ['file', 'folder'])).toEqual({ present: true, kind: 'file', rest: '?path=docs' });
    expect(takeNewRequest('?new=folder', ['file', 'folder'])).toEqual({ present: true, kind: 'folder', rest: '' });
  });

  it('removes a request the screen does not know, and answers null for it', () => {
    expect(takeNewRequest('?new=upload&x=1', ['file'])).toEqual({ present: true, kind: null, rest: '?x=1' });
  });

  it('leaves an address with no request exactly as it is', () => {
    expect(takeNewRequest('?path=docs', ['file'])).toEqual({ present: false, kind: null, rest: '?path=docs' });
    expect(takeNewRequest('', ['file'])).toEqual({ present: false, kind: null, rest: '' });
  });
});

describe('useNewRequest', () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: string[];
  let where = '';
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    seen = [];
    where = '';
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function Screen() {
    const req = useNewRequest(['file', 'folder'] as const);
    const loc = useLocation();
    where = loc.pathname + loc.search;
    if (req.kind !== null && seen.at(-1) !== req.kind) seen.push(req.kind);
    return createElement(
      'div',
      null,
      createElement('span', { id: 'kind' }, req.kind ?? 'none'),
      createElement('button', { id: 'done', onClick: req.done }, 'done'),
      createElement(Link, { id: 'again', to: '/files?new=folder' }, 'again'),
      createElement(Link, { id: 'plain', to: '/files?path=docs' }, 'plain'),
    );
  }
  const mount = (entry: string): void => {
    act(() => root.render(createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Screen))));
  };
  const text = (): string => host.querySelector('#kind')?.textContent ?? '';

  it('hands the request to the screen once and takes it out of the address', () => {
    mount('/files?new=file&path=docs');
    expect(text()).toBe('file');
    expect(where).toBe('/files?path=docs');
    expect(seen).toEqual(['file']);
  });

  it('keeps the request until the screen answers it, then clears it', () => {
    mount('/files?new=folder');
    expect(text()).toBe('folder');
    act(() => host.querySelector<HTMLButtonElement>('#done')?.click());
    expect(text()).toBe('none');
    expect(where).toBe('/files');
  });

  it('does nothing for an address with no request, and ends one it does not know', () => {
    mount('/files?path=docs');
    expect(text()).toBe('none');
    expect(where).toBe('/files?path=docs');
    act(() => root.unmount());
    root = createRoot(host);
    mount('/files?new=banana');
    expect(text()).toBe('none');
    expect(where).toBe('/files');
  });

  it('does not start again once answered and the address has moved on', () => {
    mount('/files?new=file');
    act(() => host.querySelector<HTMLButtonElement>('#done')?.click());
    act(() => host.querySelector<HTMLAnchorElement>('#plain')?.click());
    expect(text()).toBe('none');
    expect(seen).toEqual(['file']);
  });

  it('starts again when the menu is used again on the same screen', () => {
    mount('/files?new=file');
    act(() => host.querySelector<HTMLButtonElement>('#done')?.click());
    act(() => host.querySelector<HTMLAnchorElement>('#again')?.click());
    expect(text()).toBe('folder');
    expect(where).toBe('/files');
    expect(seen).toEqual(['file', 'folder']);
  });
});

describe('whenThere', () => {
  it('hands over the element once it is on the screen, and null when it never comes', async () => {
    const found: Array<HTMLElement | null> = [];
    let el: HTMLElement | null = null;
    whenThere(() => el, (e) => found.push(e), 3);
    await new Promise((r) => setTimeout(r, 120));
    el = document.createElement('div');
    whenThere(() => el, (e) => found.push(e), 3);
    await new Promise((r) => setTimeout(r, 120));
    expect(found).toHaveLength(2);
    expect(found[0]).toBeNull();
    expect(found[1]).toBe(el);
  });

  it('stops looking when it is cancelled', async () => {
    let called = 0;
    const stop = whenThere(() => null, () => (called += 1), 2);
    stop();
    await new Promise((r) => setTimeout(r, 120));
    expect(called).toBe(0);
  });
});
