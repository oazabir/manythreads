import { describe, expect, it } from 'vitest';
import { NavContribution, sortNav } from '@manythreads/shared';
import { headerBackFor } from '../src/shell/headerBack';
import { meetingPath, meetingsPath } from '../src/shell/messageLink';
import { CORE_NAV, channelPath, navCount, navHref, teamSwitchPath, viewTitle, visibleNav } from '../src/shell/nav';

const contribution = (over: Partial<NavContribution> & Pick<NavContribution, 'id' | 'order'>): NavContribution =>
  NavContribution.parse({ label: over.id, kind: 'item', ...over });

describe('sidebar contract', () => {
  it('is exactly Chat, Schedule, Meetings, Files, Boards, Org chart, Jobs, Deliveries, Threads, Drafts, Approvals, channel groups, Direct messages, Projects, Bots, in that order', () => {
    const sorted = sortNav(CORE_NAV);
    expect(sorted.map((i) => [i.order, i.label])).toEqual([
      [5, 'Chat'], [8, 'Schedule'], [9, 'Meetings'], [10, 'Files'], [20, 'Boards'], [23, 'Org chart'], [26, 'Jobs'], [27, 'Deliveries'], [30, 'Threads'], [32, 'Drafts'],
      [35, 'Approvals'], [40, 'Channels'], [45, 'Direct messages'], [48, 'Projects'], [50, 'Bots'],
    ]);
    expect(sorted.map((i) => i.kind)).toEqual([...Array<string>(11).fill('item'), 'group-list', 'header', 'header', 'header']);
  });

  it('has Meetings as one plain entry that opens the Meetings page, and none for a guest', () => {
    const meetings = CORE_NAV.find((i) => i.id === 'meetings')!;
    expect(meetings.kind).toBe('item');
    expect(meetings.icon).toBe('meetings');
    expect(navHref(meetings, 'engineering')).toBe('/t/engineering/meetings');
    expect(visibleNav(CORE_NAV, { guest: true }).some((i) => i.id === 'meetings')).toBe(false);
  });

  it('gives the org chart and Jobs pages of their own, not tabs inside Boards', () => {
    const byId = Object.fromEntries(CORE_NAV.map((i) => [i.id, i]));
    expect(navHref(byId['org']!, 'engineering')).toBe('/t/engineering/org');
    expect(navHref(byId['jobs']!, 'engineering')).toBe('/t/engineering/jobs');
    expect(byId['org']!.icon).toBe('org');
    expect(byId['jobs']!.icon).toBe('jobs');
  });

  it('sorts a plugin contribution into place by order and keeps ties in the order given', () => {
    const plugin = contribution({ id: 'wiki', order: 25 });
    expect(sortNav([...CORE_NAV, plugin]).map((i) => i.id).slice(1, 7)).toEqual(['schedule', 'meetings', 'files', 'boards', 'org', 'wiki']);
    expect(sortNav([...CORE_NAV, plugin]).map((i) => i.id).slice(7, 9)).toEqual(['jobs', 'deliveries']);
    const a = contribution({ id: 'a', order: 5 });
    const b = contribution({ id: 'b', order: 5 });
    expect(sortNav([b, a]).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('entries not built yet carry product copy for their empty state (Files and Boards are built: they carry none)', () => {
    const copy = Object.fromEntries(CORE_NAV.map((i) => [i.id, i.emptyState]));
    expect(copy['files']).toBeUndefined();
    // Boards is a real screen now, so the sidebar must not subtitle it "No boards yet" beside a board that exists.
    expect(copy['boards']).toBeUndefined();
    // Approvals shows a count only while something waits; an empty row carries no subtitle
    expect(copy['approvals']).toBeUndefined();
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
    // Bookmarks has a button at the top right, not an entry here, so every entry shows
    expect(visibleNav(CORE_NAV, { guest: false })).toHaveLength(CORE_NAV.length);
    expect(CORE_NAV.some((i) => i.id === 'bookmarks')).toBe(false);
  });
});

describe('sidebar links and counts', () => {
  it('resolves paths against the team; ~/ is the team settings page', () => {
    const byId = Object.fromEntries(CORE_NAV.map((i) => [i.id, i]));
    expect(navHref(byId['files']!, 'engineering')).toBe('/t/engineering/files');
    expect(navHref(byId['bots']!, 'engineering')).toBe('/t/engineering/bots');
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

describe('meeting links', () => {
  it('a meeting space opens in the Meetings page; the page itself is the list', () => {
    expect(meetingsPath('eng')).toBe('/t/eng/meetings');
    expect(meetingPath('eng', 'abc')).toBe('/t/eng/meetings/space/abc');
  });
});

describe('team switching and titles', () => {
  it('keeps the section when switching teams and falls back to Threads for a channel or DM', () => {
    expect(teamSwitchPath('/t/engineering/files', 'support')).toBe('/t/support/files');
    expect(teamSwitchPath('/t/engineering/chat', 'support')).toBe('/t/support/chat');
    expect(teamSwitchPath('/t/engineering/approvals', 'support')).toBe('/t/support/approvals');
    expect(teamSwitchPath('/t/engineering/jobs', 'support')).toBe('/t/support/jobs');
    expect(teamSwitchPath('/t/engineering/dms', 'support')).toBe('/t/support/dms');
    expect(teamSwitchPath('/t/engineering/activity', 'support')).toBe('/t/support/activity');
    expect(teamSwitchPath('/t/engineering/org', 'support')).toBe('/t/support/org');
    // a meeting space is one team's own, so switching lands on the list of meetings
    expect(teamSwitchPath('/t/engineering/meetings/space/abc', 'support')).toBe('/t/support/meetings');
    expect(teamSwitchPath('/t/engineering/c/dev', 'support')).toBe('/t/support/threads');
    expect(teamSwitchPath('/t/engineering/dm/abc', 'support')).toBe('/t/support/threads');
    expect(teamSwitchPath('/', 'support')).toBe('/t/support/threads');
  });

  it('names the view in the header', () => {
    expect(viewTitle('/t/engineering/c/dev')).toBe('# dev');
    expect(viewTitle('/t/engineering/threads')).toBe('Threads');
    expect(viewTitle('/t/engineering/files')).toBe('Files');
    expect(viewTitle('/t/engineering/chat')).toBe('Chat');
    expect(viewTitle('/t/engineering/dm/abc')).toBe('Direct message');
    expect(viewTitle('/t/engineering/bots/brain/chat')).toBe('Conversation');
    expect(viewTitle('/t/engineering/bots/brain')).toBe('Bots');
    expect(viewTitle('/t/engineering/org')).toBe('Org chart');
    expect(viewTitle('/t/engineering/jobs')).toBe('Jobs');
    expect(viewTitle('/t/engineering/dms')).toBe('Messages');
    expect(viewTitle('/t/engineering/meetings')).toBe('Meetings');
    expect(viewTitle('/t/engineering/meetings/space/abc')).toBe('Meetings');
    expect(viewTitle('/t/engineering/activity')).toBe('Activity');
    expect(viewTitle('/')).toBe('Home');
    expect(viewTitle('/t/engineering/memory')).toBe('Memory');
    // a person's own Memory and Knowledge are outside any team; neither is called Home
    expect(viewTitle('/memory')).toBe('Memory');
    expect(viewTitle('/knowledge')).toBe('Knowledge');
    expect(viewTitle('/t/engineering/knowledge')).toBe('Knowledge');
    expect(teamSwitchPath('/t/engineering/knowledge', 'support')).toBe('/t/support/knowledge');
  });

  it('keeps the section when switching teams from a conversation with a bot', () => {
    expect(teamSwitchPath('/t/engineering/bots/brain/chat', 'support')).toBe('/t/support/bots');
  });

  it('the phone pages are top-level: their band is the title with no trail (P34-06)', () => {
    expect(headerBackFor('/t/eng/dms')).toBeNull();
    expect(headerBackFor('/t/eng/activity')).toBeNull();
    // the Meetings page and an open meeting space have no trail: the page has its own way back on a phone
    expect(headerBackFor('/t/eng/meetings')).toBeNull();
    expect(headerBackFor(meetingPath('eng', 'abc'))).toBeNull();
  });
});
