import { enqueue } from '@manythreads/kernel';
import { GetNotificationSummaryResponse, ListNotificationsResponse, localClock, type Notification } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { nadia, rafi, priya, lena } = personas;

// P14-01: while a person has Do not disturb on, what would notify them is still written, but held: not listed, not counted, no live push, no
// event. When Do not disturb ends (turned off, a pause runs out, a schedule closes) it is delivered, whole and in order, once.

// The clock the server reads (`ctx.runtime.now`): a test moves it forward to let a pause run out.
let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const MINUTE = 60_000;

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld({ now: clock });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const dm = async (from: Persona, to: Persona): Promise<string> => {
  const res = await w.call<{ dm: { channel: { id: string } } }>(from, 'POST', '/api/dms', { personIds: [to.personId] });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.dm.channel.id;
};
const inbox = async (who: Persona): Promise<Notification[]> => ListNotificationsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications'))).items;
const unread = async (who: Persona): Promise<number> => GetNotificationSummaryResponse.parse(ok(await w.call(who, 'GET', '/api/notifications/summary'))).unreadCount;
const dnd = (who: Persona, body: unknown): Promise<ApiResult> => w.call(who, 'PUT', '/api/presence/dnd', body);
const rows = async (who: Persona, messageId: string): Promise<Array<{ held: boolean; created_at: Date }>> =>
  w.system(async (tx) =>
    (await tx.query<{ held: boolean; created_at: Date }>('SELECT held_at IS NOT NULL AS held, created_at FROM app.notifications WHERE person_id = $1 AND ref_id = $2', [who.personId, messageId])).rows,
  );
const created = async (who: Persona): Promise<number> =>
  w.system(async (tx) =>
    (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'notifications.notification.created' AND payload->>'personId' = $1", [who.personId])).rows[0]!.n,
  );
/** Runs the release job once and waits for it to finish (the cron would do it within a minute). */
const release = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'notifications.release_held', {})).id);
  await eventually(async () => ((await w.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id])).rows[0]?.state)) === 'done' ? true : undefined), 20_000, 'the release job');
};

describe('Do not disturb switched on by hand', () => {
  it('holds a direct message: written, but not listed, counted, announced or lost; delivered when it is switched off', async () => {
    const eventsBefore = await created(rafi);
    ok(await dnd(rafi, { enabled: true }));
    const channel = await dm(nadia, rafi);
    const a = await post(nadia, channel, 'first, while you were away');
    const b = await post(nadia, channel, 'second, @rafi');
    await drained(w);
    // written and held
    expect((await rows(rafi, a))[0]?.held).toBe(true);
    expect((await rows(rafi, b))[0]?.held).toBe(true);
    // invisible to him: no list, no count, no event for them
    expect(await inbox(rafi)).toEqual([]);
    expect(await unread(rafi)).toBe(0);
    expect(await created(rafi)).toBe(eventsBefore);
    // nobody else's notifications are held by it
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.notifications WHERE person_id = $1 AND held_at IS NOT NULL', [nadia.personId])).rows.length)).toBe(0);

    const arrived = (await rows(rafi, a))[0]!.created_at;
    ok(await dnd(rafi, { enabled: false }));
    await eventually(async () => ((await unread(rafi)) === 2 ? true : undefined), 20_000, 'the held notifications to arrive');
    await drained(w);
    const items = await inbox(rafi);
    expect(items.map((n) => n.preview).sort()).toEqual(['first, while you were away', 'second, @rafi']);
    expect(items.find((n) => n.refId === b)?.kind).toBe('mention');          // the stronger kind survived the hold
    expect((await rows(rafi, a))[0]).toMatchObject({ held: false });
    expect((await rows(rafi, a))[0]!.created_at).toEqual(arrived);            // the time the message arrived, not the time it was released
    expect(await created(rafi)).toBe(eventsBefore + 2);                        // announced now, once each
  });

  it('turning it off twice, or when nothing is held, delivers nothing twice', async () => {
    const before = await created(rafi);
    ok(await dnd(rafi, { enabled: false }));
    await drained(w);
    expect(await created(rafi)).toBe(before);
    expect(await unread(rafi)).toBe(2);
  });

  it('a person marks nothing read while it is held, and the held row is not theirs to update', async () => {
    ok(await dnd(priya, { enabled: true }));
    const id = await post(nadia, dev, 'ping @priya');
    await drained(w);
    expect((await rows(priya, id))[0]?.held).toBe(true);
    expect(ok(await w.call<{ updated: number }>(priya, 'POST', '/api/notifications/mark-read', { all: true })).updated).toBe(0);
    ok(await dnd(priya, { enabled: false }));
    await eventually(async () => ((await unread(priya)) === 1 ? true : undefined), 20_000, 'the mention to arrive');
  });
});

