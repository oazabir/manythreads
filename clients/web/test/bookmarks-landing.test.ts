// @vitest-environment jsdom
import { createElement, act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedBookmark } from '@manythreads/shared';
import { fileBookmarkTarget } from '../src/bookmarks/fileTarget';
import { canUndoRemoval, fileMetaOf, openOf, placeOf, tabFrom } from '../src/bookmarks/model';
import { JUMP_FIND_MS, JUMP_HOLD_MS, useJumpHighlight, type OlderPages } from '../src/channels/useJumpHighlight';
import { rowEntries } from '../src/screens/files/actions';
import type { FileRow } from '../src/screens/files/model';
import type { TeamFiles } from '../src/screens/files/store';
import { messageLocation, REPLY_PARAM } from '../src/shell/messageLink';

// P36-08 steps 2 and 3: where a bookmark lands (a thread reply highlighted in its thread, a message of a chat with a bot in that chat, each kind of file
// in its place), how a file row is bookmarked, and the wait that finds the row to highlight once the list draws it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '0194f0a0-0000-7000-8000-000000000001';
const MSG = '0194f0a0-0000-7000-8000-000000000002';
const CH = '0194f0a0-0000-7000-8000-0000000000c1';
const BM = '0194f0a0-0000-7000-8000-0000000000b1';
const FILE = '0194f0a0-0000-7000-8000-0000000000f1';
const TEAM = '0194f0a0-0000-7000-8000-0000000000e1';
const BOT = '0194f0a0-0000-7000-8000-0000000000d1';

const place = { id: CH, name: 'dev', kind: 'channel' as const, teamId: TEAM };
const bookmark = (over: Partial<SavedBookmark>): SavedBookmark => ({ id: BM, createdAt: '2026-11-24T10:00:00.000Z', target: { kind: 'message', messageId: MSG }, item: null, ...over }) as SavedBookmark;
const message = (channel: typeof place | Record<string, unknown>, threadRootId: string | null, authorId = CH) =>
  ({ kind: 'message', channel, threadRootId, authorId, authorName: 'Bot', snippet: 'hi', messageCreatedAt: '2026-11-24T10:00:00.000Z' }) as never;

describe('a thread reply lands highlighted in its thread', () => {
  it('a reply: its thread on the right and ?reply=<id>; a channel message and a thread have none', () => {
    const reply = openOf(bookmark({ item: message(place, ROOT) }));
    expect(reply?.type).toBe('message');
    const loc = messageLocation('eng', reply?.type === 'message' ? reply.target : (null as never), [], { land: true });
    const q = new URLSearchParams(loc.search);
    expect(loc.pathname).toBe('/t/eng/c/dev');
    expect(q.get('message')).toBe(ROOT);
    expect(q.get(REPLY_PARAM)).toBe(MSG);
    expect(q.get('panel')).toBe(`thread:${ROOT}`);
    // a channel message: scrolled to in the channel, no thread
    const plain = messageLocation('eng', { channelId: CH, channelKind: 'channel', channelName: 'dev', messageId: MSG, threadRootId: null }, [], { land: true });
    expect(new URLSearchParams(plain.search).get(REPLY_PARAM)).toBeNull();
    // a thread (its first message): the thread opens, nothing in it is singled out
    const thread = messageLocation('eng', { channelId: CH, channelKind: 'channel', channelName: 'dev', messageId: ROOT, threadRootId: ROOT }, [], { land: true });
    expect(new URLSearchParams(thread.search).get(REPLY_PARAM)).toBeNull();
  });

  it('only a caller that asks to land exactly gets it: search, pins, Later and notifications open the thread as before', () => {
    const t = { channelId: CH, channelKind: 'channel' as const, channelName: 'dev', messageId: MSG, threadRootId: ROOT };
    const loc = messageLocation('eng', t);
    expect(new URLSearchParams(loc.search).get(REPLY_PARAM)).toBeNull();
    expect(new URLSearchParams(loc.search).get('message')).toBe(ROOT);
    const bot = { ...t, channelKind: 'bot_conversation' as const, channelName: null };
    expect(messageLocation('eng', bot).search).toBe(`?thread=${ROOT}`);
    expect(messageLocation('eng', { ...bot, threadRootId: null }).search).toBe(`?thread=${MSG}`);
  });
});

