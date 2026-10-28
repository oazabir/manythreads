import {
  HeartbeatResponse,
  ListPresenceCardsResponse,
  ListPresenceResponse,
  MyPresence,
  PRESENCE_TTL_SECONDS,
  localClock,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, lena } = personas;

// The clock the server reads (`ctx.runtime.now`): a test moves it forward to see a status clear itself or a return day arrive.
let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const HOUR = 3_600_000;

let w: World;
beforeAll(async () => {
  w = await createWorld({ now: clock });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const beat = (who: Persona, status?: string): Promise<ApiResult> => w.call(who, 'POST', '/api/presence', status ? { status } : {});
const present = async (who: Persona): Promise<string[]> =>
  ListPresenceResponse.parse(ok(await w.call(who, 'GET', '/api/presence'))).people.map((p) => p.personId).sort();
const cards = async (who: Persona) => ListPresenceCardsResponse.parse(ok(await w.call(who, 'GET', '/api/presence/people'))).people;
const cardOf = async (who: Persona, of: Persona) => (await cards(who)).find((c) => c.personId === of.personId);
const mine = async (who: Persona): Promise<MyPresence> => MyPresence.parse(ok(await w.call(who, 'GET', '/api/presence/me')));
const patch = (who: Persona, body: unknown): Promise<ApiResult> => w.call(who, 'PATCH', '/api/presence/me', body);

describe('the heartbeat (UNLOGGED table, every 30 s, offline after 90 s)', () => {
  it('a heartbeat marks the person online until it ages out; the status can change', async () => {
    const first = HeartbeatResponse.parse(ok(await beat(nadia)));
    expect(first.status).toBe('online');
    expect(Date.parse(first.expiresAt) - Date.parse(first.seenAt)).toBe(PRESENCE_TTL_SECONDS * 1000);
    ok(await beat(rafi, 'away'));
    expect(await present(omar)).toEqual([nadia.personId, rafi.personId].sort());
    const list = ListPresenceResponse.parse(ok(await w.call(omar, 'GET', '/api/presence')));
    expect(list.people.find((p) => p.personId === rafi.personId)?.status).toBe('away');
    expect(HeartbeatResponse.parse(ok(await beat(rafi))).status).toBe('online');
    // One row per person however often they beat.
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.presence WHERE person_id = $1', [rafi.personId])).rows.length)).toBe(1);
  });

  it('a heartbeat older than 90 seconds is offline (the expiry filter, no reaper needed)', async () => {
    await w.system((tx) => tx.query("UPDATE app.presence SET seen_at = now() - interval '91 seconds' WHERE person_id = $1", [rafi.personId]));
    expect(await present(omar)).toEqual([nadia.personId]);
    await w.system((tx) => tx.query("UPDATE app.presence SET seen_at = now() - interval '89 seconds' WHERE person_id = $1", [rafi.personId]));
    expect(await present(omar)).toEqual([nadia.personId, rafi.personId].sort());
  });

  it('a guest sees only themself; members see the guest', async () => {
    ok(await beat(lena));
    expect(await present(lena)).toEqual([lena.personId]);
    expect(await present(nadia)).toContain(lena.personId);
  });

  it('rejects a bad status or body and a request without sign-in', async () => {
    expect((await beat(nadia, 'busy')).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/presence', { status: 'online', other: 1 })).status).toBe(400);
    expect((await w.call(null, 'POST', '/api/presence', {})).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/presence')).status).toBe(401);
  });
});

describe('cards: the heartbeat and the status together', () => {
  it('a person who is online and has no status has a card with presence only; one who is away shows as away', async () => {
    ok(await beat(nadia));
    ok(await beat(rafi, 'away'));
    expect(await cardOf(omar, nadia)).toMatchObject({ presence: 'online', status: null, timeZone: null, workingHours: null, outOfOffice: null });
    expect(await cardOf(omar, rafi)).toMatchObject({ presence: 'away' });
  });

  it('a person with nothing to show and no heartbeat is not listed; one with a status and no heartbeat is offline', async () => {
    expect(await cardOf(omar, sameera)).toBeUndefined();
    ok(await patch(sameera, { status: { emoji: '🌴', text: 'On leave', clearsAt: null } }));
    expect(await cardOf(omar, sameera)).toMatchObject({ presence: 'offline', seenAt: null, status: { emoji: '🌴', text: 'On leave' } });
  });

  it('a guest sees only their own card; members see the guest', async () => {
    ok(await beat(lena));
    ok(await patch(lena, { status: { emoji: null, text: 'Reviewing', clearsAt: null } }));
    expect((await cards(lena)).map((c) => c.personId)).toEqual([lena.personId]);
    expect((await cardOf(nadia, lena))?.status?.text).toBe('Reviewing');
  });

  it('rejects a request without sign-in', async () => {
    expect((await w.call(null, 'GET', '/api/presence/people')).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/presence/me')).status).toBe(401);
    expect((await w.call(null, 'PATCH', '/api/presence/me', {})).status).toBe(401);
    expect((await w.call(null, 'PUT', '/api/presence/dnd', {})).status).toBe(401);
  });
});

describe('custom status', () => {
  it('is set, shown to the others, replaced, and cleared with null', async () => {
    const res = MyPresence.parse(ok(await patch(rafi, { status: { emoji: '🎧', text: ' Heads down ', clearsAt: null } })));
    expect(res.status).toEqual({ emoji: '🎧', text: 'Heads down', clearsAt: null });
    expect((await cardOf(omar, rafi))?.status).toEqual({ emoji: '🎧', text: 'Heads down', clearsAt: null });
    ok(await patch(rafi, { status: { emoji: null, text: 'In a meeting', clearsAt: null } }));
    expect((await mine(rafi)).status).toEqual({ emoji: null, text: 'In a meeting', clearsAt: null });
    ok(await patch(rafi, { status: null }));
    expect((await mine(rafi)).status).toBeNull();
    expect((await cardOf(omar, rafi))?.status).toBeNull();
  });

  it('is gone once its clear time has passed, with no job deleting it', async () => {
    const clearsAt = new Date(clock().getTime() + HOUR).toISOString();
    ok(await patch(nadia, { status: { emoji: '🍽️', text: 'Lunch', clearsAt } }));
    expect((await cardOf(omar, nadia))?.status?.text).toBe('Lunch');
    expect((await mine(nadia)).status?.clearsAt).toBe(clearsAt);
    skewMs = HOUR + 60_000;
    try {
      expect((await cardOf(omar, nadia))?.status).toBeNull();
      expect((await mine(nadia)).status).toBeNull();
      // The row is still there: readers drop the status, nothing deleted it.
      const stored = await w.system(async (tx) => (await tx.query<{ status_text: string }>('SELECT status_text FROM app.person_status WHERE person_id = $1', [nadia.personId])).rows[0]?.status_text);
      expect(stored).toBe('Lunch');
    } finally {
      skewMs = 0;
    }
  });

  it('refuses a clear time in the past, an empty status, a long text, and anything the form does not have', async () => {
    const past = new Date(clock().getTime() - 1000).toISOString();
    expect((await patch(rafi, { status: { emoji: '🎧', text: 'x', clearsAt: past } })).status).toBe(400);
    expect((await patch(rafi, { status: { emoji: null, text: '   ', clearsAt: null } })).status).toBe(400);
    expect((await patch(rafi, { status: { emoji: null, text: 'x'.repeat(101), clearsAt: null } })).status).toBe(400);
    expect((await patch(rafi, { status: { emoji: '🎧', text: 'x', clearsAt: null, extra: 1 } })).status).toBe(400);
    expect((await patch(rafi, { personId: nadia.personId })).status).toBe(400);
  });
});

describe('time zone and working hours', () => {
  const hours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

  it('are saved together and shown on the card', async () => {
    const res = MyPresence.parse(ok(await patch(nadia, { timeZone: 'Asia/Karachi', workingHours: hours })));
    expect(res.timeZone).toBe('Asia/Karachi');
    expect(res.workingHours).toEqual(hours);
    expect(await cardOf(omar, nadia)).toMatchObject({ timeZone: 'Asia/Karachi', workingHours: hours });
  });

  it('refuse working hours with no time zone, an unknown zone, hours that end before they start, and a repeated day', async () => {
    expect((await patch(rafi, { workingHours: hours })).status).toBe(400);
    expect((await patch(rafi, { timeZone: 'Mars/Olympus' })).status).toBe(400);
    ok(await patch(rafi, { timeZone: 'Europe/Berlin' }));
    expect((await patch(rafi, { workingHours: { ...hours, start: '18:00' } })).status).toBe(400);
    expect((await patch(rafi, { workingHours: { ...hours, days: [1, 1] } })).status).toBe(400);
    expect((await patch(rafi, { workingHours: { ...hours, start: '9am' } })).status).toBe(400);
  });

  it('are cleared with null', async () => {
    ok(await patch(rafi, { workingHours: hours }));
    const res = MyPresence.parse(ok(await patch(rafi, { workingHours: null, timeZone: null })));
    expect([res.workingHours, res.timeZone]).toEqual([null, null]);
  });
});

describe('out of office', () => {
  const day = (offset: number): string => new Date(clock().getTime() + offset * 24 * HOUR).toISOString().slice(0, 10);

  it('is saved with a return day and a delegate, shown to the others, and read back whole', async () => {
    const note = { active: true, returnsOn: day(3), delegatePersonId: nadia.personId, message: 'Back on Monday, ask Nadia' };
    const res = MyPresence.parse(ok(await patch(sameera, { outOfOffice: note })));
    expect(res.outOfOffice).toEqual(note);
    expect((await cardOf(omar, sameera))?.outOfOffice).toEqual(note);
  });

  it('ends on its own when the return day arrives', async () => {
    skewMs = 4 * 24 * HOUR;
    try {
      expect((await cardOf(omar, sameera))?.outOfOffice).toBeNull();
      expect((await mine(sameera)).outOfOffice).toBeNull();
    } finally {
      skewMs = 0;
    }
  });

  it('is turned off with null or active false, which also forgets the delegate', async () => {
    ok(await patch(sameera, { outOfOffice: { active: true, returnsOn: null, delegatePersonId: rafi.personId, message: '' } }));
    ok(await patch(sameera, { outOfOffice: { active: false, returnsOn: day(5), delegatePersonId: rafi.personId, message: 'x' } }));
    expect((await mine(sameera)).outOfOffice).toBeNull();
    const row = await w.system(async (tx) => (await tx.query<{ ooo_delegate_id: string | null }>('SELECT ooo_delegate_id FROM app.person_status WHERE person_id = $1', [sameera.personId])).rows[0]);
    expect(row?.ooo_delegate_id).toBeNull();
  });

  it('refuses a return day that is not after today, yourself as delegate, and someone who is not on the workspace', async () => {
    const note = { active: true, returnsOn: null, delegatePersonId: null, message: '' };
    expect((await patch(sameera, { outOfOffice: { ...note, returnsOn: day(0) } })).status).toBe(400);
    expect((await patch(sameera, { outOfOffice: { ...note, returnsOn: day(-2) } })).status).toBe(400);
    expect((await patch(sameera, { outOfOffice: { ...note, delegatePersonId: sameera.personId } })).status).toBe(400);
    expect((await patch(sameera, { outOfOffice: { ...note, delegatePersonId: '00000000-0000-7000-8000-00000000ffff' } })).status).toBe(400);
    expect((await patch(sameera, { outOfOffice: { ...note, returnsOn: 'next week' } })).status).toBe(400);
  });
});

describe('Do not disturb', () => {
  it('starts off, is switched on by hand and off again', async () => {
    const start = await mine(omar);
    expect(start.dnd).toEqual({ enabled: false, pausedUntil: null, schedule: { enabled: false, windows: [] } });
    expect(start.dndState).toEqual({ active: false, reason: null, until: null });
    const on = MyPresence.parse(ok(await w.call(omar, 'PUT', '/api/presence/dnd', { enabled: true })));
    expect(on.dndState).toEqual({ active: true, reason: 'manual', until: null });
    const off = MyPresence.parse(ok(await w.call(omar, 'PUT', '/api/presence/dnd', { enabled: false })));
    expect(off.dndState.active).toBe(false);
  });

  it('pauses for an hour and ends the pause', async () => {
    const res = MyPresence.parse(ok(await w.call(omar, 'PUT', '/api/presence/dnd', { pauseMinutes: 60 })));
    expect(res.dndState).toMatchObject({ active: true, reason: 'paused' });
    expect(Date.parse(res.dndState.until!) - clock().getTime()).toBeGreaterThan(59 * 60_000);
    expect(Date.parse(res.dndState.until!) - clock().getTime()).toBeLessThanOrEqual(HOUR);
    skewMs = HOUR + 1000;
    try {
      expect((await mine(omar)).dndState.active).toBe(false);
    } finally {
      skewMs = 0;
    }
    expect(MyPresence.parse(ok(await w.call(omar, 'PUT', '/api/presence/dnd', { pauseMinutes: null }))).dndState.active).toBe(false);
  });

  it('follows a weekly schedule in the time zone on the profile', async () => {
    // A window that contains "now" where Kiritimati (UTC+14) is, and one that does not contain it in New York.
    const tz = 'Pacific/Kiritimati';
    ok(await patch(omar, { timeZone: tz }));
    const { minutes } = localClock(clock(), tz);
    const at = (m: number): string => {
      const n = (m + 1440) % 1440;
      return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    };
    const schedule = { enabled: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: at(minutes - 30), end: at(minutes + 30) }] };
    const res = MyPresence.parse(ok(await w.call(omar, 'PUT', '/api/presence/dnd', { schedule })));
    expect(res.dndState).toMatchObject({ active: true, reason: 'schedule' });
    expect(Date.parse(res.dndState.until!) - clock().getTime()).toBeLessThanOrEqual(31 * 60_000);
    // The same wall-clock window is not running for someone whose clock is 12 hours behind.
    ok(await patch(omar, { timeZone: 'Pacific/Pago_Pago' }));
    expect((await mine(omar)).dndState.active).toBe(false);
    ok(await w.call(omar, 'PUT', '/api/presence/dnd', { schedule: { enabled: false, windows: [] } }));
    ok(await patch(omar, { timeZone: null }));
  });

  it('refuses a malformed schedule or pause and a field the form does not have', async () => {
    const put = (body: unknown): Promise<ApiResult> => w.call(omar, 'PUT', '/api/presence/dnd', body);
    expect((await put({ schedule: { enabled: true, windows: [{ days: [], start: '22:00', end: '07:00' }] } })).status).toBe(400);
    expect((await put({ schedule: { enabled: true, windows: [{ days: [1], start: '22:00', end: '22:00' }] } })).status).toBe(400);
    expect((await put({ schedule: { enabled: true, windows: [{ days: [7], start: '22:00', end: '07:00' }] } })).status).toBe(400);
    expect((await put({ pauseMinutes: 0 })).status).toBe(400);
    expect((await put({ pauseMinutes: 60 * 24 * 8 })).status).toBe(400);
    expect((await put({ personId: nadia.personId })).status).toBe(400);
  });

  it('is private: another person never sees it, and a card does not carry it', async () => {
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: true }));
    const card = await cardOf(omar, rafi);
    expect(JSON.stringify(card ?? {})).not.toMatch(/dnd|pausedUntil|schedule/i);
    expect(JSON.stringify((await mine(nadia)).dnd)).not.toContain('true');
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: false }));
  });
});
