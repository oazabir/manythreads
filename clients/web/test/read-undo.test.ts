import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '@manythreads/shared';
import { dayAt, type ListItem } from '../src/channels/listItems';

const hoisted = vi.hoisted(() => ({
  unread: {} as Record<string, number>,
  lastRead: null as string | null,
  items: [] as { id: string; deletedAt: string | null }[],
  markUnread: vi.fn(async () => undefined),
}));

vi.mock('../src/channels/store', () => ({
  channelKey: (id: string) => `channel:${id}`,
  threadKey: (id: string) => `thread:${id}`,
  channelStore: {
    snapshot: () => ({ unread: hoisted.unread }),
    readState: () => (hoisted.lastRead === null ? null : { lastReadId: hoisted.lastRead }),
    get: () => ({ items: hoisted.items }),
    markUnread: hoisted.markUnread,
  },
}));
vi.mock('../src/api/endpoints', () => ({ fetchMessages: vi.fn(), fetchThreadInbox: vi.fn(), fetchUnreadSummary: vi.fn() }));

import { firstUnreadMessageId, undoMarkRead } from '../src/app/readAll';

const CH = 'c1';
describe('firstUnreadMessageId / undoMarkRead (P21-05)', () => {
  it('is null when nothing is unread', () => {
    hoisted.unread = { [CH]: 0 };
    hoisted.items = [{ id: 'm1', deletedAt: null }];
    expect(firstUnreadMessageId(CH)).toBeNull();
  });

  it('is the first message after the read position', () => {
    hoisted.unread = { [CH]: 2 };
    hoisted.lastRead = 'm2';
    hoisted.items = ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, deletedAt: null }));
    expect(firstUnreadMessageId(CH)).toBe('m3');
  });

  it('is the oldest held message when nothing was read yet, and skips deleted ones', () => {
    hoisted.unread = { [CH]: 3 };
    hoisted.lastRead = null;
    hoisted.items = [{ id: 'm1', deletedAt: '2026-01-01T00:00:00Z' }, { id: 'm2', deletedAt: null }];
    expect(firstUnreadMessageId(CH)).toBe('m2');
  });

  it('is null when the timeline is not held, so Undo is not offered', () => {
    hoisted.unread = { [CH]: 3 };
    hoisted.items = [];
    expect(firstUnreadMessageId(CH)).toBeNull();
  });

  it('undo marks unread from that message with no thread', async () => {
    await undoMarkRead(CH, 'm3');
    expect(hoisted.markUnread).toHaveBeenCalledWith(CH, 'm3', null);
  });
});

describe('dayAt (P21-05)', () => {
  const day = (label: string): ListItem => ({ kind: 'day', key: `d:${label}`, label });
  const m = (id: string): ListItem => ({ kind: 'message', key: `m:${id}`, message: { id } as ChannelMessage, continued: false });
  const items: ListItem[] = [day('Monday'), m('1'), m('2'), day('Today'), { kind: 'unread', key: 'unread' }, m('3')];

  it('finds the nearest day label at or above the row', () => {
    expect(dayAt(items, 0)).toBe('Monday');
    expect(dayAt(items, 2)).toBe('Monday');
    expect(dayAt(items, 3)).toBe('Today');
    expect(dayAt(items, 5)).toBe('Today');
  });

  it('clamps an index past the end, and is null without a day above', () => {
    expect(dayAt(items, 99)).toBe('Today');
    expect(dayAt([m('1')], 0)).toBeNull();
    expect(dayAt([], 0)).toBeNull();
  });
});