describe('a message of a chat with a bot lands in that chat, highlighted', () => {
  const bot = { ...place, kind: 'bot_conversation' as const, name: '' };
  it('an answer (a reply of the chat) names the chat and the message', () => {
    const to = openOf(bookmark({ item: message(bot, ROOT, BOT) }));
    const loc = messageLocation('eng', to?.type === 'message' ? to.target : (null as never), [], { land: true });
    expect(loc).toMatchObject({ pathname: `/t/eng/chat/${CH}`, search: `?thread=${ROOT}&message=${MSG}` });
  });
  it('the first message of a chat names itself as both', () => {
    const to = openOf(bookmark({ item: message(bot, null) }));
    const loc = messageLocation('eng', to?.type === 'message' ? to.target : (null as never), [], { land: true });
    expect(loc.search).toBe(`?thread=${MSG}&message=${MSG}`);
  });
  it('a thread bookmark of a chat opens the chat only', () => {
    expect(messageLocation('eng', { channelId: CH, channelKind: 'bot_conversation', channelName: null, messageId: ROOT, threadRootId: ROOT }, [], { land: true }).search).toBe(`?thread=${ROOT}`);
  });
  it('says which bot when the server could name it', () => {
    expect(placeOf(message({ ...bot, botName: 'Brain' }, ROOT, BOT))).toBe('Conversation with Brain');
    expect(placeOf(message({ ...bot, botName: null }, ROOT, CH))).toBe('Conversation with a bot');
  });
});

describe('a file lands in its place', () => {
  const team = { id: TEAM, slug: 'engineering', name: 'Engineering' };
  const file = (over: Record<string, unknown>) => ({ kind: 'file', store: 'attachment', name: 'a.pdf', path: null, size: 2048, mime: 'application/pdf', channel: null, team: null, missing: false, ...over }) as never;
  it('a repository file opens in its team’s Files, also when it is no longer there (the viewer says so)', () => {
    const b = bookmark({ target: { kind: 'repo_file', teamId: TEAM, path: 'docs/guide.md' } as never, item: file({ store: 'repo', name: 'guide.md', path: 'docs/guide.md', team }) });
    expect(openOf(b)).toEqual({ type: 'href', to: '/t/engineering/files?open=docs%2Fguide.md' });
    const gone = bookmark({ target: b.target, item: file({ store: 'repo', name: 'guide.md', path: 'docs/guide.md', team, size: null, missing: true }) });
    expect(openOf(gone)).toEqual({ type: 'href', to: '/t/engineering/files?open=docs%2Fguide.md' });
    expect(fileMetaOf(gone.item as never)).toBe('No longer there');
    expect(placeOf(b.item as never)).toBe('Engineering files');
  });
  it('a Personal file opens in Personal', () => {
    const b = bookmark({ target: { kind: 'file', fileId: FILE } as never, item: file({ store: 'personal', name: 'n.md', path: 'Notes/n.md' }) });
    expect(openOf(b)).toEqual({ type: 'href', to: '/files?open=Notes%2Fn.md' });
    expect(placeOf(b.item as never)).toBe('Personal');
  });
  it('an attachment opens in the right panel by its id', () => {
    const b = bookmark({ target: { kind: 'file', fileId: FILE } as never, item: file({ channel: place }) });
    expect(openOf(b)).toEqual({ type: 'panel', entry: { type: 'file', id: FILE } });
    expect(placeOf(b.item as never)).toBe('# dev');
    expect(fileMetaOf(b.item as never)).toBe('2 KB');
  });
  it('a removal has Undo only when the item could be bookmarked again: not when it is no longer available, nor a repository file no longer at its path', () => {
    const repo = (missing: boolean) =>
      bookmark({ target: { kind: 'repo_file', teamId: TEAM, path: 'docs/guide.md' } as never, item: file({ store: 'repo', name: 'guide.md', path: 'docs/guide.md', team, size: missing ? null : 1, missing }) });
    expect(canUndoRemoval(repo(false))).toBe(true);
    expect(canUndoRemoval(repo(true))).toBe(false);
    expect(canUndoRemoval(bookmark({ item: null }))).toBe(false);
    expect(canUndoRemoval(bookmark({ item: message(place, null) }))).toBe(true);
  });
  it('a file no longer readable opens nothing, and the page has a Files tab', () => {
    expect(openOf(bookmark({ target: { kind: 'file', fileId: FILE } as never, item: null }))).toBeNull();
    expect(tabFrom('file')).toBe('file');
  });
});

