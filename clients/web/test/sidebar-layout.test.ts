import { describe, expect, it } from 'vitest';
import { DEFAULT_SIDEBAR_PREFS, MAX_STARRED_CHANNELS, type NavChannel, type NavChannelGroup, type SidebarPrefs } from '@manythreads/shared';
import { applyPatch, arrangeSidebar, dropId, inversePatch, isIdle, moveId, orderGroups, reorderShown, shownGroupIds, sortChannels, starPatch } from '../src/shell/sidebarLayout';

// How the personal sidebar is laid out (P14-15): Starred group, sort, hide idle channels, the order of the groups.

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ch = (n: number, name: string, days: number | null, extra: Partial<NavChannel> = {}): NavChannel => ({
  id: uuid(n),
  name,
  isPrivate: false,
  unread: 0,
  lastActivityAt: days === null ? null : ago(days),
  ...extra,
});
const group = (n: number, name: string, channels: NavChannel[]): NavChannelGroup => ({ id: uuid(n), name, channels });
const prefs = (over: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ ...DEFAULT_SIDEBAR_PREFS, ...over }) as SidebarPrefs;
const names = (list: readonly NavChannel[]): string[] => list.map((c) => c.name);
const arrange = (groups: NavChannelGroup[], p: SidebarPrefs, extra: { unread?: Record<string, number>; open?: string | null } = {}) =>
  arrangeSidebar({ groups, prefs: p, unreadOf: (c) => extra.unread?.[c.id] ?? c.unread, openName: extra.open ?? null, now: NOW });

describe('sorting channels', () => {
  const list = [ch(1, 'beta', 3), ch(2, 'alpha', 10), ch(3, 'gamma', 1), ch(4, 'empty', null)];
  it('team order (the default) keeps the order the team set', () => {
    expect(DEFAULT_SIDEBAR_PREFS.sort).toBe('team');
    expect(names(sortChannels(list, 'team'))).toEqual(['beta', 'alpha', 'gamma', 'empty']);
  });
  it('recent activity puts the newest message first and a channel with no known time last', () => {
    expect(names(sortChannels(list, 'recent'))).toEqual(['gamma', 'beta', 'alpha', 'empty']);
  });
  it('name is alphabetical whatever the activity, and ignores case and a leading #', () => {
    expect(names(sortChannels([ch(1, '#Zed', 1), ch(2, 'apple', 9), ch(3, 'Mango', 5)], 'name'))).toEqual(['apple', 'Mango', '#Zed']);
  });
  it('channels with the same time keep a fixed order by name', () => {
    const same = [ch(1, 'b', 2), ch(2, 'a', 2)];
    expect(names(sortChannels(same, 'recent'))).toEqual(['a', 'b']);
  });
  it('does not change the list it is given', () => {
    const copy = [...list];
    sortChannels(list, 'name');
    expect(list).toEqual(copy);
  });
});

describe('idle channels', () => {
  it('idle means more than 30 days without a message; a channel with no known time is never idle', () => {
    expect(isIdle(ch(1, 'a', 31), NOW)).toBe(true);
    expect(isIdle(ch(1, 'a', 30), NOW)).toBe(false);
    expect(isIdle(ch(1, 'a', 29), NOW)).toBe(false);
    expect(isIdle(ch(1, 'a', null), NOW)).toBe(false);
    expect(isIdle({ lastActivityAt: 'not a date' }, NOW)).toBe(false);
  });
});

describe('the Starred group', () => {
  const groups = [group(100, 'Channels', [ch(1, 'dev', 1), ch(2, 'general', 5), ch(3, 'ops', 2)]), group(101, 'Projects', [ch(4, 'apollo', 40)])];
  it('lists starred channels in their own group and in no other, sorted the way the person chose', () => {
    const a = arrange(groups, prefs({ starred: [uuid(4), uuid(2)] as never, sort: 'name' }));
    expect(names(a.starred)).toEqual(['apollo', 'general']);
    expect(a.groups.map((g) => names(g.channels))).toEqual([['dev', 'ops']]);
  });
  it('leaves a group out when all its channels are starred', () => {
    const a = arrange(groups, prefs({ starred: [uuid(4)] as never }));
    expect(a.groups.map((g) => g.name)).toEqual(['Channels']);
  });
  it('has no Starred group when nothing is starred, and ignores a star for a channel that is not listed', () => {
    expect(arrange(groups, prefs()).starred).toEqual([]);
    expect(arrange(groups, prefs({ starred: [uuid(99)] as never })).starred).toEqual([]);
  });
  it('with the team order, the Starred group follows the groups as they are shown, then the team order inside each', () => {
    const g = [group(100, 'Channels', [ch(1, 'dev', 1), ch(2, 'general', 5)]), group(101, 'Projects', [ch(4, 'apollo', 40), ch(5, 'zed', 3)])];
    const a = arrange(g, prefs({ starred: [uuid(5), uuid(2), uuid(4), uuid(1)] as never, groupOrder: [uuid(101), uuid(100)] as never }));
    expect(names(a.starred)).toEqual(['apollo', 'zed', 'dev', 'general']);
    expect(names(arrange(g, prefs({ starred: [uuid(5), uuid(2)] as never, sort: 'recent' })).starred)).toEqual(['zed', 'general']);
  });
  it('builds the change for a star, sends nothing for one already there, and refuses a 101st', () => {
    expect(starPatch([], uuid(1), true)).toEqual({ starAdd: [uuid(1)] });
    expect(starPatch([uuid(1)], uuid(1), true)).toEqual({});
    expect(starPatch([uuid(1), uuid(2)], uuid(1), false)).toEqual({ starRemove: [uuid(1)] });
    const full = Array.from({ length: MAX_STARRED_CHANNELS }, (_, i) => uuid(i + 1));
    expect(starPatch(full, uuid(500), true)).toBeNull();
    expect(starPatch(full, full[0]!, false)).toEqual({ starRemove: [full[0]] });
  });
  it('applies a change to the view and takes it back', () => {
    const base = prefs({ starred: [uuid(1), uuid(2)] as never, sort: 'name', groupOrder: [uuid(7)] as never });
    const patch = { starAdd: [uuid(3), uuid(1)] as never, starRemove: [uuid(2)] as never, sort: 'recent' as const, groupOrder: [uuid(8), uuid(7)] as never };
    const after = applyPatch(base, patch);
    expect(after).toEqual({ starred: [uuid(1), uuid(3)], sort: 'recent', hideIdle: false, groupOrder: [uuid(8), uuid(7)] });
    expect(applyPatch(after, inversePatch(base, patch))).toEqual({ ...base, starred: [uuid(1), uuid(2)] });
    // stars made elsewhere in the meantime survive the undo: only this change's own stars are touched
    expect(applyPatch(prefs({ starred: [uuid(1), uuid(9)] as never }), { starRemove: [uuid(1)] as never }).starred).toEqual([uuid(9)]);
  });
});

