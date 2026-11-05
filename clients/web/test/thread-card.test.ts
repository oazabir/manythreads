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