describe('a Files row as a bookmark', () => {
  const row = (over: Partial<FileRow>): FileRow => ({
    path: 'docs/a.md', name: 'a.md', kind: 'file', store: 'git', size: 1, mime: 'text/markdown', modifiedAt: null, by: null, where: null,
    readOnly: false, readOnlyReason: null, managedBy: null, fileId: null, channelId: null, blobSha: null, contentUrl: null, ...over,
  });
  it('every store: a repository file by team and path, an attachment and a Personal file by id; never a folder or an admin’s look', () => {
    expect(fileBookmarkTarget(row({}), TEAM)).toEqual({ kind: 'repo_file', teamId: TEAM, path: 'docs/a.md' });
    expect(fileBookmarkTarget(row({}), null)).toBeNull();
    expect(fileBookmarkTarget(row({ store: 'attachments', fileId: FILE, path: 'channels/dev/a.pdf' }), TEAM)).toEqual({ kind: 'file', fileId: FILE });
    expect(fileBookmarkTarget(row({ store: 'personal', fileId: FILE, path: 'Notes/a.md' }), null)).toEqual({ kind: 'file', fileId: FILE });
    expect(fileBookmarkTarget(row({ kind: 'folder' }), TEAM)).toBeNull();
    expect(fileBookmarkTarget(row({ store: 'personal', fileId: FILE, readOnly: true, readOnlyReason: 'admin_view' }), null)).toBeNull();
  });
  it('the row menu says Bookmark or Remove bookmark, files only', () => {
    const files = { slug: 'engineering', teamName: 'Engineering', space: 'team' } as unknown as TeamFiles;
    const toggle = vi.fn();
    const entries = (r: FileRow, on: boolean | null) =>
      rowEntries(r, files, { start: () => undefined, history: () => undefined, bookmark: on === null ? null : { on, busy: false, toggle } });
    const off = entries(row({}), false).find((e) => e.id === 'bookmark');
    expect(off?.label).toBe('Bookmark');
    off?.run?.();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(entries(row({}), true).find((e) => e.id === 'bookmark')?.label).toBe('Remove bookmark');
    expect(entries(row({}), null).some((e) => e.id === 'bookmark')).toBe(false);
    expect(entries(row({ kind: 'folder' }), false).some((e) => e.id === 'bookmark')).toBe(false);
  });
});

describe('the wait for the row to highlight', () => {
  let host: HTMLDivElement;
  let root: Root;
  const seen: Array<string | null> = [];
  const found = vi.fn();
  function List({ target, rows, older }: { target: string | null; rows: string[]; older?: OlderPages }) {
    const box = useRef<HTMLDivElement>(null);
    const shown = useJumpHighlight(box, target, true, found, older);
    seen.push(shown);
    return createElement('div', { ref: box }, ...rows.map((id) => createElement('div', { key: id, 'data-message-id': id, className: shown === id ? 'hl' : '' })));
  }
  beforeEach(() => {
    vi.useFakeTimers();
    seen.length = 0;
    found.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('finds a reply drawn a moment later, scrolls it into view, lets go of the bottom, and the highlight fades like the channel’s flash', () => {
    act(() => root.render(createElement(List, { target: MSG, rows: [ROOT] })));
    expect(seen.at(-1)).toBeNull();
    act(() => root.render(createElement(List, { target: MSG, rows: [ROOT, MSG] })));
    act(() => void vi.advanceTimersByTime(200));
    expect(seen.at(-1)).toBe(MSG);
    expect(found).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(host.querySelector(`[data-message-id="${MSG}"]`)?.className).toBe('hl');
    act(() => void vi.advanceTimersByTime(JUMP_HOLD_MS + 100));
    expect(seen.at(-1)).toBeNull();
    expect(found).toHaveBeenCalledTimes(1);
  });

  it('a long thread: loads older pages one after the other until the reply is drawn, then highlights it', () => {
    // 3 pages of 50: the target is the oldest reply, on the last page
    const all = Array.from({ length: 150 }, (_, i) => `0194f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`);
    const target = all[0]!;
    let held = all.slice(100);
    let loading = false;
    const load = vi.fn(() => {
      loading = true;
      // the page arrives a moment later, as the store's loader does
      setTimeout(() => {
        held = all.slice(Math.max(0, all.indexOf(held[0]!) - 50));
        loading = false;
        draw();
      }, 300);
      draw();
    });
    const draw = (): void => act(() => root.render(createElement(List, { target, rows: held, older: { more: held[0] !== all[0], loading, load } })));
    draw();
    // a step at a time, so each page drawn is on screen before the next look
    for (let i = 0; i < 20; i += 1) act(() => void vi.advanceTimersByTime(150));
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe(target);
    expect(host.querySelector(`[data-message-id="${target}"]`)?.className).toBe('hl');
  });

  it('gives up after a few seconds when the row never comes, and moves nothing', () => {
    act(() => root.render(createElement(List, { target: MSG, rows: [ROOT] })));
    act(() => void vi.advanceTimersByTime(JUMP_FIND_MS + 500));
    act(() => root.render(createElement(List, { target: MSG, rows: [ROOT, MSG] })));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(seen.at(-1)).toBeNull();
    expect(found).not.toHaveBeenCalled();
  });
});
