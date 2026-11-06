import { describe, expect, it } from 'vitest';
import { NavChannelGroup, type DirectMessageSummary } from '@manythreads/shared';
import { pushRecent } from '../src/app/recentPlaces';
import {
  botItems,
  dedupePeople,
  filterByTab,
  nextTab,
  withRecent,
  cardItems,
  channelItems,
  dmItems,
  fileItems,
  filterChannels,
  flatChannels,
  isQuickSwitcherKey,
  nextIndex,
  nextUnreadStop,
  openConversationOf,
  pageItems,
  personItems,
  rankItems,
  sectionItems,
  switcherTeamSlug,
  typingIn,
} from '../src/app/quick-switcher';

const key = (over: Record<string, unknown> = {}): KeyboardEvent => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;
const group = (id: string, channels: Array<{ name: string; isPrivate?: boolean }>): NavChannelGroup =>
  NavChannelGroup.parse({ id, name: id, channels: channels.map((c) => ({ id: `ch-${id}-${c.name}`, name: c.name, isPrivate: c.isPrivate ?? false, unread: 0 })) });
const channel = (name: string, isPrivate = false) => ({ id: `ch-${name}`, name, isPrivate });
/** A stand-in for a focused element: typingIn reads only tagName and isContentEditable, so plain objects do. */
const el = (props: Record<string, unknown>): EventTarget => props as unknown as EventTarget;

