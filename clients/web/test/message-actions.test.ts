import type { DirectMessageSummary, NavChannelGroup } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { NO_THREAD_CLICK, channelTargets, dmLabel, dmTargets, filterTargets, messageLinkPath, messageLinkUrl, rowClickOpensThread, versionTime } from '../src/channels/messageActions';
import { bookmarkHref } from '../src/channels/BookmarksBar';
import { outcomeOfError } from '../src/notifications/OpenLink';

const CH = '0190a000-0000-7000-8000-000000000001';
const MSG = '0190a000-0000-7000-8000-000000000002';
const ROOT = '0190a000-0000-7000-8000-000000000003';

describe('message links', () => {
  it('names the channel and the message, and the thread root for a reply', () => {
    expect(messageLinkPath({ channelId: CH, messageId: MSG, threadRootId: null })).toBe(`/open?channel=${CH}&message=${MSG}`);
    expect(messageLinkPath({ channelId: CH, messageId: MSG, threadRootId: ROOT })).toBe(`/open?channel=${CH}&message=${MSG}&root=${ROOT}`);
  });

  it('puts the site in front without doubling a slash, and carries ids only (no channel name, no text)', () => {
    const url = messageLinkUrl('https://manythreads.example/', { channelId: CH, messageId: MSG, threadRootId: null });
    expect(url).toBe(`https://manythreads.example/open?channel=${CH}&message=${MSG}`);
    expect(url).not.toMatch(/#|dev/);
  });
});

describe('what a failed link means', () => {
  const err = (status: number): ApiError => new ApiError({ code: 'forbidden', message: 'x', status });
  it('403 is no access, 404 is a message that is gone, anything else is a failure to retry', () => {
    expect(outcomeOfError(err(403))).toBe('denied');
    expect(outcomeOfError(err(404))).toBe('gone');
    expect(outcomeOfError(err(500))).toBe('failed');
    expect(outcomeOfError(new Error('offline'))).toBe('failed');
  });
});

describe('earlier-version times', () => {
  const now = new Date(2026, 9, 29, 15, 0);
  it('reads as a day word or date, then the clock', () => {
    expect(versionTime(new Date(2026, 9, 29, 9, 5).toISOString(), now)).toBe('Today 09:05');
    expect(versionTime(new Date(2026, 9, 28, 23, 40).toISOString(), now)).toBe('Yesterday 23:40');
  });
});

describe('forward targets', () => {
  const groups: NavChannelGroup[] = [
    { id: 'g', name: 'Channels', channels: [{ id: 'c1', name: 'dev', isPrivate: false, unread: 0 }, { id: 'c2', name: '#leads', isPrivate: true, unread: 0 }] },
  ];
  const dm = (id: string, names: [string, string][]): DirectMessageSummary =>
    ({ channel: { id }, participants: names.map(([personId, displayName]) => ({ personId, displayName })), lastMessage: null, unreadCount: 0 }) as unknown as DirectMessageSummary;

  it('lists channels with their team as the hint, and conversations by the other people', () => {
    const all = [...channelTargets([{ teamName: 'Engineering', groups }]), ...dmTargets([dm('d1', [['me', 'Omar'], ['p2', 'Nadia']]), dm('d2', [['me', 'Omar']])], 'me')];
    expect(all.map((t) => [t.label, t.hint, t.kind])).toEqual([
      ['#dev', 'Engineering', 'channel'],
      ['#leads', 'Engineering', 'channel'],
      ['Nadia', 'Direct message', 'dm'],
      ['Just you', 'Direct message', 'dm'],
    ]);
    expect(dmLabel(dm('d3', [['me', 'Omar'], ['a', 'Ada'], ['b', 'Bo']]), 'me')).toBe('Ada, Bo');
  });

  it('filters by name or team, ignoring case and a leading #', () => {
    const all = channelTargets([{ teamName: 'Engineering', groups }, { teamName: 'Marketing', groups: [{ id: 'g2', name: 'Channels', channels: [{ id: 'c3', name: 'campaigns', isPrivate: false, unread: 0 }] }] }]);
    expect(filterTargets(all, '').length).toBe(3);
    expect(filterTargets(all, '#DEV').map((t) => t.id)).toEqual(['c1']);
    expect(filterTargets(all, 'market').map((t) => t.id)).toEqual(['c3']);
    expect(filterTargets(all, 'zzz')).toEqual([]);
  });
});

describe('where a bookmark leads', () => {
  it('opens a link and a file in a new tab, a page in the team\'s Files screen, and refuses a link that is not http(s)', () => {
    expect(bookmarkHref({ kind: 'link', target: 'https://example.com/a' }, 'engineering')).toEqual({ href: 'https://example.com/a', external: true });
    expect(bookmarkHref({ kind: 'link', target: 'javascript:alert(1)' }, 'engineering')).toBeNull();
    expect(bookmarkHref({ kind: 'file', target: CH }, null)).toEqual({ href: `/api/files/${CH}/content`, external: true });
    expect(bookmarkHref({ kind: 'page', target: 'pages/a b.md' }, 'engineering')).toEqual({ href: '/t/engineering/files?open=pages%2Fa%20b.md', external: false });
    expect(bookmarkHref({ kind: 'page', target: 'pages/a.md' }, null)).toBeNull();
  });
});

describe('a click on a message row opens its thread (P21-26)', () => {
  /** A stand-in for a clicked element: `closest` answers yes when any listed simple selector (a tag, `.class`, `parent child`) of the product's selector fits `parts`. */
  const target = (...parts: string[]) => ({
    closest: (selector: string) => (selector.split(',').some((sel) => parts.includes(sel)) ? {} : null),
  });
  const base = {
    target: target(),
    selectionText: '',
    detail: 1,
    mods: { ctrl: false, meta: false, shift: false, alt: false },
    editing: false,
    inThread: false,
    replyCount: 2,
    hasOpen: true,
  };

  it('opens on a plain single click on the text of a message that has replies', () => {
    expect(rowClickOpensThread(base)).toBe(true);
  });

  it('does not open without replies, inside the thread, while editing, or when nothing can open it', () => {
    expect(rowClickOpensThread({ ...base, replyCount: 0 })).toBe(false);
    expect(rowClickOpensThread({ ...base, inThread: true })).toBe(false);
    expect(rowClickOpensThread({ ...base, editing: true })).toBe(false);
    expect(rowClickOpensThread({ ...base, hasOpen: false })).toBe(false);
  });

  it('leaves a selection, a double or triple click, and a modified click alone', () => {
    expect(rowClickOpensThread({ ...base, selectionText: 'some words' })).toBe(false);
    expect(rowClickOpensThread({ ...base, detail: 2 })).toBe(false);
    expect(rowClickOpensThread({ ...base, detail: 3 })).toBe(false);
    for (const key of ['ctrl', 'meta', 'shift', 'alt'] as const) {
      expect(rowClickOpensThread({ ...base, mods: { ...base.mods, [key]: true } }), key).toBe(false);
    }
  });

  it('leaves a click on a control, a link, a chip, a picture, the toolbar, a poll or the author name alone', () => {
    for (const part of ['a', 'button', 'input', 'label', 'img', '.acts', '.m', '.chref', '.show-more', '.poll', '.who b', '.edit-box']) {
      expect(rowClickOpensThread({ ...base, target: target(part) }), part).toBe(false);
    }
    expect(rowClickOpensThread({ ...base, target: target('.txt') })).toBe(true);
  });

  it('asks the DOM with one selector that names each excluded part', () => {
    for (const part of ['a', 'button', 'textarea', 'input', 'label', 'img', '.acts', '.m', '.chref', '.show-more', '.poll', '.who b', '.edit-box', '.vpop', '.dlg-scrim']) {
      expect(NO_THREAD_CLICK.split(',')).toContain(part);
    }
    const asked: string[] = [];
    rowClickOpensThread({ ...base, target: { closest: (s: string) => (asked.push(s), null) } });
    expect(asked).toEqual([NO_THREAD_CLICK]);
  });
});
