import { describe, expect, it } from 'vitest';
import { NavContribution, sortNav } from '@manythreads/shared';
import { CORE_NAV, channelPath, navCount, navHref, teamSwitchPath, viewTitle, visibleNav } from '../src/shell/nav';

const contribution = (over: Partial<NavContribution> & Pick<NavContribution, 'id' | 'order'>): NavContribution =>
  NavContribution.parse({ label: over.id, kind: 'item', ...over });

describe('sidebar contract', () => {
  it('is exactly Files, Boards, Threads, Approvals, channel groups, Direct messages, Bots in orders 10 20 30 35 40 45 50', () => {
    const sorted = sortNav(CORE_NAV);
    expect(sorted.map((i) => [i.order, i.label])).toEqual([
      [10, 'Files'], [20, 'Boards'], [30, 'Threads'], [35, 'Approvals'], [40, 'Channels'], [45, 'Direct messages'], [50, 'Bots'],
    ]);
    expect(sorted.map((i) => i.kind)).toEqual(['item', 'item', 'item', 'item', 'group-list', 'header', 'header']);
  });

  it('sorts a plugin contribution into place by order and keeps ties in the order given', () => {
    const plugin = contribution({ id: 'wiki', order: 25 });
    expect(sortNav([...CORE_NAV, plugin]).map((i) => i.id).slice(0, 4)).toEqual(['files', 'boards', 'wiki', 'threads']);
    const a = contribution({ id: 'a', order: 5 });
    const b = contribution({ id: 'b', order: 5 });
    expect(sortNav([b, a]).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('entries not built yet carry product copy for their empty state', () => {
    const copy = Object.fromEntries(CORE_NAV.map((i) => [i.id, i.emptyState]));
    expect(copy['files']).toBe('No files yet');
    expect(copy['boards']).toBe('No boards yet');
    expect(copy['approvals']).toBe('Nothing waiting');
    expect(copy['bots']).toBe('No bots yet');
    expect(JSON.stringify(CORE_NAV)).not.toMatch(/later phase|phase \d/i);
  });

  it('rejects a malformed contribution', () => {
    expect(NavContribution.safeParse({ id: 'X', order: 1, label: 'x', kind: 'item' }).success).toBe(false);
    expect(NavContribution.safeParse({ id: 'x', order: 1, label: 'x', kind: 'panel' }).success).toBe(false);
    expect(NavContribution.safeParse({ id: 'x', order: -1, label: 'x', kind: 'item' }).success).toBe(false);
    expect(NavContribution.safeParse({ id: 'x', order: 1, label: 'x', kind: 'item', extra: 1 }).success).toBe(false);
  });

  it('the guest shell keeps only the channel groups', () => {
    expect(visibleNav(CORE_NAV, { guest: true }).map((i) => i.id)).toEqual(['channels']);
    expect(visibleNav(CORE_NAV, { guest: false })).toHaveLength(7);
  });
});

describe('sidebar links and counts', () => {
  it('resolves paths against the team; ~/ is the team settings page', () => {
    const byId = Object.fromEntries(CORE_NAV.map((i) => [i.id, i]));
    expect(navHref(byId['files']!, 'engineering')).toBe('/t/engineering/files');
    expect(navHref(byId['bots']!, 'engineering')).toBe('/settings/team/engineering/roster');
    expect(navHref(byId['direct-messages']!, 'engineering')).toBeNull();
    expect(channelPath('engineering', '#dev')).toBe('/t/engineering/c/dev');
    expect(channelPath('engineering', 'dev')).toBe('/t/engineering/c/dev');
  });

  it('shows a count only when its source has more than zero', () => {
    const threads = CORE_NAV.find((i) => i.id === 'threads')!;
    expect(navCount(threads, {})).toBeNull();
    expect(navCount(threads, { 'threads.unread': 0 })).toBeNull();
    expect(navCount(threads, { 'threads.unread': 3 })).toBe(3);
    expect(navCount(CORE_NAV.find((i) => i.id === 'files')!, { 'threads.unread': 3 })).toBeNull();
  });
});

describe('team switching and titles', () => {
  it('keeps the section when switching teams and falls back to Threads for a channel or DM', () => {
    expect(teamSwitchPath('/t/engineering/files', 'support')).toBe('/t/support/files');
    expect(teamSwitchPath('/t/engineering/approvals', 'support')).toBe('/t/support/approvals');
    expect(teamSwitchPath('/t/engineering/c/dev', 'support')).toBe('/t/support/threads');
    expect(teamSwitchPath('/t/engineering/dm/abc', 'support')).toBe('/t/support/threads');
    expect(teamSwitchPath('/', 'support')).toBe('/t/support/threads');
  });

  it('names the view in the header', () => {
    expect(viewTitle('/t/engineering/c/dev')).toBe('# dev');
    expect(viewTitle('/t/engineering/threads')).toBe('Threads');
    expect(viewTitle('/t/engineering/files')).toBe('Files');
    expect(viewTitle('/t/engineering/dm/abc')).toBe('Direct message');
    expect(viewTitle('/')).toBe('Home');
  });
});