describe('isQuickSwitcherKey', () => {
  it('is Ctrl+K and Cmd+K, nothing else', () => {
    expect(isQuickSwitcherKey(key({ ctrlKey: true }))).toBe(true);
    expect(isQuickSwitcherKey(key({ metaKey: true }))).toBe(true);
    expect(isQuickSwitcherKey(key({}))).toBe(false);
    expect(isQuickSwitcherKey(key({ ctrlKey: true, key: 'j' }))).toBe(false);
    expect(isQuickSwitcherKey(key({ altKey: true, key: 'k' }))).toBe(false);
  });

  it('works with Caps Lock on, which reports the capital letter', () => {
    expect(isQuickSwitcherKey(key({ ctrlKey: true, key: 'K' }))).toBe(true);
    expect(isQuickSwitcherKey(key({ metaKey: true, key: 'K' }))).toBe(true);
    expect(isQuickSwitcherKey(key({ key: 'K' }))).toBe(false);
    expect(isQuickSwitcherKey(key({ ctrlKey: true, key: 'J' }))).toBe(false);
  });

  it('leaves Ctrl+Shift+K and Ctrl+Alt+K to the browser', () => {
    expect(isQuickSwitcherKey(key({ ctrlKey: true, shiftKey: true, key: 'K' }))).toBe(false);
    expect(isQuickSwitcherKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe('flatChannels', () => {
  it('flattens the directory groups in sidebar order, keeping privacy', () => {
    const channels = flatChannels([group('work', [{ name: 'dev' }, { name: 'ops', isPrivate: true }]), group('archive', [{ name: '2025' }])]);
    expect(channels).toEqual([
      { id: 'ch-work-dev', name: 'dev', isPrivate: false },
      { id: 'ch-work-ops', name: 'ops', isPrivate: true },
      { id: 'ch-archive-2025', name: '2025', isPrivate: false },
    ]);
    expect(flatChannels([])).toEqual([]);
  });
});

describe('filterChannels', () => {
  const list = [channel('Dev'), channel('#dev-social'), channel('Ops'), channel('ops-private', true)];

  it('matches case-insensitively on the name, with the # optional', () => {
    expect(filterChannels(list, 'DEV')).toEqual([channel('Dev'), channel('#dev-social')]);
    expect(filterChannels(list, '#dev')).toEqual([channel('Dev'), channel('#dev-social')]);
    expect(filterChannels(list, 'ops')).toEqual([channel('Ops'), channel('ops-private', true)]);
  });

  it('keeps the whole list for an empty query and nothing for a name nobody has', () => {
    expect(filterChannels(list, '')).toEqual(list);
    expect(filterChannels(list, '   ')).toEqual(list);
    expect(filterChannels(list, 'zzz')).toEqual([]);
  });
});

describe('nextIndex', () => {
  it('moves down and up, clamped at the ends', () => {
    expect(nextIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(nextIndex(3, 2, 'ArrowDown')).toBe(2);
    expect(nextIndex(3, 2, 'ArrowUp')).toBe(1);
    expect(nextIndex(3, 0, 'ArrowUp')).toBe(0);
  });

  it('starts from no selection: down picks the first, up the last', () => {
    expect(nextIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(nextIndex(3, -1, 'ArrowUp')).toBe(2);
  });

  it('has nothing to select in an empty list, and other keys keep the row', () => {
    expect(nextIndex(0, 0, 'ArrowDown')).toBe(-1);
    expect(nextIndex(2, 1, 'Enter')).toBe(1);
    expect(nextIndex(2, 1, 'Escape')).toBe(1);
  });
});

describe('typingIn', () => {
  it('says yes for the text fields and editors', () => {
    expect(typingIn(el({ tagName: 'INPUT' }))).toBe(true);
    expect(typingIn(el({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(typingIn(el({ tagName: 'SELECT' }))).toBe(true);
    expect(typingIn(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('says no for the rest of the page and for no focus at all', () => {
    expect(typingIn(null)).toBe(false);
    expect(typingIn(el({}))).toBe(false);
    expect(typingIn(el({ tagName: 'BODY' }))).toBe(false);
    expect(typingIn(el({ tagName: 'DIV' }))).toBe(false);
    expect(typingIn(el({ tagName: 'BUTTON' }))).toBe(false);
    expect(typingIn(el({ tagName: 'svg' }))).toBe(false);
  });
});

describe('switcherTeamSlug', () => {
  it('takes the team out of the URL', () => {
    expect(switcherTeamSlug('/t/engineering/c/dev', false, 'older')).toBe('engineering');
    expect(switcherTeamSlug('/t/engineering/threads', false, null)).toBe('engineering');
    expect(switcherTeamSlug('/t/engineering', true, null)).toBe('engineering');
  });

  it('falls back to the guest slug, then to the last team visited, then to none', () => {
    expect(switcherTeamSlug('/', true, 'older')).toBe('shared');
    expect(switcherTeamSlug('/', false, 'older')).toBe('older');
    expect(switcherTeamSlug('/', false, null)).toBeNull();
    expect(switcherTeamSlug('/account', false, null)).toBeNull();
  });
});

describe('rankItems', () => {
  const groups = [group('work', [{ name: 'dev' }, { name: 'dev-social' }, { name: 'ops-dev', isPrivate: true }, { name: 'general' }])];
  const items = [
    ...channelItems(groups, 'eng'),
    ...personItems([{ personId: 'p1', displayName: 'Devi Rao' }, { personId: 'me', displayName: 'Me Myself' }], 'me'),
    ...botItems([{ id: 'b1', slug: 'coder', name: 'Coder', role: 'writes code' }], 'eng'),
    ...sectionItems('eng', false),
  ];
  const labels = (q: string): string[] => rankItems(items, q).map((i) => i.label);

  it('puts the whole name first, then the start of a name, then the start of a word, then any place', () => {
    expect(labels('dev')).toEqual(['dev', 'dev-social', 'Devi Rao', 'ops-dev']);
  });

  it('matches without case and with an optional #', () => {
    expect(labels('#GENERAL')).toEqual(['general']);
  });

  it('lists channels before people, bots and screens when nothing is typed, and never the person themselves', () => {
    const all = labels('');
    expect(all.slice(0, 4)).toEqual(['dev', 'dev-social', 'ops-dev', 'general']);
    expect(all).not.toContain('Me Myself');
    expect(all).toContain('Files');
  });

  it('answers nothing for a name nobody has', () => {
    expect(labels('zzzz')).toEqual([]);
  });

  it('cuts a long list to a screenful', () => {
    const many = Array.from({ length: 80 }, (_, i) => channel(`c${i}`));
    expect(rankItems(channelItems([group('g', many.map((c) => ({ name: c.name })))], 'eng'), '')).toHaveLength(50);
  });
});

describe('item builders', () => {
  it('opens a channel by name, a private one with the lock flag', () => {
    const [a] = channelItems([group('g', [{ name: '#ops team', isPrivate: true }])], 'eng');
    expect(a).toMatchObject({ kind: 'channel', label: 'ops team', to: '/t/eng/c/ops%20team', isPrivate: true });
  });

  it('names a direct message by the other people, or Notes to self', () => {
    const dm = (people: string[]) =>
      ({ channel: { id: 'ch1' }, participants: people.map((n) => ({ personId: n === 'Me' ? 'me' : n, displayName: n })) }) as never;
    expect(dmItems([dm(['Me', 'Ana', 'Bo'])], 'me', 'eng')[0]).toMatchObject({ label: 'Ana, Bo', to: '/t/eng/dm/ch1' });
    expect(dmItems([dm(['Me'])], 'me', 'eng')[0]?.label).toBe('Notes to self');
  });

  it('opens a card on its board, and a page or a file in the Files screen', () => {
    expect(cardItems([{ id: 'k1', title: 'Fix login', state: 'in_progress', boardId: 'bd1' }], 'eng')[0]).toMatchObject({ to: '/t/eng/boards?board=bd1&card=k1', hint: 'Card · in progress' });
    expect(cardItems([{ id: 'k2', title: 'No board', state: 'todo', boardId: null }], 'eng')[0]?.to).toBe('/t/eng/boards?card=k2');
    expect(pageItems([{ name: 'runbook.md', path: 'pages/runbook.md', kind: 'file' }, { name: 'sub', path: 'pages/sub', kind: 'dir' }], 'eng')).toEqual([
      expect.objectContaining({ label: 'runbook', hint: 'Page', to: '/t/eng/files?open=pages%2Frunbook.md' }),
    ]);
    const hit = (teamId: string | null) =>
      ({ id: 'f1', name: 'spec.pdf', folderPath: 'channels/dev/', channel: teamId === null ? null : { id: 'c', name: 'dev', kind: 'channel', teamId } }) as never;
    expect(fileItems([hit('t1')], 'eng', 't1')[0]).toMatchObject({ label: 'spec.pdf', hint: 'File · #dev', to: '/t/eng/files?open=channels%2Fdev%2Fspec.pdf' });
    expect(fileItems([hit('t2')], 'eng', 't1')).toEqual([]);
  });

  it('has no screens for a guest', () => {
    expect(sectionItems('eng', true)).toEqual([]);
  });
});

describe('nextUnreadStop', () => {
  const stops = ['a', 'b', 'c', 'd'].map((id) => ({ id, to: `/${id}` }));

  it('walks down and up to the next conversation with unread messages, wrapping round', () => {
    const unread = { b: 2, d: 1 };
    expect(nextUnreadStop(stops, unread, 'a', 1)?.id).toBe('b');
    expect(nextUnreadStop(stops, unread, 'b', 1)?.id).toBe('d');
    expect(nextUnreadStop(stops, unread, 'd', 1)?.id).toBe('b');
    expect(nextUnreadStop(stops, unread, 'd', -1)?.id).toBe('b');
    expect(nextUnreadStop(stops, unread, 'b', -1)?.id).toBe('d');
    expect(nextUnreadStop(stops, unread, 'a', -1)?.id).toBe('d');
  });

  it('starts from the top (down) or the bottom (up) when no conversation is open', () => {
    expect(nextUnreadStop(stops, { b: 1, c: 1 }, null, 1)?.id).toBe('b');
    expect(nextUnreadStop(stops, { b: 1, c: 1 }, null, -1)?.id).toBe('c');
  });

  it('never answers the open conversation, and answers null when nothing else is unread', () => {
    expect(nextUnreadStop(stops, { b: 3 }, 'b', 1)).toBeNull();
    expect(nextUnreadStop(stops, {}, 'a', 1)).toBeNull();
    expect(nextUnreadStop([], { b: 1 }, null, 1)).toBeNull();
  });
});

describe('openConversationOf', () => {
  it('reads a channel name or a direct message id from the address', () => {
    expect(openConversationOf('/t/eng/c/dev')).toEqual({ kind: 'channel', name: 'dev' });
    expect(openConversationOf('/t/eng/c/ops%20team/')).toEqual({ kind: 'channel', name: 'ops team' });
    expect(openConversationOf('/t/eng/dm/abc-1')).toEqual({ kind: 'dm', id: 'abc-1' });
    expect(openConversationOf('/t/eng/threads')).toBeNull();
    expect(openConversationOf('/t/eng/c/%E0%A4%A')).toEqual({ kind: 'channel', name: '%E0%A4%A' });
  });
});

describe('recent, dedupe and tabs', () => {
  const a = { key: 'channel:1', kind: 'channel', label: 'dev', hint: '', to: '/x', personId: null, isPrivate: false } as const;
  const b = { key: 'channel:2', kind: 'channel', label: 'ops', hint: '', to: '/y', personId: null, isPrivate: false } as const;
  const p = { key: 'person:nadia', kind: 'person', label: 'Nadia', hint: '', to: null, personId: 'nadia', isPrivate: false } as const;
  const f = { key: 'file:1', kind: 'file', label: 'plan.pdf', hint: '', to: '/f', personId: null, isPrivate: false } as const;

  it('puts recent places first only when nothing is typed', () => {
    expect(withRecent([a, b, p], ['channel:2', 'gone'], '').map((i) => i.key)).toEqual(['channel:2', 'channel:1', 'person:nadia']);
    expect(withRecent([a, b], ['channel:2'], 'd').map((i) => i.key)).toEqual(['channel:1', 'channel:2']);
  });

  it('drops the person row when a 1:1 conversation exists', () => {
    const dm = {
      channel: { id: '11111111-1111-4111-8111-111111111111', name: null, isPrivate: true },
      participants: [
        { personId: 'me', displayName: 'Me' },
        { personId: 'nadia', displayName: 'Nadia' },
      ],
      unreadCount: 0,
    } as unknown as DirectMessageSummary;
    expect(dedupePeople([a, p], [dm], 'me')).toEqual([a]);
    expect(dedupePeople([a, p], [], 'me')).toEqual([a, p]);
  });

  it('filters by tab and cycles', () => {
    expect(filterByTab([a, p, f], 'channels')).toEqual([a]);
    expect(filterByTab([a, p, f], 'files')).toEqual([f]);
    expect(filterByTab([a, p, f], 'all')).toHaveLength(3);
    expect(nextTab('files', 1)).toBe('all');
    expect(nextTab('all', -1)).toBe('files');
  });

  it('keeps eight recent places, newest first, no repeats', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(pushRecent(list, 'c')).toEqual(['c', 'a', 'b', 'd', 'e', 'f', 'g', 'h']);
    expect(pushRecent(list, 'z')).toHaveLength(8);
    expect(pushRecent(list, 'z')[0]).toBe('z');
  });
});
