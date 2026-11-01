import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPreview } from '@manythreads/shared';

// P14-08: the client's copy of the cards under messages. Rows ask, the asks of one moment leave as one request per channel, a push asks again for a
// message a row still shows, and removing a card is shown at once and undone when the server refuses.

const api = vi.hoisted(() => ({ fetchLinkPreviews: vi.fn(), removeLinkPreview: vi.fn() }));
vi.mock('../src/api/endpoints', () => api);

import { ApiError } from '../src/api/client';
import { LinkPreviewStore, OFF_MS, PENDING_HOLD_MS } from '../src/linkpreview/store';

const CH = '00000000-0000-7000-8000-0000000000c1';
const CH2 = '00000000-0000-7000-8000-0000000000c2';
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const card = (n: number, messageId: string, channelId = CH): LinkPreview => ({
  id: id(1000 + n),
  channelId: channelId as LinkPreview['channelId'],
  messageId: messageId as LinkPreview['messageId'],
  url: `https://a.example/${n}`,
  host: 'a.example',
  title: `Title ${n}`,
  description: null,
  siteName: null,
  hasImage: false,
  canRemove: true,
  createdAt: '2026-11-01T10:00:00.000Z',
});

/** What the server answers: the cards, the messages a card may still come for, and whether it reads links at all. */
const answer = (items: LinkPreview[], pending: string[] = [], enabled = true) => ({ items, pending, enabled });

beforeEach(() => {
  vi.useFakeTimers();
  api.fetchLinkPreviews.mockReset();
  api.removeLinkPreview.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LinkPreviewStore', () => {
  it('holds room for a card from the first ask until the answer', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([card(1, id(1))]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: true });
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1)).pending).toBe(false);
    expect(store.cardsOf(id(1)).cards.map((c) => c.title)).toEqual(['Title 1']);
  });

  it('keeps room for a message the server says a card is on its way for, and gives it back after a while', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([], [id(1)]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: true });
    await vi.advanceTimersByTimeAsync(PENDING_HOLD_MS - 100);
    expect(store.cardsOf(id(1)).pending).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: false });
  });

  it('replaces the held room with the card when a push brings it', async () => {
    api.fetchLinkPreviews.mockResolvedValueOnce(answer([], [id(1)])).mockResolvedValueOnce(answer([card(1, id(1))]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    store.handlePush({ type: 'link-preview.changed', payload: { channelId: CH, messageId: id(1) } } as never);
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1)).pending).toBe(false);
    expect(store.cardsOf(id(1)).cards).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PENDING_HOLD_MS + 100); // the old hold timer does not take the card away
    expect(store.cardsOf(id(1)).cards).toHaveLength(1);
  });

  it('holds no room and stops asking for a while when the server says it reads no links', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([], [], false));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: false });
    store.want(CH, id(2));
    expect(store.cardsOf(id(2))).toEqual({ cards: [], pending: false }); // not even the room while an answer would be on its way
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OFF_MS + 100);
    store.want(CH, id(3));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(2);
  });

  it('answers a message without cards with an empty list, not with room', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: false });
  });

  it('sends the asks of one moment as one request per channel', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    store.want(CH, id(2));
    store.want(CH2, id(3));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(2);
    expect(api.fetchLinkPreviews).toHaveBeenCalledWith(CH, [id(1), id(2)]);
    expect(api.fetchLinkPreviews).toHaveBeenCalledWith(CH2, [id(3)]);
  });

  it('splits more than 100 messages into requests of 100', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    for (let i = 1; i <= 230; i += 1) store.want(CH, id(i));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([100, 100, 30]);
  });

  it('does not ask again for a message it already has while a row shows it', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    store.want(CH, id(1)); // the thread panel shows the same message
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(1);
  });

  it('asks again when a row shows a message that no row showed in between', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    const release = store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    release();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(2);
    expect(store.cardsOf(id(1)).pending).toBe(false); // the old answer stays on screen meanwhile
  });

  it('asks again on a push for a shown message, and ignores one for a message nobody shows', async () => {
    api.fetchLinkPreviews.mockResolvedValueOnce(answer([])).mockResolvedValueOnce(answer([card(1, id(1))]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    store.handlePush({ type: 'link-preview.changed', payload: { channelId: CH, messageId: id(1) } } as never);
    store.handlePush({ type: 'link-preview.changed', payload: { channelId: CH, messageId: id(9) } } as never);
    store.handlePush({ type: 'link-preview.changed', payload: { nonsense: true } } as never);
    store.handlePush({ type: 'something.else', payload: { channelId: CH, messageId: id(1) } } as never);
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(2);
    expect(store.cardsOf(id(1)).cards).toHaveLength(1);
  });

  it('stops asking once the server has no such plugin (404), and keeps asking after another failure', async () => {
    api.fetchLinkPreviews.mockRejectedValueOnce(new ApiError({ code: 'not_found', status: 404, message: 'no' }));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    expect(store.cardsOf(id(1))).toEqual({ cards: [], pending: false });
    store.want(CH, id(2));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(1);

    api.fetchLinkPreviews.mockReset();
    api.fetchLinkPreviews.mockRejectedValueOnce(new ApiError({ code: 'network', status: 0, message: 'down' })).mockResolvedValue(answer([]));
    const other = new LinkPreviewStore();
    other.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    other.want(CH, id(2));
    await vi.advanceTimersByTimeAsync(60);
    expect(api.fetchLinkPreviews).toHaveBeenCalledTimes(2);
  });

  it('removes a card at once and puts it back when the server refuses', async () => {
    const c = card(1, id(1));
    api.fetchLinkPreviews.mockResolvedValue(answer([c]));
    const store = new LinkPreviewStore();
    store.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);

    let finish: (v: unknown) => void = () => undefined;
    api.removeLinkPreview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const done = store.remove(c);
    expect(store.cardsOf(id(1)).cards).toEqual([]);
    finish({ removed: true });
    await done;
    expect(api.removeLinkPreview).toHaveBeenCalledWith(CH, id(1), c.id);
    expect(store.cardsOf(id(1)).cards).toEqual([]);

    const again = new LinkPreviewStore();
    again.want(CH, id(1));
    await vi.advanceTimersByTimeAsync(60);
    api.removeLinkPreview.mockRejectedValueOnce(new ApiError({ code: 'forbidden', status: 403, message: 'Only the author of a message can remove its previews.' }));
    await expect(again.remove(c)).rejects.toThrow('Only the author');
    expect(again.cardsOf(id(1)).cards).toHaveLength(1);
  });

  it('tells the listeners of a message, and only that message', async () => {
    api.fetchLinkPreviews.mockResolvedValue(answer([]));
    const store = new LinkPreviewStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(id(1), a);
    store.subscribe(id(2), b);
    store.want(CH, id(1));
    expect(a).toHaveBeenCalledTimes(1); // room held
    expect(b).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).not.toHaveBeenCalled();
  });
});