describe('Do not disturb for an hour', () => {
  it('releases when the pause has run out and the release job runs, not before', async () => {
    ok(await dnd(rafi, { pauseMinutes: 60 }));
    const before = await unread(rafi);
    const id = await post(nadia, dev, 'late news for @rafi');
    await drained(w);
    expect((await rows(rafi, id))[0]?.held).toBe(true);
    await release();
    expect((await rows(rafi, id))[0]?.held).toBe(true);                        // still within the hour
    expect(await unread(rafi)).toBe(before);
    skewMs = 61 * MINUTE;
    try {
      await release();
      expect((await rows(rafi, id))[0]?.held).toBe(false);
      expect(await unread(rafi)).toBe(before + 1);
    } finally {
      skewMs = 0;
    }
  });

  it('ending the pause early releases at once', async () => {
    ok(await dnd(rafi, { pauseMinutes: 60 }));
    const id = await post(nadia, dev, 'another for @rafi');
    await drained(w);
    expect((await rows(rafi, id))[0]?.held).toBe(true);
    ok(await dnd(rafi, { pauseMinutes: null }));
    await eventually(async () => ((await rows(rafi, id))[0]?.held === false ? true : undefined), 20_000, 'release after the pause ended');
  });
});

describe('Do not disturb on a weekly schedule', () => {
  const at = (m: number): string => {
    const n = (m + 1440) % 1440;
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };

  it('is read in the person\'s own time zone: held where the window is running, delivered where it is not', async () => {
    // The same wall-clock window (now - 30 min to now + 30 min on Kiritimati's clock) is running for Priya (Kiritimati) and not for Nadia
    // (Pago Pago, 26 hours behind), so one message is held for one of them and delivered to the other.
    const kiritimati = 'Pacific/Kiritimati';
    const { minutes } = localClock(clock(), kiritimati);
    const schedule = { enabled: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: at(minutes - 30), end: at(minutes + 30) }] };
    ok(await w.call(priya, 'PATCH', '/api/presence/me', { timeZone: kiritimati }));
    ok(await w.call(nadia, 'PATCH', '/api/presence/me', { timeZone: 'Pacific/Pago_Pago' }));
    ok(await dnd(priya, { schedule }));
    ok(await dnd(nadia, { schedule }));
    const id = await post(personas.omar, dev, 'attention @priya and @nadia');
    await drained(w);
    expect((await rows(priya, id))[0]?.held).toBe(true);
    expect((await rows(nadia, id))[0]?.held).toBe(false);
    expect((await inbox(nadia)).some((n) => n.refId === id)).toBe(true);
    expect((await inbox(priya)).some((n) => n.refId === id)).toBe(false);

    // Priya's window closes: moving her to a zone where it is not running ends it, and the change delivers what was held.
    ok(await w.call(priya, 'PATCH', '/api/presence/me', { timeZone: 'Pacific/Pago_Pago' }));
    await eventually(async () => ((await rows(priya, id))[0]?.held === false ? true : undefined), 20_000, 'release after the zone change');
    expect((await inbox(priya)).some((n) => n.refId === id)).toBe(true);
  });

  it('a window that has simply ended by the clock is released by the job', async () => {
    const tz = 'UTC';
    ok(await w.call(rafi, 'PATCH', '/api/presence/me', { timeZone: tz }));
    const { minutes } = localClock(clock(), tz);
    ok(await dnd(rafi, { schedule: { enabled: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: at(minutes - 5), end: at(minutes + 20) }] } }));
    const id = await post(nadia, dev, 'the schedule ends soon for @rafi');
    await drained(w);
    expect((await rows(rafi, id))[0]?.held).toBe(true);
    skewMs = 30 * MINUTE;
    try {
      await release();
      expect((await rows(rafi, id))[0]?.held).toBe(false);
    } finally {
      skewMs = 0;
    }
    ok(await dnd(rafi, { schedule: { enabled: false, windows: [] } }));
  });
});

describe('what Do not disturb does not touch', () => {
  it('someone without it is told at once, and a guest of other channels is told nothing', async () => {
    const id = await post(nadia, dev, 'hello @lena and @rafi');
    await drained(w);
    expect((await rows(rafi, id))[0]?.held).toBe(false);
    expect(await inbox(lena)).toEqual([]);                                     // a guest of other channels: never told
  });
});
