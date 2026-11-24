import { describe, expect, it } from 'vitest';
import type { ChannelMessage, DirectMessageSummary } from '@manythreads/shared';
import { scrollEdges } from '../src/channels/composerTools';
import { rowBar } from '../src/channels/rowBar';
import { dmListRow, listTime, withMessageChange } from '../src/dms/listRow';
import { headerItems, HEADER_TOOL_ORDER, orderItems, putHeaderItem, type HeaderMenuEntry } from '../src/shell/headerMenu';
import { headerRoom } from '../src/shell/headerRoom';

// P34-05: the phone frame. The header's room on a phone, the header tools as items of the details menu, the hover bar under a finger, the format bar's edge,
// and the Messages page as a chat app's list (its rows and how a message that arrives changes them).

// ids are branded strings: a fixture id fits any of them
const uuid = (n: number): never => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as never;

describe('the header on a phone', () => {
  it('is the phone room at the phone width whatever its own width, and the measured rooms elsewhere as before', () => {
    expect(headerRoom(390, true)).toBe('phone');
    expect(headerRoom(null, true)).toBe('phone');
    expect(headerRoom(1200)).toBe('bar');
    expect(headerRoom(700)).toBe('icons');
    expect(headerRoom(400)).toBe('tight');
    expect(headerRoom(null)).toBe('bar');
  });
});

describe('the header tools in the details menu', () => {
  const entry = (key: HeaderMenuEntry['key'], label: string = key): HeaderMenuEntry => ({ key, label, testId: `details-${key}`, run: () => undefined });

  it('lists the items of a channel in the header order, whatever order the tools drew in', () => {
    const ch = uuid(1);
    const offs = [putHeaderItem(ch, entry('link')), putHeaderItem(ch, entry('members')), putHeaderItem(ch, entry('search')), putHeaderItem(ch, entry('voice'))];
    expect(headerItems(ch).map((e) => e.key)).toEqual(['search', 'voice', 'members', 'link']);
    offs.forEach((off) => off());
    expect(headerItems(ch)).toEqual([]);
    expect(orderItems([entry('planned'), entry('search')]).map((e) => e.key)).toEqual(['search', 'planned']);
    expect(HEADER_TOOL_ORDER).toEqual(['search', 'planned', 'voice', 'members', 'link']);
  });

  it('keeps the channels apart, and a newer copy of a tool is not taken out by the older one going away', () => {
    const a = uuid(2);
    const b = uuid(3);
    const old = putHeaderItem(a, entry('members', 'Members'));
    putHeaderItem(b, entry('search'));
    const fresh = putHeaderItem(a, entry('members', 'Members (6)'));
    old();
    expect(headerItems(a).map((e) => e.label)).toEqual(['Members (6)']);
    expect(headerItems(b).map((e) => e.key)).toEqual(['search']);
    fresh();
    expect(headerItems(a)).toEqual([]);
  });

  it('gives the same list back while nothing changed (the menu does not draw again)', () => {
    const ch = uuid(4);
    const off = putHeaderItem(ch, entry('voice'));
    expect(headerItems(ch)).toBe(headerItems(ch));
    off();
  });
});

describe('the hover bar', () => {
  const base = { coarse: false, hot: false, tapped: false, menuOpen: false, deleted: false };
  it('shows with a mouse while the row is hovered, focused or tapped, or a menu of it is open', () => {
    expect(rowBar(base)).toBe('none');
    expect(rowBar({ ...base, hot: true })).toBe('bar');
    expect(rowBar({ ...base, tapped: true })).toBe('bar');
    expect(rowBar({ ...base, menuOpen: true })).toBe('bar');
  });
  it('never shows under a finger: a held finger draws only the menu it opened', () => {
    expect(rowBar({ ...base, coarse: true, hot: true })).toBe('none');
    expect(rowBar({ ...base, coarse: true, tapped: true })).toBe('none');
    expect(rowBar({ ...base, coarse: true, menuOpen: true })).toBe('menu');
  });
  it('draws nothing on a deleted message', () => {
    expect(rowBar({ ...base, hot: true, deleted: true })).toBe('none');
    expect(rowBar({ ...base, coarse: true, menuOpen: true, deleted: true })).toBe('none');
  });
});

