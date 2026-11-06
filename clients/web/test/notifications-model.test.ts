import { describe, expect, it } from 'vitest';
import type { Notification } from '@manythreads/shared';
import { forTab, groupByDay } from '../src/notifications/model';

const n = (id: string, createdAt: string, readAt: string | null): Notification => ({ id, createdAt, readAt }) as unknown as Notification;
const now = new Date(2026, 10, 6, 12, 0, 0);

describe('bell model', () => {
  const items = [n('1', new Date(2026, 10, 6, 9).toISOString(), null), n('2', new Date(2026, 10, 5, 9).toISOString(), 'x'), n('3', new Date(2026, 10, 5, 8).toISOString(), null), n('4', new Date(2026, 9, 1).toISOString(), null)];
  it('Unread keeps unread items', () => {
    expect(forTab(items, 'unread').map((i) => i.id)).toEqual(['1', '3', '4']);
    expect(forTab(items, 'all')).toHaveLength(4);
  });
  it('groups by day in order', () => {
    expect(groupByDay(items, now).map((g) => [g.day, g.items.length])).toEqual([['Today', 1], ['Yesterday', 2], ['Earlier', 1]]);
    expect(groupByDay([], now)).toEqual([]);
  });
});
