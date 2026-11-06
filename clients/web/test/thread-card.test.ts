import { describe, expect, it } from 'vitest';
import { channelLabel, followEntry, markerLabel, repliesLine, withHandles } from '../src/screens/threadCard';

describe('the words of a Threads row', () => {
  it('names the place: a channel without its hash, a direct message, a bot conversation', () => {
    expect(channelLabel({ kind: 'channel', name: 'dev' })).toBe('dev');
    expect(channelLabel({ kind: 'channel', name: '#dev' })).toBe('dev');
    expect(channelLabel({ kind: 'dm', name: 'x' })).toBe('Direct message');
    expect(channelLabel({ kind: 'bot_conversation', name: 'x' })).toBe('Conversation with a bot');
  });

  it('counts new replies when there are some, all replies when there are none', () => {
    expect(repliesLine({ replyCount: 98, unreadCount: 0 })).toBe('98 replies');
    expect(repliesLine({ replyCount: 1, unreadCount: 0 })).toBe('1 reply');
    expect(repliesLine({ replyCount: 14, unreadCount: 14 })).toBe('14 new replies');
    expect(repliesLine({ replyCount: 5, unreadCount: 1 })).toBe('1 new reply');
  });

  it('describes the marker: tags first, then plain unread, else nothing', () => {
    expect(markerLabel({ unreadCount: 3, mentionCount: 1 })).toBe('1 unread reply names you');
    expect(markerLabel({ unreadCount: 3, mentionCount: 2 })).toBe('2 unread replies name you');
    expect(markerLabel({ unreadCount: 3, mentionCount: 0 })).toBe('Unread replies');
    expect(markerLabel({ unreadCount: 0, mentionCount: 0 })).toBeNull();
  });

  it('cuts @handles out of the text, leaving a closing full stop outside the handle', () => {
    expect(withHandles('@bhai we are going to integrate')).toEqual([{ text: '@bhai', handle: true }, { text: ' we are going to integrate', handle: false }]);
    expect(withHandles('ask @alamin.')).toEqual([{ text: 'ask ', handle: false }, { text: '@alamin', handle: true }, { text: '.', handle: false }]);
    expect(withHandles('mail a@b.com now')).toEqual([{ text: 'mail a@b.com now', handle: false }]);
    expect(withHandles('plain')).toEqual([{ text: 'plain', handle: false }]);
  });

  it('stays fast on hostile text', () => {
    const t = Date.now();
    withHandles(`${'@'.repeat(40_000)}${'@a'.repeat(20_000)}${'a.'.repeat(30_000)}`);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it('words the follow entry for both states', () => {
    expect(followEntry(true).label).toBe('Unfollow thread');
    expect(followEntry(false).label).toBe('Follow thread');
  });
});

import { dayOf, groupThreads, replySnippet } from '../src/screens/threadCard';

describe('day groups of the Threads list', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0);
  const at = (daysAgo: number): string => new Date(2026, 10, 6 - daysAgo, 9, 0, 0).toISOString();
  it('names the day by the reader clock', () => {
    expect(dayOf(at(0), now)).toBe('Today');
    expect(dayOf(at(1), now)).toBe('Yesterday');
    expect(dayOf(at(4), now)).toBe('This week');
    expect(dayOf(at(9), now)).toBe('Earlier');
  });
  it('keeps the order and starts a group when the day changes', () => {
    const g = groupThreads([{ lastReplyAt: at(0) }, { lastReplyAt: at(0) }, { lastReplyAt: at(1) }, { lastReplyAt: at(12) }], now);
    expect(g.map((x) => [x.day, x.items.length])).toEqual([['Today', 2], ['Yesterday', 1], ['Earlier', 1]]);
  });
  it('shows the newest reply as "Name: preview"', () => {
    expect(replySnippet({ lastReply: { authorName: 'Tester', preview: ' 213 passing ' } })).toBe('Tester: 213 passing');
    expect(replySnippet({ lastReply: null })).toBeNull();
  });
});

describe('day boundaries', () => {
  const now = new Date(2026, 10, 6, 0, 30, 0);
  it('puts just after midnight in Today and just before in Yesterday', () => {
    expect(dayOf(new Date(2026, 10, 6, 0, 0, 0).toISOString(), now)).toBe('Today');
    expect(dayOf(new Date(2026, 10, 5, 23, 59, 59).toISOString(), now)).toBe('Yesterday');
  });
  it('This week lasts through 6 days back; 7 days back is Earlier', () => {
    expect(dayOf(new Date(2026, 10, 2, 12).toISOString(), now)).toBe('This week');
    expect(dayOf(new Date(2026, 10, 0, 12).toISOString(), now)).toBe('This week');
    expect(dayOf(new Date(2026, 9, 30, 12).toISOString(), now)).toBe('Earlier');
  });
  it('treats a future time as Today and groups nothing as nothing', () => {
    expect(dayOf(new Date(2026, 10, 9).toISOString(), now)).toBe('Today');
    expect(groupThreads([], now)).toEqual([]);
  });
});