describe("the phone format bar's edges", () => {
  it('says which end has more tools beyond it', () => {
    expect(scrollEdges(0, 300, 300)).toBe('none');
    expect(scrollEdges(0, 300, 300.5)).toBe('none');
    expect(scrollEdges(0, 300, 600)).toBe('end');
    expect(scrollEdges(150, 300, 600)).toBe('both');
    expect(scrollEdges(300, 300, 600)).toBe('start');
  });
});

const SELF = uuid(10);
const SELF_ACTOR = uuid(11);
const NADIA = uuid(12);
const NADIA_ACTOR = uuid(13);
const RAFI = uuid(14);

function dm(n: number, over: Partial<DirectMessageSummary> = {}, people: { personId: string; displayName: string }[] = [{ personId: SELF, displayName: 'Omar Haddad' }, { personId: NADIA, displayName: 'Nadia Karim' }]): DirectMessageSummary {
  return {
    channel: { id: uuid(500 + n), workspaceId: uuid(900), teamId: null, groupId: null, name: `dm-${n}`, kind: 'dm', private: true, purpose: '', dmKey: `k${n}`, botId: null, position: 0, archivedAt: null, createdAt: '2026-11-01T08:00:00.000Z' },
    participants: people,
    lastMessage: null,
    unreadCount: 0,
    ...over,
  } as DirectMessageSummary;
}

function msg(n: number, channelId: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(700 + n),
    workspaceId: uuid(900),
    channelId,
    authorId: NADIA_ACTOR,
    body: `**message** ${n}`,
    bodyPlain: `message ${n}`,
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt: `2026-11-20T10:${String(10 + n).padStart(2, '0')}:00.000Z`,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as ChannelMessage;
}

describe('the Messages list rows', () => {
  const now = new Date(2026, 10, 20, 15, 0);
  const at = (d: number, h: number, m = 0): string => new Date(2026, 10, d, h, m).toISOString();

  it('times the last message as a chat app does: the clock today, then Yesterday, the weekday, the date', () => {
    expect(listTime(at(20, 9, 5), now)).toBe('09:05');
    expect(listTime(at(19, 23), now)).toBe('Yesterday');
    expect(listTime(at(16, 12), now)).toBe('Mon');
    expect(listTime(at(3, 12), now)).toBe('3 Nov');
    expect(listTime(new Date(2025, 10, 3, 12).toISOString(), now)).toBe('3 Nov 2025');
  });

  it('draws the other person, the last line, the time and the live unread count', () => {
    const d = dm(1, { lastMessage: { id: uuid(1), authorId: NADIA_ACTOR, preview: 'Are you free\nfor five minutes?', createdAt: at(20, 14, 30) }, unreadCount: 2 });
    const row = dmListRow(d, { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, nameOf: () => 'Nadia Karim', now });
    expect(row).toMatchObject({ label: 'Nadia Karim', peerId: NADIA, kind: 'person', preview: 'Are you free for five minutes?', time: '14:30', unread: 2 });
    expect(row.timeTitle).toContain('14:30');
    expect(dmListRow(d, { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, unread: 5, nameOf: () => null, now }).unread).toBe(5);
    expect(dmListRow(d, { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, unread: 0, nameOf: () => null, now }).unread).toBe(0);
  });

  it('says "You:" before the reader\'s own last line, and in a group the author\'s first name', () => {
    const mine = dm(2, { lastMessage: { id: uuid(2), authorId: SELF_ACTOR, preview: 'On my way', createdAt: at(20, 14) } });
    expect(dmListRow(mine, { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, nameOf: () => null, now }).preview).toBe('You: On my way');
    const group = dm(3, { lastMessage: { id: uuid(3), authorId: NADIA_ACTOR, preview: 'Lunch?', createdAt: at(20, 12) } }, [
      { personId: SELF, displayName: 'Omar Haddad' },
      { personId: NADIA, displayName: 'Nadia Karim' },
      { personId: RAFI, displayName: 'Rafi Aziz' },
    ]);
    const row = dmListRow(group, { label: 'Nadia Karim, Rafi Aziz', selfPersonId: SELF, selfActor: SELF_ACTOR, nameOf: (a) => (a === NADIA_ACTOR ? 'Nadia Karim' : null), now });
    expect(row).toMatchObject({ kind: 'group', peerId: null, preview: 'Nadia: Lunch?' });
  });

  it('has no line and no time before anything was said, and names a message with no text', () => {
    const empty = dmListRow(dm(4), { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, nameOf: () => null, now });
    expect(empty).toMatchObject({ preview: '', time: null, timeTitle: null });
    const file = dm(5, { lastMessage: { id: uuid(5), authorId: NADIA_ACTOR, preview: '  ', createdAt: at(20, 12) } });
    expect(dmListRow(file, { label: 'Nadia Karim', selfPersonId: SELF, selfActor: SELF_ACTOR, nameOf: () => null, now }).preview).toBe('Sent an attachment');
  });
});

