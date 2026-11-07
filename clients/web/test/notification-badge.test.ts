import { describe, expect, it } from 'vitest';
import type { Notification as InboxItem } from '@manythreads/shared';
import { isActivityKind, mentionedChannelIds, splitUnread, type UnreadRow } from '../src/notifications/model';
import { NotificationStore } from '../src/notifications/store';

const row = (kind: UnreadRow['kind'], channelId = 'c1'): UnreadRow => ({ kind, channelId });

describe('the bell count is split in two (P21-10)', () => {
  it('only a message from a channel set to "all" is background activity', () => {
    expect(['mention', 'reply', 'dm', 'reminder'].some((k) => isActivityKind(k as UnreadRow['kind']))).toBe(false);
    expect(isActivityKind('message')).toBe(true);
  });

  it('takes the activity rows off the red number', () => {
    expect(splitUnread(5, [row('mention'), row('message'), row('message'), row('dm')])).toEqual({ attention: 3, activity: 2 });
    expect(splitUnread(2, [row('message'), row('message')])).toEqual({ attention: 0, activity: 2 });
    expect(splitUnread(0, [])).toEqual({ attention: 0, activity: 0 });
  });

  it('counts a row it has not seen as addressed to the person, and never goes below zero', () => {
    expect(splitUnread(4, [row('message')])).toEqual({ attention: 3, activity: 1 });
    // the list can be stale after a read elsewhere: more activity rows than the server's total
    expect(splitUnread(1, [row('message'), row('message'), row('message')])).toEqual({ attention: 0, activity: 1 });
  });

  it('lists a channel once for any number of unread mentions in it', () => {
    expect(mentionedChannelIds([row('mention', 'a'), row('mention', 'a'), row('reply', 'b'), row('mention', 'c')]).sort()).toEqual(['a', 'c']);
  });
});

// the push is parsed with the real schema, so ids must be real uuids: 'n1' becomes 00000000-0000-4000-8000-0000000000n1-style
const uuid = (tag: string): string => `00000000-0000-4000-8000-${tag.replace(/\D/g, '').padStart(12, '0')}`;
const note = (id: string, kind: InboxItem['kind'], channel = 'dev'): InboxItem =>
  ({ id: uuid(id), kind, refType: 'message', refId: uuid(`9${id}`), channelId: uuid(`5${channel.length}${channel.charCodeAt(0)}`), channelName: channel, channelKind: 'channel', threadRootId: null, actorId: uuid('77'), actorName: 'Nadia', preview: 'hi', keyword: null, readAt: null, createdAt: '2026-11-07T10:00:00.000Z' }) as unknown as InboxItem;
const chan = (name: string): string => note('1', 'mention', name).channelId;
const created = (n: InboxItem) => ({ type: 'notification.created', id: n.id, payload: { notification: n, browser: false } }) as never;
const readPush = (ids: string[], all: boolean, unreadCount: number) => ({ type: 'notification.read', id: 'r', payload: { ids: ids.map(uuid), all, unreadCount } }) as never;

describe('the store keeps the split as pushes arrive', () => {
  it('a mention raises the red number and marks its channel; a channel message only the activity', () => {
    const store = new NotificationStore();
    store.handlePush(created(note('n1', 'mention', 'dev')));
    store.handlePush(created(note('n2', 'message', 'general')));
    const s = store.snapshot();
    expect(s.unread).toBe(2);
    expect(s.activity).toBe(1);
    expect(s.mentionChannels).toEqual([chan('dev')]);
  });

  it('a reply that becomes a mention is one row, not two', () => {
    const store = new NotificationStore();
    store.handlePush(created(note('n1', 'reply', 'dev')));
    store.handlePush(created(note('n1', 'mention', 'dev')));
    const s = store.snapshot();
    expect(s.unread).toBe(1);
    expect(s.mentionChannels).toEqual([chan('dev')]);
  });

  it('a read in another tab takes the row off, and read-all clears both counts', () => {
    const store = new NotificationStore();
    store.handlePush(created(note('n1', 'mention', 'dev')));
    store.handlePush(created(note('n2', 'message', 'general')));
    store.handlePush(readPush(['n1'], false, 1));
    expect(store.snapshot()).toMatchObject({ unread: 1, activity: 1, mentionChannels: [] });
    store.handlePush(readPush([], true, 0));
    expect(store.snapshot()).toMatchObject({ unread: 0, activity: 0, mentionChannels: [] });
  });
});