describe('hiding channels idle for 30 days', () => {
  const groups = [
    group(100, 'Channels', [ch(1, 'new', 2), ch(2, 'old', 45), ch(3, 'older', 90), ch(4, 'unread-old', 60), ch(5, 'open-old', 70), ch(6, 'star-old', 80)]),
  ];
  it('folds idle channels into the hidden list of their group, and does nothing while the setting is off', () => {
    const off = arrange(groups, prefs());
    expect(off.groups[0]!.hidden).toEqual([]);
    expect(off.groups[0]!.channels).toHaveLength(6);
    const on = arrange(groups, prefs({ hideIdle: true }));
    expect(names(on.groups[0]!.hidden).sort()).toEqual(['old', 'older', 'open-old', 'star-old', 'unread-old']);
    expect(names(on.groups[0]!.channels)).toEqual(['new']);
  });
  it('never hides a channel with unread messages, the open one, or a starred one', () => {
    const on = arrange(groups, prefs({ hideIdle: true, starred: [uuid(6)] as never }), { unread: { [uuid(4)]: 3 }, open: '#Open-Old' });
    expect(names(on.groups[0]!.channels).sort()).toEqual(['new', 'open-old', 'unread-old']);
    expect(names(on.groups[0]!.hidden).sort()).toEqual(['old', 'older']);
    expect(names(on.starred)).toEqual(['star-old']);
  });
  it('keeps a group that has only hidden channels, so its "N hidden" row can be drawn', () => {
    const only = [group(100, 'Channels', [ch(1, 'old', 45)])];
    const on = arrange(only, prefs({ hideIdle: true }));
    expect(on.groups).toHaveLength(1);
    expect(on.groups[0]!.channels).toEqual([]);
    expect(on.groups[0]!.hidden).toHaveLength(1);
  });
  it('does not hide a channel whose time is unknown', () => {
    const on = arrange([group(100, 'Channels', [ch(1, 'x', null)])], prefs({ hideIdle: true }));
    expect(on.groups[0]!.hidden).toEqual([]);
  });
});

describe('the order of the groups', () => {
  const groups = [group(1, 'A', [ch(11, 'a', 1)]), group(2, 'B', [ch(12, 'b', 1)]), group(3, 'C', [ch(13, 'c', 1)])];
  it('puts listed groups first in the order listed, and any other group after them in the server order', () => {
    expect(orderGroups(groups, [uuid(3), uuid(1)]).map((g) => g.name)).toEqual(['C', 'A', 'B']);
    expect(orderGroups(groups, []).map((g) => g.name)).toEqual(['A', 'B', 'C']);
    expect(orderGroups(groups, [uuid(99), uuid(2)]).map((g) => g.name)).toEqual(['B', 'A', 'C']);
  });
  it('arranges the groups in that order', () => {
    expect(arrange(groups, prefs({ groupOrder: [uuid(2), uuid(3)] })).groups.map((g) => g.name)).toEqual(['B', 'C', 'A']);
    expect(shownGroupIds(groups, [uuid(3)])).toEqual([uuid(3), uuid(1), uuid(2)]);
  });
  it('reorders only the shown groups: a group that is not shown keeps its place among the others', () => {
    // C is not shown (all its channels starred, say); A, B, D are
    expect(reorderShown(['A', 'B', 'C', 'D'], ['D', 'B', 'A'])).toEqual(['D', 'B', 'C', 'A']);
    expect(reorderShown(['C', 'A', 'B'], ['B', 'A'])).toEqual(['C', 'B', 'A']);
    expect(reorderShown(['A', 'B'], ['B', 'A'])).toEqual(['B', 'A']);
    // an id the team no longer has is ignored, and the groups that are not shown are never dropped
    expect(reorderShown(['A', 'B', 'C'], ['B', 'zzz', 'A'])).toEqual(['B', 'A', 'C']);
  });
  it('moves a group one place up or down and stops at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveId(ids, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(ids, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(ids, 'a', -1)).toEqual(ids);
    expect(moveId(ids, 'c', 1)).toEqual(ids);
    expect(moveId(ids, 'zzz', 1)).toEqual(ids);
  });
  it('drops a dragged group before or after another', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(dropId(ids, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropId(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropId(ids, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropId(ids, 'b', 'b', true)).toEqual(ids);
    expect(dropId(ids, 'x', 'b', true)).toEqual(ids);
  });
});