describe('a message that arrives while the Messages list is open', () => {
  const a = dm(1, { lastMessage: { id: uuid(701), authorId: NADIA_ACTOR, preview: 'message 1', createdAt: '2026-11-20T10:11:00.000Z' } });
  const b = dm(2, { lastMessage: { id: uuid(702), authorId: NADIA_ACTOR, preview: 'message 2', createdAt: '2026-11-20T10:12:00.000Z' } });
  const list = [b, a];

  it('becomes the last line of its conversation and moves it to the top, in plain text cut at 140 characters', () => {
    const m = msg(5, a.channel.id, { bodyPlain: 'x'.repeat(200) });
    const next = withMessageChange(list, { type: 'posted', message: m });
    expect(next.refetch).toBe(false);
    expect(next.items.map((d) => d.channel.id)).toEqual([a.channel.id, b.channel.id]);
    expect(next.items[0]!.lastMessage).toEqual({ id: m.id, authorId: NADIA_ACTOR, preview: 'x'.repeat(140), createdAt: m.createdAt });
  });

  it('leaves the list alone for a thread reply, another channel, an older message or the same message twice', () => {
    expect(withMessageChange(list, { type: 'posted', message: msg(6, a.channel.id, { threadRootId: uuid(701) }) }).items).toBe(list);
    expect(withMessageChange(list, { type: 'posted', message: msg(6, uuid(999)) }).items).toBe(list);
    expect(withMessageChange(list, { type: 'posted', message: msg(0, a.channel.id, { createdAt: '2026-11-20T09:00:00.000Z' }) }).items).toBe(list);
    expect(withMessageChange(list, { type: 'posted', message: msg(1, a.channel.id, { bodyPlain: 'message 1' }) }).items).toBe(list);
  });

  it('changes the last line when that message is edited, and asks for the list again when it is deleted', () => {
    const edited = withMessageChange(list, { type: 'edited', message: msg(1, a.channel.id, { bodyPlain: 'message 1, fixed' }) });
    expect(edited.items[1]!.lastMessage?.preview).toBe('message 1, fixed');
    expect(edited.items.map((d) => d.channel.id)).toEqual([b.channel.id, a.channel.id]);
    expect(withMessageChange(list, { type: 'edited', message: msg(9, a.channel.id) }).items).toBe(list);
    expect(withMessageChange(list, { type: 'deleted', channelId: a.channel.id, messageId: uuid(701), threadRootId: null }).refetch).toBe(true);
    expect(withMessageChange(list, { type: 'deleted', channelId: a.channel.id, messageId: uuid(799), threadRootId: null }).refetch).toBe(false);
  });
});
