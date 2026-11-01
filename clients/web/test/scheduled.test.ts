import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledMessage } from '@manythreads/shared';

// P14-05: the pieces of "Send later" that are not on screen: the check of a custom send time, the one-line snippet in the strip, and the client's copy
// of the person's scheduled messages.

const api = vi.hoisted(() => ({
  fetchScheduled: vi.fn(),
  fetchAllScheduled: vi.fn(),
  scheduleMessage: vi.fn(),
  editScheduled: vi.fn(),
  cancelScheduled: vi.fn(),
}));
vi.mock('../src/api/endpoints', () => api);

import { ApiError } from '../src/api/client';
import { sendTimeError } from '../src/channels/SendLater';
import { snippetOf } from '../src/channels/ScheduledStrip';
import { ALL_SCHEDULED, ScheduledStore, scheduledErrorText } from '../src/channels/scheduled';
import { toLocalInput } from '../src/later/times';

const item = (id: string, sendAt: string, over: Partial<Record<keyof ScheduledMessage, unknown>> = {}): ScheduledMessage =>
    ({
    id,
    channelId: 'c1',
    threadRootId: null,
    body: `text ${id}`,
    sendAt,
    state: 'scheduled',
    refusedReason: null,
    refusedAt: null,
    createdAt: '2030-01-01T00:00:00.000Z',
  ...over,
  }) as ScheduledMessage;

describe('sendTimeError', () => {
  const now = new Date(2030, 0, 1, 12, 0, 0);
  it('asks for a time when the box is empty', () => {
    expect(sendTimeError('', now)).toMatch(/choose a day/i);
  });
  it('refuses a time in the past and accepts a later one', () => {
    expect(sendTimeError(toLocalInput(new Date(2030, 0, 1, 9, 0)), now)).not.toBeNull();
    expect(sendTimeError(toLocalInput(new Date(2030, 0, 2, 9, 0)), now)).toBeNull();
  });
});

describe('snippetOf', () => {
  it('takes the first line that has text and clips a long one', () => {
    expect(snippetOf('\n\n  hello there \nsecond')).toBe('hello there');
    expect(snippetOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('ScheduledStore', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it('keeps a channel list in time order and shows a new one at once', async () => {
    api.fetchScheduled.mockResolvedValue({ items: [item('b', '2030-01-03T00:00:00.000Z'), item('a', '2030-01-02T00:00:00.000Z')] });
    const store = new ScheduledStore();
    await store.load('c1');
    expect(store.get('c1').items.map((i) => i.id)).toEqual(['a', 'b']);
    api.scheduleMessage.mockResolvedValue(item('z', '2030-01-01T10:00:00.000Z'));
    await store.schedule('c1', 'hi', new Date('2030-01-01T10:00:00.000Z'), null);
    expect(store.get('c1').items.map((i) => i.id)).toEqual(['z', 'a', 'b']);
    expect(api.scheduleMessage).toHaveBeenCalledWith('c1', { body: 'hi', sendAt: '2030-01-01T10:00:00.000Z' });
  });

  it('sends the thread root only when there is one', async () => {
    const store = new ScheduledStore();
    api.scheduleMessage.mockResolvedValue(item('t', '2030-01-01T10:00:00.000Z', { threadRootId: 'r1' }));
    await store.schedule('c1', 'in thread', new Date('2030-01-01T10:00:00.000Z'), 'r1');
    expect(api.scheduleMessage).toHaveBeenCalledWith('c1', { body: 'in thread', sendAt: '2030-01-01T10:00:00.000Z', threadRootId: 'r1' });
  });

  it('replaces an edited message and drops a cancelled one', async () => {
    api.fetchScheduled.mockResolvedValue({ items: [item('a', '2030-01-02T00:00:00.000Z')] });
    const store = new ScheduledStore();
    await store.load('c1');
    api.editScheduled.mockResolvedValue(item('a', '2030-01-05T00:00:00.000Z', { body: 'new' }));
    await store.edit(store.get('c1').items[0]!, { body: 'new', sendAt: new Date('2030-01-05T00:00:00.000Z') });
    expect(store.get('c1').items[0]?.body).toBe('new');
    api.cancelScheduled.mockResolvedValue({ cancelled: true });
    await store.cancel(store.get('c1').items[0]!);
    expect(store.get('c1').items).toEqual([]);
  });

  it('a forced read asked for while one is out reads again when it ends, so the newer answer wins', async () => {
    let first: (v: { items: ScheduledMessage[] }) => void = () => {};
    api.fetchScheduled.mockImplementationOnce(() => new Promise((r) => (first = r)));
    api.fetchScheduled.mockResolvedValueOnce({ items: [item('new', '2030-01-02T00:00:00.000Z')] });
    const store = new ScheduledStore();
    const one = store.load('c1');
    const again = store.load('c1', true);
    expect(api.fetchScheduled).toHaveBeenCalledTimes(1);
    first({ items: [item('old', '2030-01-02T00:00:00.000Z')] });
    await Promise.all([one, again]);
    expect(api.fetchScheduled).toHaveBeenCalledTimes(2);
    expect(store.get('c1').items.map((i) => i.id)).toEqual(['new']);
  });

  it('an unforced read while one is out does not read twice', async () => {
    let first: (v: { items: ScheduledMessage[] }) => void = () => {};
    api.fetchScheduled.mockImplementationOnce(() => new Promise((r) => (first = r)));
    const store = new ScheduledStore();
    const one = store.load('c1');
    const two = store.load('c1');
    first({ items: [] });
    await Promise.all([one, two]);
    expect(api.fetchScheduled).toHaveBeenCalledTimes(1);
  });

  it('the list of every channel is read from its own route and follows a cancel', async () => {
    const refused = item('r', '2030-01-02T00:00:00.000Z', { state: 'refused', refusedReason: 'You can no longer post in this channel.', refusedAt: '2030-01-02T00:01:00.000Z' });
    api.fetchAllScheduled.mockResolvedValue({ items: [refused] });
    const store = new ScheduledStore();
    await store.load(ALL_SCHEDULED);
    expect(api.fetchScheduled).not.toHaveBeenCalled();
    expect(store.get(ALL_SCHEDULED).items.map((i) => i.id)).toEqual(['r']);
    api.cancelScheduled.mockResolvedValue({ cancelled: true });
    await store.cancel(refused);
    expect(store.get(ALL_SCHEDULED).items).toEqual([]);
  });

  it('shows nothing when the server has no such feature', async () => {
    api.fetchScheduled.mockRejectedValue(new ApiError({ code: 'not_found', message: 'not found', status: 404 }));
    const store = new ScheduledStore();
    await store.load('c1');
    expect(store.get('c1')).toEqual({ status: 'off', items: [] });
  });
});

describe('scheduledErrorText', () => {
  it('passes on the server sentence without the field name, and hides a server fault', () => {
    expect(scheduledErrorText(new ApiError({ code: 'validation_failed', message: 'sendAt: Pick a time in the future.', status: 400 }))).toBe('Pick a time in the future.');
    expect(scheduledErrorText(new ApiError({ code: 'internal', message: 'boom', status: 500 }))).toBe('Could not save that. Try again.');
  });
});
