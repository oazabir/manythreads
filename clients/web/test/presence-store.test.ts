import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyPresence, PresenceCard } from '@manythreads/shared';

// P14-01c: the presence store's rounds -- when the cards count as known, what a failure does, that only the newest round (and only for the person
// who is signed in) is applied, and that a hidden tab sends only the beat.

const api = vi.hoisted(() => ({
  sendHeartbeat: vi.fn(),
  fetchPresenceCards: vi.fn(),
  fetchMyPresence: vi.fn(),
  saveMyPresence: vi.fn(),
  saveDnd: vi.fn(),
}));
vi.mock('../src/api/endpoints', () => api);
vi.mock('../src/app/caches', () => ({ onPersonChange: () => undefined }));

import { ApiError } from '../src/api/client';
import { ABSENT_RETRY_MS, PresenceStore, STALE_AFTER_FAILS, cardsAreLive } from '../src/presence/store';

const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const card = (id: string, presence: PresenceCard['presence'] = 'online'): PresenceCard =>
  ({ personId: id, presence, seenAt: null, status: null, timeZone: null, workingHours: null, outOfOffice: null }) as PresenceCard;
const mine = (): MyPresence =>
  ({ status: null, timeZone: null, workingHours: null, outOfOffice: null, dnd: { enabled: false, pausedUntil: null, schedule: { enabled: false, windows: [] } }, dndState: { active: false, reason: null, until: null } }) as MyPresence;
const httpError = (status: number): ApiError => new ApiError({ status, code: status === 404 ? 'not_found' : 'internal', message: 'x' });
const deferred = <T>() => {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  api.sendHeartbeat.mockResolvedValue({});
  api.fetchMyPresence.mockResolvedValue(mine());
});
afterEach(() => vi.useRealTimers());

describe('when the cards count as known', () => {
  it('an absent card is "not known" until a list has arrived, and a failed list never counts as an answer', async () => {
    const store = new PresenceStore();
    expect(cardsAreLive(store.snapshot())).toBe(false);
    api.fetchPresenceCards.mockRejectedValue(httpError(500));
    await store.tick('online');
    expect(store.snapshot().cardsLoaded).toBe(false);
    expect(cardsAreLive(store.snapshot())).toBe(false);
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    await store.tick('online');
    expect(store.snapshot()).toMatchObject({ cardsLoaded: true, failedTicks: 0 });
    expect(cardsAreLive(store.snapshot())).toBe(true);
  });

  it('after three failed rounds the old cards stay but are no longer live; one good round brings them back', async () => {
    const store = new PresenceStore();
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    await store.tick('online');
    api.fetchPresenceCards.mockRejectedValue(httpError(500));
    for (let i = 1; i < STALE_AFTER_FAILS; i += 1) {
      await store.tick('online');
      expect(cardsAreLive(store.snapshot())).toBe(true);
    }
    await store.tick('online');
    expect(store.snapshot().cards.get(A)).toBeDefined();
    expect(cardsAreLive(store.snapshot())).toBe(false);
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    await store.tick('online');
    expect(cardsAreLive(store.snapshot())).toBe(true);
  });
});

describe('a refusal or a missing plugin', () => {
  it('a 403 does not switch presence off for good: the next round asks again', async () => {
    const store = new PresenceStore();
    api.fetchPresenceCards.mockRejectedValueOnce(httpError(403));
    await store.tick('online');
    expect(store.snapshot().meStatus).not.toBe('absent');
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    await store.tick('online');
    expect(store.snapshot()).toMatchObject({ supported: true, cardsLoaded: true });
  });

  it('a 404 means no plugin: nothing is asked for a few minutes, then once more', async () => {
    vi.useFakeTimers();
    const store = new PresenceStore();
    api.sendHeartbeat.mockRejectedValue(httpError(404));
    await store.tick('online');
    expect(store.snapshot()).toMatchObject({ supported: false, meStatus: 'absent' });
    await store.tick('online');
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ABSENT_RETRY_MS + 1);
    api.sendHeartbeat.mockResolvedValue({});
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    await store.tick('online');
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(store.snapshot()).toMatchObject({ supported: true, meStatus: 'ready', cardsLoaded: true });
  });
});

describe('which answers are applied', () => {
  it('an answer that arrives after reset (another person signed in) is dropped', async () => {
    const store = new PresenceStore();
    const slow = deferred<{ people: PresenceCard[] }>();
    api.fetchPresenceCards.mockReturnValueOnce(slow.promise);
    const running = store.tick('online');
    await Promise.resolve();
    store.reset();
    slow.resolve({ people: [card(A)] });
    await running;
    expect(store.snapshot().cardsLoaded).toBe(false);
    expect(store.snapshot().cards.size).toBe(0);
  });

  it('an own-settings read that arrives after reset is dropped too', async () => {
    const store = new PresenceStore();
    const slow = deferred<MyPresence>();
    api.fetchMyPresence.mockReturnValueOnce(slow.promise);
    const reading = store.loadMe();
    store.reset();
    slow.resolve(mine());
    await reading;
    expect(store.snapshot().me).toBeNull();
    expect(store.snapshot().meStatus).toBe('idle');
  });

  it('when two rounds overlap, the older answer never replaces the newer one', async () => {
    const store = new PresenceStore();
    const first = deferred<{ people: PresenceCard[] }>();
    const second = deferred<{ people: PresenceCard[] }>();
    api.fetchPresenceCards.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = store.tick('online');
    await Promise.resolve();
    const two = store.tick('online');
    await Promise.resolve();
    second.resolve({ people: [card(A, 'away')] });
    await two;
    first.resolve({ people: [card(A, 'online')] }); // the older round answers last
    await one;
    expect(store.snapshot().cards.get(A)?.presence).toBe('away');
  });
});

describe('what a round sends', () => {
  it('a hidden tab sends only the beat; a tab that must stay quiet (another tab is in use) sends no beat but still reads', async () => {
    const store = new PresenceStore();
    await store.tick('away', true);
    expect(api.sendHeartbeat).toHaveBeenCalledWith('away');
    expect(api.fetchPresenceCards).not.toHaveBeenCalled();
    expect(api.fetchMyPresence).not.toHaveBeenCalled();
    api.fetchPresenceCards.mockResolvedValue({ people: [card(B)] });
    vi.mocked(api.sendHeartbeat).mockClear();
    await store.tick(null);
    expect(api.sendHeartbeat).not.toHaveBeenCalled();
    expect(store.snapshot().cards.get(B)).toBeDefined();
  });
});

describe('the shared heartbeat loop (shell, settings pages and account page each hold it)', () => {
  it('starts once for the first holder, whoever else holds it, and stops when the last lets go', async () => {
    vi.useFakeTimers();
    api.fetchPresenceCards.mockResolvedValue({ people: [card(A)] });
    const store = new PresenceStore();
    const releaseShell = store.acquire(() => 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(1);
    // a second screen mounts while the first is still there (the router swaps them): no second loop, no extra beat
    const releaseSettings = store.acquire(() => 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(2); // one loop: one beat per 30 s, not two
    releaseShell();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(3); // the settings page still holds it
    releaseSettings();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(3); // nobody holds it: it stopped
  });

  it('releasing twice does not stop a loop another screen still holds, and a later screen starts it again', async () => {
    vi.useFakeTimers();
    api.fetchPresenceCards.mockResolvedValue({ people: [] });
    const store = new PresenceStore();
    const first = store.acquire(() => 'online');
    const second = store.acquire(() => 'online');
    first();
    first();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(2);
    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(2);
    const third = store.acquire(() => 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(3);
    third();
  });
});
