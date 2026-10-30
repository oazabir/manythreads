import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateDndRequest, UpdateMyPresenceRequest, dndState, type DndSettings, type MyPresence } from '@manythreads/shared';

// P14-01b: the rules behind the Do not disturb screen -- pauses and their ends, the words for the paused state, the weekly schedule as rows, a
// status, the time zone and hours -- and the client's copy of the person's own settings (an old read must not undo a newer save).

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
import { clearsAtFor } from '../src/presence/format';
import {
  DEFAULT_QUIET,
  HELD_NOTE,
  HOLD_REQUEST,
  MAX_PAUSE_MINUTES,
  RESUME_REQUEST,
  bellLabel,
  clearsText,
  customPause,
  defaultRows,
  dndBanner,
  fitsRows,
  hoursDraftOf,
  minutesUntil,
  pauseEnd,
  pauseRequest,
  profileRequest,
  rowsOf,
  runsOvernight,
  sameRows,
  scheduleProblem,
  scheduleRequest,
  statusDraftOf,
  statusRequest,
  timeZoneChoices,
  untilText,
  windowsOf,
} from '../src/presence/settingsModel';
import { PresenceStore } from '../src/presence/store';

// Local-time dates throughout: the code under test reads the device's clock, so these tests hold in any zone.
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date => new Date(y, mo - 1, d, h, mi, s, 0);
const now = local(2026, 11, 4, 14, 30); // a Wednesday
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const toInput = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${hhmm(d)}`;

describe('pauses', () => {
  it('30 minutes and 1 hour count from now', () => {
    expect(pauseEnd('30m', now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(pauseEnd('1h', now).getTime() - now.getTime()).toBe(60 * 60_000);
  });
  it('until tomorrow morning is 9:00 the next day, also just before midnight and across a year end', () => {
    expect(pauseEnd('tomorrow', now)).toEqual(local(2026, 11, 5, 9));
    expect(pauseEnd('tomorrow', local(2026, 11, 4, 23, 59))).toEqual(local(2026, 11, 5, 9));
    expect(pauseEnd('tomorrow', local(2026, 12, 31, 8))).toEqual(local(2027, 1, 1, 9));
  });
  it('minutes are rounded up so a pause never ends early, and are at least one', () => {
    expect(minutesUntil(new Date(now.getTime() + 61_000), now)).toBe(2);
    expect(minutesUntil(new Date(now.getTime() + 60_000), now)).toBe(1);
    expect(minutesUntil(new Date(now.getTime() + 1_000), now)).toBe(1);
    expect(minutesUntil(now, now)).toBe(1);
  });
  it('a ready-made pause turns a hand-set Do not disturb off and sends only minutes the server accepts', () => {
    expect(pauseRequest('30m', now)).toEqual({ enabled: false, pauseMinutes: 30 });
    expect(pauseRequest('1h', now)).toEqual({ enabled: false, pauseMinutes: 60 });
    expect(pauseRequest('tomorrow', now)).toEqual({ enabled: false, pauseMinutes: 18 * 60 + 30 });
    for (const r of [pauseRequest('30m', now), pauseRequest('tomorrow', now), HOLD_REQUEST, RESUME_REQUEST]) expect(UpdateDndRequest.safeParse(r).success).toBe(true);
    expect(HOLD_REQUEST).toEqual({ enabled: true, pauseMinutes: null });
    expect(RESUME_REQUEST).toEqual({ enabled: false, pauseMinutes: null });
  });
  it('a custom end must be a real day and time in the future, within 7 days', () => {
    expect(customPause('', now)).toEqual({ ok: false, problem: 'Choose a day and a time.' });
    expect(customPause('2026-02-31T10:00', now)).toMatchObject({ ok: false });
    expect(customPause(toInput(local(2026, 11, 4, 14, 0)), now)).toEqual({ ok: false, problem: 'That time has already passed. Choose a later one.' });
    expect(customPause(toInput(now), now)).toMatchObject({ ok: false });
    expect(customPause(toInput(local(2026, 11, 20, 9)), now)).toEqual({ ok: false, problem: 'A pause can last at most 7 days.' });
    const ok = customPause(toInput(local(2026, 11, 4, 16, 45)), now);
    expect(ok).toMatchObject({ ok: true, request: { enabled: false, pauseMinutes: 135 } });
    // exactly seven days is the longest the server takes
    expect(MAX_PAUSE_MINUTES).toBe(10_080);
    expect(customPause(toInput(local(2026, 11, 11, 14, 30)), now)).toMatchObject({ ok: true, request: { pauseMinutes: 10_080 } });
    expect(customPause(toInput(local(2026, 11, 11, 14, 31)), now)).toMatchObject({ ok: false });
  });
});

describe('the paused state in words', () => {
  const state = (reason: 'manual' | 'paused' | 'schedule', until: Date | null) => ({ active: true, reason, until: until ? until.toISOString() : null });
  it('says nothing when Do not disturb is off', () => {
    expect(dndBanner(null, now)).toBeNull();
    expect(dndBanner({ active: false, reason: null, until: null }, now)).toBeNull();
  });
  it('a pause today shows the clock time, tomorrow shows the day, later shows the date', () => {
    expect(dndBanner(state('paused', local(2026, 11, 4, 15, 30)), now)).toEqual({ text: 'Paused until 15:30', canResume: true, reason: 'paused' });
    expect(dndBanner(state('paused', local(2026, 11, 5, 9)), now)?.text).toBe('Paused until tomorrow 09:00');
    expect(dndBanner(state('paused', local(2026, 11, 9, 9)), now)?.text).toBe('Paused until Mon 9 Nov 09:00');
    expect(untilText(local(2026, 11, 4, 0, 5).toISOString(), now)).toBe('00:05');
  });
  it('a hand-set Do not disturb and quiet hours are told apart; only the first can be resumed on the spot', () => {
    expect(dndBanner(state('manual', null), now)).toEqual({ text: 'Do not disturb is on', canResume: true, reason: 'manual' });
    expect(dndBanner(state('schedule', local(2026, 11, 5, 7)), now)).toEqual({ text: 'Quiet hours until tomorrow 07:00', canResume: false, reason: 'schedule' });
    expect(dndBanner(state('schedule', null), now)).toMatchObject({ text: 'Quiet hours', canResume: false });
  });
  it('the bell names the pause', () => {
    expect(bellLabel(0, null)).toBe('Notifications');
    expect(bellLabel(3, null)).toBe('Notifications, 3 unread');
    expect(bellLabel(0, dndBanner(state('paused', local(2026, 11, 4, 15, 30)), now))).toBe('Notifications, paused until 15:30');
    expect(bellLabel(2, dndBanner(state('manual', null), now))).toBe('Notifications, 2 unread, do not disturb is on');
  });
  it('says that held notifications arrive together', () => {
    expect(HELD_NOTE).toMatch(/delivered together when it ends/);
  });
});

describe('the weekly schedule as rows', () => {
  const night = { days: [1, 2, 3, 4, 5], start: '22:00', end: '07:00' };
  it('shows seven rows, Monday first, with the default hours for days no period covers', () => {
    const rows = rowsOf({ enabled: true, windows: [night] });
    expect(rows.map((r) => r.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(rows.map((r) => r.on)).toEqual([true, true, true, true, true, false, false]);
    expect(rows[5]).toMatchObject({ start: DEFAULT_QUIET.start, end: DEFAULT_QUIET.end });
    expect(rowsOf({ enabled: false, windows: [] }).some((r) => r.on)).toBe(false);
  });
  it('days with the same hours share one period; different hours make another; at most seven', () => {
    const rows = rowsOf({ enabled: true, windows: [night, { days: [6, 0], start: '23:00', end: '09:00' }] });
    expect(windowsOf(rows)).toEqual([night, { days: [6, 0], start: '23:00', end: '09:00' }]);
    expect(windowsOf(defaultRows())).toEqual([{ days: [1, 2, 3, 4, 5, 6, 0], start: '22:00', end: '07:00' }]);
    const seven = defaultRows().map((r, i) => ({ ...r, end: `0${i + 1}:00` }));
    expect(windowsOf(seven)).toHaveLength(7);
  });
  it('a round trip changes nothing and the server accepts the result', () => {
    const schedule = { enabled: true, windows: [night, { days: [6, 0], start: '23:00', end: '09:00' }] };
    const built = scheduleRequest(true, rowsOf(schedule));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(UpdateDndRequest.safeParse(built.request).success).toBe(true);
      expect(built.request.schedule?.windows).toEqual(schedule.windows);
    }
    expect(sameRows(rowsOf(schedule), rowsOf(schedule))).toBe(true);
    expect(sameRows(rowsOf(schedule), rowsOf({ ...schedule, windows: [night] }))).toBe(false);
  });
  it('knows when one row per day would lose a period', () => {
    expect(fitsRows({ enabled: true, windows: [night, { days: [6, 0], start: '23:00', end: '09:00' }] })).toBe(true);
    expect(fitsRows({ enabled: true, windows: [night, { days: [5], start: '12:00', end: '13:00' }] })).toBe(false);
  });
  it('an end before the start runs overnight', () => {
    expect(runsOvernight({ start: '22:00', end: '07:00' })).toBe(true);
    expect(runsOvernight({ start: '12:00', end: '13:00' })).toBe(false);
    expect(runsOvernight({ start: '', end: '07:00' })).toBe(false);
  });
  it('refuses an equal start and end, an empty time, and a switched-on schedule with no day', () => {
    const rows = defaultRows();
    expect(scheduleProblem(true, rows)).toBeNull();
    expect(scheduleProblem(true, rows.map((r) => (r.day === 3 ? { ...r, end: r.start } : r)))).toBe('Wed: the start and the end must differ.');
    expect(scheduleProblem(true, rows.map((r) => (r.day === 1 ? { ...r, start: '' } : r)))).toBe('Mon: choose a start and an end time.');
    expect(scheduleProblem(true, rows.map((r) => ({ ...r, on: false })))).toBe('Choose at least one day, or switch the schedule off.');
    // switched off, an empty week is fine: the periods are simply kept empty
    expect(scheduleRequest(false, rows.map((r) => ({ ...r, on: false })))).toEqual({ ok: true, request: { schedule: { enabled: false, windows: [] } } });
  });
  it('means the same as the server reading it: a Friday night period is on at 23:00 and on Saturday 06:00 in the person\'s zone', () => {
    const rows = defaultRows().map((r) => ({ ...r, on: r.day === 5 }));
    const built = scheduleRequest(true, rows);
    if (!built.ok || !built.request.schedule) throw new Error('expected a schedule');
    const settings: DndSettings = { enabled: false, pausedUntil: null, schedule: built.request.schedule };
    // 2026-11-06 is a Friday; Karachi is UTC+5 with no daylight saving
    expect(dndState(settings, 'Asia/Karachi', new Date('2026-11-06T18:00:00Z')).active).toBe(true); // 23:00 Fri
    expect(dndState(settings, 'Asia/Karachi', new Date('2026-11-07T01:00:00Z'))).toMatchObject({ active: true, reason: 'schedule', until: '2026-11-07T02:00:00.000Z' }); // 06:00 Sat, ends 07:00
    expect(dndState(settings, 'Asia/Karachi', new Date('2026-11-07T03:00:00Z')).active).toBe(false); // 08:00 Sat
    expect(dndState(settings, 'Asia/Karachi', new Date('2026-11-05T18:00:00Z')).active).toBe(false); // 23:00 Thu
  });
});

describe('a custom status', () => {
  it('needs an emoji or words, within the limits', () => {
    const base = { emoji: '', text: '', clear: 'never' as const };
    expect(statusRequest(base, null, now)).toEqual({ ok: false, problem: 'Add an emoji or a few words.' });
    expect(statusRequest({ ...base, text: '   ' }, null, now)).toMatchObject({ ok: false });
    expect(statusRequest({ ...base, text: 'x'.repeat(101) }, null, now)).toMatchObject({ ok: false });
    expect(statusRequest({ ...base, emoji: '🙂'.repeat(9) }, null, now)).toEqual({ ok: false, problem: 'Use one emoji.' });
  });
  it('builds a request the server takes, with an emoji only, words only, or both', () => {
    for (const draft of [{ emoji: '🍽️', text: '' }, { emoji: '', text: 'Lunch' }, { emoji: '🍽️', text: ' Lunch ' }]) {
      const built = statusRequest({ ...draft, clear: 'never' }, null, now);
      expect(built.ok).toBe(true);
      if (built.ok) expect(UpdateMyPresenceRequest.safeParse(built.body).success).toBe(true);
    }
    expect(statusRequest({ emoji: '', text: ' Lunch ', clear: 'never' }, null, now)).toEqual({ ok: true, body: { status: { emoji: null, text: 'Lunch', clearsAt: null } } });
  });
  it('clear-after choices count from now on the device clock', () => {
    const at = (clear: 'never' | '30m' | '1h' | '4h' | 'today'): string | null => {
      const built = statusRequest({ emoji: '💬', text: '', clear }, null, now);
      return built.ok ? (built.body.status?.clearsAt ?? null) : 'bad';
    };
    expect(at('never')).toBeNull();
    expect(at('30m')).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
    expect(at('1h')).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(at('4h')).toBe(new Date(now.getTime() + 4 * 3_600_000).toISOString());
    expect(at('today')).toBe(local(2026, 11, 5).toISOString());
    expect(clearsAtFor('today', local(2026, 11, 4, 23, 59))).toBe(local(2026, 11, 5).toISOString());
  });
  it('editing a status keeps its clear time unless the person picks another', () => {
    const current = { emoji: '🏠', text: 'Home', clearsAt: local(2026, 11, 4, 17).toISOString() };
    const draft = statusDraftOf(current);
    expect(draft).toEqual({ emoji: '🏠', text: 'Home', clear: 'keep' });
    expect(statusRequest({ ...draft, text: 'Working from home' }, current, now)).toEqual({ ok: true, body: { status: { emoji: '🏠', text: 'Working from home', clearsAt: current.clearsAt } } });
    expect(statusDraftOf(null)).toEqual({ emoji: '', text: '', clear: 'never' });
    expect(statusDraftOf({ emoji: null, text: 'x', clearsAt: null }).clear).toBe('never');
  });
  it('says when a status clears', () => {
    expect(clearsText(null, now)).toBeNull();
    expect(clearsText({ emoji: null, text: 'x', clearsAt: null }, now)).toBeNull();
    expect(clearsText({ emoji: null, text: 'x', clearsAt: local(2026, 11, 4, 16).toISOString() }, now)).toBe('Clears 16:00');
    expect(clearsText({ emoji: null, text: 'x', clearsAt: local(2026, 11, 5).toISOString() }, now)).toBe('Clears at midnight');
  });
});

describe('time zone and working hours', () => {
  it('lists the zones once each, with UTC, the device zone and the saved one, sorted', () => {
    const zones = timeZoneChoices('Pacific/Kiritimati', 'Asia/Karachi');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Karachi');
    expect(zones).toContain('Pacific/Kiritimati');
    expect(new Set(zones).size).toBe(zones.length);
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
    expect(timeZoneChoices(null, null).length).toBeGreaterThan(5);
  });
  it('hours need a zone, a day, times in order, and a real zone name', () => {
    const on = { on: true, days: [1, 2, 3], start: '09:00', end: '17:00' };
    expect(profileRequest('Asia/Karachi', on)).toEqual({ ok: true, body: { timeZone: 'Asia/Karachi', workingHours: { days: [1, 2, 3], start: '09:00', end: '17:00' } } });
    expect(profileRequest(null, on)).toEqual({ ok: false, problem: 'Choose your time zone before you set working hours.' });
    expect(profileRequest('Asia/Karachi', { ...on, days: [] })).toEqual({ ok: false, problem: 'Choose at least one working day.' });
    expect(profileRequest('Asia/Karachi', { ...on, start: '18:00' })).toEqual({ ok: false, problem: 'Working hours must end after they start.' });
    expect(profileRequest('Asia/Karachi', { ...on, end: '' })).toMatchObject({ ok: false });
    expect(profileRequest('Mars/Olympus', on)).toEqual({ ok: false, problem: 'Choose a time zone from the list.' });
  });
  it('switching hours off sends null and works without any zone', () => {
    expect(profileRequest(null, { ...hoursDraftOf(null) })).toEqual({ ok: true, body: { timeZone: null, workingHours: null } });
    expect(hoursDraftOf(null)).toMatchObject({ on: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' });
    expect(hoursDraftOf({ days: [2, 4], start: '08:00', end: '12:00' })).toEqual({ on: true, days: [2, 4], start: '08:00', end: '12:00' });
  });
});

const mine = (patch: Partial<MyPresence> = {}): MyPresence => ({
  status: null,
  timeZone: 'UTC',
  workingHours: null,
  outOfOffice: null,
  dnd: { enabled: false, pausedUntil: null, schedule: { enabled: false, windows: [] } },
  dndState: { active: false, reason: null, until: null },
  ...patch,
});

describe('the client copy of the person\'s own settings', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loadMe reads only the own settings (no heartbeat, no cards)', async () => {
    api.fetchMyPresence.mockResolvedValue(mine());
    const store = new PresenceStore();
    await store.loadMe();
    expect(store.snapshot()).toMatchObject({ supported: true, meStatus: 'ready' });
    expect(api.sendHeartbeat).not.toHaveBeenCalled();
    expect(api.fetchPresenceCards).not.toHaveBeenCalled();
  });
  it('a server without the plugin (404) or an actor without presence (403) is absent, and is not asked again', async () => {
    api.fetchMyPresence.mockRejectedValue(new ApiError({ status: 404, code: 'not_found', message: 'No such route' }));
    const store = new PresenceStore();
    await store.loadMe();
    expect(store.snapshot().meStatus).toBe('absent');
    await store.loadMe();
    expect(api.fetchMyPresence).toHaveBeenCalledTimes(1);
  });
  it('a failed read keeps what was shown, and says error only when there was nothing', async () => {
    const store = new PresenceStore();
    api.fetchMyPresence.mockRejectedValueOnce(new ApiError({ status: 500, code: 'internal', message: 'down' }));
    await store.loadMe();
    expect(store.snapshot().meStatus).toBe('error');
    api.fetchMyPresence.mockResolvedValueOnce(mine());
    await store.loadMe();
    api.fetchMyPresence.mockRejectedValueOnce(new ApiError({ status: 500, code: 'internal', message: 'down' }));
    await store.loadMe();
    expect(store.snapshot()).toMatchObject({ meStatus: 'ready' });
    expect(store.snapshot().me).not.toBeNull();
  });
  it('an older read that arrives after a save does not put the old settings back', async () => {
    const store = new PresenceStore();
    let answerRead: (m: MyPresence) => void = () => undefined;
    api.fetchMyPresence.mockReturnValueOnce(new Promise<MyPresence>((resolve) => { answerRead = resolve; }));
    const reading = store.loadMe();
    const paused = mine({ dndState: { active: true, reason: 'paused', until: '2026-11-04T15:00:00.000Z' }, dnd: { enabled: false, pausedUntil: '2026-11-04T15:00:00.000Z', schedule: { enabled: false, windows: [] } } });
    api.saveDnd.mockResolvedValue(paused);
    await store.saveDnd({ pauseMinutes: 30 });
    answerRead(mine());
    await reading;
    expect(store.snapshot().me?.dnd.pausedUntil).toBe('2026-11-04T15:00:00.000Z');
  });
  it('saving puts the whole answer in the store at once', async () => {
    const store = new PresenceStore();
    api.saveMyPresence.mockResolvedValue(mine({ status: { emoji: '🍽️', text: 'Lunch', clearsAt: null } }));
    await store.saveProfile({ status: { emoji: '🍽️', text: 'Lunch', clearsAt: null } });
    expect(store.snapshot().me?.status?.text).toBe('Lunch');
    expect(store.snapshot().meStatus).toBe('ready');
  });
});
