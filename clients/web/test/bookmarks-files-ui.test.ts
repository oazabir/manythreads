// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P36-08 steps 2 and 3, on screen: the bookmark mark of a Files row sits beside the name, outside its clipped text; the row menu's Bookmark entry comes when
// the keys load and follows a change from another tab; a chat message of the person draws its row of actions only when it holds one.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchBookmarkKeys: vi.fn(), saveBookmark: vi.fn(), removeSavedBookmark: vi.fn() }));
vi.mock('../src/api/endpoints', async (actual) => ({ ...(await actual<Record<string, unknown>>()), ...api }));
vi.mock('../src/realtime', () => ({ realtimeClient: () => ({ onPush: () => () => undefined, onReconnected: () => () => undefined }) }));

const { bookmarksStore } = await import('../src/bookmarks/store');
const { ApiError } = await import('../src/api/client');
const { ListRow } = await import('../src/screens/files/FileItems');
const { PersonMessage } = await import('../src/screens/chat/ChatColumn');
const { ShellContext } = await import('../src/shell/context');

const TEAM = '0194f0a0-0000-7000-8000-0000000000e1';
const BM = '0194f0a0-0000-7000-8000-0000000000b1';
const MSG = '0194f0a0-0000-7000-8000-000000000002';
const PATH = 'pages/a-very-long-name-that-the-list-cuts-short-with-an-ellipsis.md';
const KEY = `${TEAM}:${PATH}`;

const row = {
  path: PATH, name: PATH.slice(6), kind: 'file', store: 'git', size: 10, mime: 'text/markdown', modifiedAt: null, by: null, where: null,
  readOnly: false, readOnlyReason: null, managedBy: null, fileId: null, channelId: null, blobSha: 'a', contentUrl: null,
} as const;
const files = { slug: 'engineering', teamName: 'Engineering', space: 'team', backend: {}, perms: {} } as never;
const shell = { teams: [{ id: TEAM, slug: 'engineering', name: 'Engineering' }], teamsLoading: false, team: null, teamSlug: 'engineering', guest: false, counts: {} } as never;

let host: HTMLDivElement;
let root: Root;
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const draw = (el: ReturnType<typeof createElement>): void =>
  act(() => root.render(createElement(MemoryRouter, null, createElement(ShellContext.Provider, { value: shell }, el))));
const listRow = () =>
  createElement(ListRow, { row: row as never, files, current: false, checked: false, tabStop: true, over: false, dragging: false, draggable: false, rkey: PATH, quick: [], onCheck: () => undefined, onAction: () => undefined, handlers: {} });

beforeEach(() => {
  vi.resetAllMocks();
  bookmarksStore.reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a Files row', () => {
  it('draws the mark beside the clipped name, not inside it', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 1, items: [{ id: BM, kind: 'repo_file', key: KEY }] });
    draw(listRow());
    await flush();
    const mark = host.querySelector('[data-testid="file-bookmarked-mark"]');
    expect(mark).not.toBeNull();
    expect(mark?.closest('.fname-text')).toBeNull();
    expect(mark?.parentElement?.className).toBe('fname-line');
    expect(mark?.parentElement?.querySelector('.fname-text')?.textContent).toContain('a-very-long-name');
  });

  it('its menu offers Bookmark once the keys are in, and follows a change made elsewhere', async () => {
    let answer!: (v: unknown) => void;
    api.fetchBookmarkKeys.mockReturnValue(new Promise((r) => (answer = r)));
    draw(listRow());
    const open = async (): Promise<string | null> => {
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="row-menu"]')!.click());
      const label = host.querySelector('[data-testid="row-action-bookmark"]')?.textContent ?? null;
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="row-menu"]')!.click());
      return label;
    };
    // the keys are not in yet: nothing to offer
    expect(await open()).toBeNull();
    await act(async () => answer({ total: 0, items: [] }));
    await flush();
    expect(await open()).toBe('Bookmark');
    // another tab bookmarked it: the keys are read again (as after a push or a reconnect) and the entry follows
    api.fetchBookmarkKeys.mockResolvedValue({ total: 1, items: [{ id: BM, kind: 'repo_file', key: KEY }] });
    await act(async () => bookmarksStore.load(true));
    expect(await open()).toBe('Remove bookmark');
  });
});

describe('the person’s own message in a chat with a bot', () => {
  const message = { id: MSG, body: 'hello', attachments: [] } as never;
  it('has no empty row of actions on a server without bookmarks, nor until the keys are in', async () => {
    api.fetchBookmarkKeys.mockRejectedValue(new ApiError({ code: 'not_found', message: 'gone', status: 404 } as never));
    draw(createElement(PersonMessage, { message, editable: false, onEdit: () => undefined, highlight: false }));
    expect(host.querySelector('.ch-person-acts')).toBeNull();
    await act(async () => bookmarksStore.load());
    expect(host.querySelector('.ch-person-acts')).toBeNull();
    // the edit of the last message alone still draws it
    draw(createElement(PersonMessage, { message, editable: true, onEdit: () => undefined, highlight: false }));
    expect(host.querySelector('.ch-person-acts [data-testid="chat-edit"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-bookmark-own"]')).toBeNull();
  });

  it('draws the bookmark there when the server has bookmarks', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 0, items: [] });
    await act(async () => bookmarksStore.load());
    draw(createElement(PersonMessage, { message, editable: false, onEdit: () => undefined, highlight: false }));
    expect(host.querySelector('.ch-person-acts [data-testid="chat-bookmark-own"]')).not.toBeNull();
  });
});
