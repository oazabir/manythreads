import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaterItem } from '@manythreads/shared';

// P14-04: the pieces of "Later" that are not on screen: the times "Remind me" offers (worked out in the person's own zone), the check of a custom
// time, how a due time reads, and the client's copy of the open items.

const api = vi.hoisted(() => ({
  fetchLater: vi.fn(),
  saveLater: vi.fn(),
  setLaterState: vi.fn(),
  removeLater: vi.fn(),
}));
vi.mock('../src/api/endpoints', () => api);

import { ApiError } from '../src/api/client';
import { customTimeError, fromLocalInput, presetTime, remindWhen, toLocalInput } from '../src/later/times';
import { LaterStore } from '../src/later/store';

// Local-time dates throughout: the code under test works in the zone of the machine, so these tests hold in any zone.
const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('the times Remind me offers', () => {
  const now = local(2026, 11, 4, 14, 30);                         // a Wednesday
  it('in 20 minutes and in 1 hour count from now', () => {
    expect(presetTime('in20', now).getTime() - now.getTime()).toBe(20 * 60_000);
    expect(presetTime('in60', now).getTime() - now.getTime()).toBe(60 * 60_000);
  });
  it('tomorrow morning is 9:00 the next day, also late at night', () => {
    expect(presetTime('tomorrow', now)).toEqual(local(2026, 11, 5, 9));
    expect(presetTime('tomorrow', local(2026, 11, 4, 23, 59))).toEqual(local(2026, 11, 5, 9));
    expect(presetTime('tomorrow', local(2026, 12, 31, 8))).toEqual(local(2027, 1, 1, 9));
  });
  it('next week is 9:00 next Monday, and never today', () => {
    expect(presetTime('nextweek', now)).toEqual(local(2026, 11, 9, 9));                  // Wednesday -> Monday 9
    expect(presetTime('nextweek', local(2026, 11, 8, 10))).toEqual(local(2026, 11, 9, 9)); // Sunday -> tomorrow
    expect(presetTime('nextweek', local(2026, 11, 9, 8))).toEqual(local(2026, 11, 16, 9)); // Monday -> the Monday after
  });
});

describe('a custom time', () => {
  it('goes to the field and back', () => {
    expect(toLocalInput(local(2026, 3, 5, 7, 4))).toBe('2026-03-05T07:04');
    expect(fromLocalInput('2026-03-05T07:04')).toEqual(local(2026, 3, 5, 7, 4));
  });
  it('is refused when empty, malformed or a day that does not exist', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(fromLocalInput('2026-02-31T10:00')).toBeNull();
  });
  it('is checked against the same window as the server', () => {
    const now = local(2026, 11, 4, 12);
    expect(customTimeError('', now)).toBe('Choose a day and a time.');
    expect(customTimeError('2026-11-04T11:00', now)).toBe('That time has already passed. Choose a later one.');
    expect(customTimeError('2026-11-04T12:30', now)).toBeNull();
    expect(customTimeError('2027-12-01T12:00', now)).toBe('Reminders can be set at most a year ahead.');
  });
});

describe('how a due time reads', () => {
  const now = local(2026, 11, 4, 10);
  it('says today, tomorrow, or the day', () => {
    expect(remindWhen(local(2026, 11, 4, 14, 5).toISOString(), now)).toBe('Today at 14:05');
    expect(remindWhen(local(2026, 11, 5, 9).toISOString(), now)).toBe('Tomorrow at 09:00');
    expect(remindWhen(local(2026, 11, 13, 9).toISOString(), now)).toMatch(/ at 09:00$/);
    expect(remindWhen(local(2026, 11, 13, 9).toISOString(), now)).not.toMatch(/^(Today|Tomorrow)/);
  });
});

const item = (over: Record<string, unknown> = {}): LaterItem =>
  ({ id: 'i1', messageId: 'm1', state: 'open', remindAt: null, due: false, createdAt: '2026-11-04T10:00:00.000Z', doneAt: null, message: null, ...over }) as LaterItem;

describe('the client copy of the open items', () => {
  let store: LaterStore;
  beforeEach(() => {
    vi.clearAllMocks();
    store = new LaterStore();
  });

  it('loads once, shares a request in flight, and loads again only when forced', async () => {
    api.fetchLater.mockResolvedValue({ items: [item()], openCount: 1, dueCount: 0 });
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(api.fetchLater).toHaveBeenCalledTimes(1);
    expect(store.snapshot()).toMatchObject({ supported: true, loaded: true, openCount: 1 });
    expect(store.itemFor('m1')?.id).toBe('i1');
    await store.load(true);
    expect(api.fetchLater).toHaveBeenCalledTimes(2);
  });

  it('a server without reminders (404) turns the actions off, and is not asked again', async () => {
    api.fetchLater.mockRejectedValue(new ApiError({ code: 'not_found', message: 'not found', status: 404 }));
    await store.load();
    expect(store.snapshot()).toMatchObject({ supported: false, loaded: true });
    await store.load(true);
    expect(api.fetchLater).toHaveBeenCalledTimes(1);
  });

  it('a save shows at once, due items first; done and removed items leave the open copy', async () => {
    api.fetchLater.mockResolvedValue({ items: [], openCount: 0, dueCount: 0 });
    await store.load();
    api.saveLater.mockResolvedValueOnce(item({ id: 'a', messageId: 'ma' }));
    api.saveLater.mockResolvedValueOnce(item({ id: 'b', messageId: 'mb', due: true, remindAt: '2026-11-04T09:00:00.000Z' }));
    await store.save('ma');
    await store.save('mb', '2026-11-04T09:00:00.000Z');
    expect(store.snapshot().items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(store.snapshot()).toMatchObject({ openCount: 2, dueCount: 1 });
    api.setLaterState.mockResolvedValue(item({ id: 'b', messageId: 'mb', state: 'done', doneAt: '2026-11-04T10:00:00.000Z' }));
    await store.setState('b', 'done');
    expect(store.snapshot()).toMatchObject({ openCount: 1, dueCount: 0 });
    api.removeLater.mockResolvedValue({ ok: true });
    await store.remove('a');
    expect(store.snapshot().items).toEqual([]);
  });

  it('a refused save rejects with the server sentence and changes nothing', async () => {
    api.saveLater.mockRejectedValue(new Error('You already have 200 saved items. Finish or remove some first.'));
    await expect(store.save('ma')).rejects.toThrow('200 saved items');
    expect(store.snapshot().items).toEqual([]);
  });

  it('reset empties the copy and tells its listeners', async () => {
    api.fetchLater.mockResolvedValue({ items: [item()], openCount: 1, dueCount: 0 });
    await store.load();
    const seen = vi.fn();
    store.subscribe(seen);
    store.reset();
    expect(seen).toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({ loaded: false, items: [] });
  });
});
