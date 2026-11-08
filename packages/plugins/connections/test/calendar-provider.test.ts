import { createSecretService, createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import type { CalendarConnector, PluginTx } from '@manythreads/sdk';
import { ListMyCalendarsResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { createCalendarConnector, googleEvent, graphEvent } from '../src/calendar-provider.ts';
import type { OAuthDeps } from '../src/oauth/store.ts';

// P16-05: the calendar door (`connector.calendar`) and `GET /api/me/calendars`, on a real server and the fake Google and Microsoft 365 (packages/test-utils). The sign-ins are the
// real OAuth code flow; the door is called as the meetings plugin calls it (a person id and a workspace id, nothing else).

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, priya, tariq } = personas;
const WS = omar.workspaceId;

let w: RepoWorld;
let fake: FakeProviders;
let sysPool: pg.Pool;
let door: CalendarConnector;
const savedEnv: Record<string, string | undefined> = {};
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
// the door opens its own transaction; the one a caller passes is never used
const noTx = {} as unknown as PluginTx;

const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function connect(who: Who & { email: string }, provider: PersonProviderId, services: string[]): Promise<void> {
  fake.signInAs(who.email);
  const start = await raw(who, 'POST', `/api/me/connections/${provider}/start`, { services });
  expect(start.status).toBe(200);
  const consent = await fetch(StartPersonConnectionResponse.parse(await start.json()).url, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location')!);
  const done = await raw(who, 'GET', `${back.pathname}${back.search}`);
  expect(done.status).toBe(302);
}

const caller = (who: { personId: string }, provider: 'google' | 'microsoft') => ({ workspaceId: WS, personId: who.personId, provider });
const EVENT = {
  title: 'Design review',
  startsAt: '2026-11-10T10:00:00.000Z',
  endsAt: '2026-11-10T10:30:00.000Z',
  description: 'Agenda: the new header.\n\nJoin: https://site.example/join/abc',
  location: 'https://site.example/join/abc',
  attendeeEmails: [omar.email, 'x@outside.test'],
};

beforeAll(async () => {
  fake = await startFakeProviders();
  for (const [k, v] of Object.entries(fake.env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  const deps: OAuthDeps = {
    db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
    secrets: createSecretService(),
    now: () => new Date(),
    env: process.env,
  };
  door = createCalendarConnector(deps);
  // what each person has agreed to: Nadia the calendar on Google, Rafi on Microsoft, Priya only to read events, Tariq both
  await connect(nadia, 'google', ['calendar_write', 'calendar_free_busy']);
  await connect(rafi, 'microsoft', ['calendar_write', 'calendar_free_busy']);
  await connect(priya, 'google', ['calendar']);
  await connect(tariq, 'google', ['calendar_write']);
  await connect(tariq, 'microsoft', ['calendar_write']);
}, 240_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sysPool?.end();
  await w?.close();
  await fake?.stop();
});

describe('which calendars a person can plan a room in', () => {
  it('names the connected services, oldest first, and the main calendar of each that has the write service', async () => {
    expect(await door.connectedProviders(noTx, { workspaceId: WS, personId: nadia.personId })).toEqual(['google']);
    expect(await door.connectedProviders(noTx, { workspaceId: WS, personId: tariq.personId })).toEqual(['google', 'microsoft']);
    expect(await door.connectedProviders(noTx, { workspaceId: WS, personId: omar.personId })).toEqual([]);
    const own = await door.calendarsOf(noTx, caller(nadia, 'google'));
    expect(own).toMatchObject({ ok: true, value: [{ id: 'primary', primary: true }] });
  });

  it('answers not_connected for a service the person has not connected, and scope_missing for one connected without the write service', async () => {
    expect(await door.calendarsOf(noTx, caller(nadia, 'microsoft'))).toMatchObject({ ok: false, code: 'not_connected' });
    expect(await door.calendarsOf(noTx, caller(omar, 'google'))).toMatchObject({ ok: false, code: 'not_connected' });
    expect(await door.calendarsOf(noTx, caller(priya, 'google'))).toMatchObject({ ok: false, code: 'scope_missing' });
  });

  it('GET /api/me/calendars lists the calendars of the caller’s own sign-ins and names the services that still need the calendar service', async () => {
    const read = async (who: Who) => {
      const res = await raw(who, 'GET', '/api/me/calendars');
      expect(res.status, await res.clone().text()).toBe(200);
      return ListMyCalendarsResponse.parse(await res.json());
    };
    const nadias = await read(nadia);
    expect(nadias.calendars.map((c) => `${c.provider}:${c.calendarId}:${String(c.primary)}`)).toEqual(['google:primary:true']);
    expect(nadias.needsCalendarAccess).toEqual([]);
    expect(await read(priya)).toEqual({ calendars: [], needsCalendarAccess: ['google'] });
    expect(await read(omar)).toEqual({ calendars: [], needsCalendarAccess: [] });
    // Tariq has both: he sees both, and nobody else's calendar is in his list
    expect((await read(tariq)).calendars.map((c) => c.provider)).toEqual(['google', 'microsoft']);
    expect(JSON.stringify(nadias)).not.toContain(rafi.email);
  });
});

describe('Google', () => {
  let eventId = '';

  it('creates one event with the link in the description and the location, the people invited, and tells the guests', async () => {
    const before = fake.createdEvents.length;
    const made = await door.createEvent(noTx, { ...caller(nadia, 'google'), event: EVENT });
    expect(made).toMatchObject({ ok: true, value: { title: 'Design review', startsAt: EVENT.startsAt, endsAt: EVENT.endsAt, cancelled: false } });
    if (!made.ok) throw new Error('unreachable');
    eventId = made.value.id;
    expect(made.value.url).toMatch(/^https:\/\//);
    expect(fake.createdEvents.slice(before)).toEqual([{ provider: 'google', account: nadia.email, title: 'Design review', start: EVENT.startsAt, end: EVENT.endsAt, guests: [omar.email, 'x@outside.test'] }]);
    expect(fake.createdEventDetails.at(-1)).toMatchObject({ provider: 'google', account: nadia.email, eventId, description: EVENT.description, location: EVENT.location });
    // it is the person's own sign-in that was used
    expect(fake.apiCalls.filter((c) => c.provider === 'google' && c.path.endsWith('/events') && c.method === 'POST').every((c) => c.authorized)).toBe(true);
  });

  it('reads it back, changes only the fields named, and answers what the calendar now says', async () => {
    const got = await door.getEvent(noTx, { ...caller(nadia, 'google'), eventId });
    expect(got).toMatchObject({ ok: true, value: { id: eventId, title: 'Design review', cancelled: false } });
    const changed = await door.updateEvent(noTx, { ...caller(nadia, 'google'), eventId, changes: { startsAt: '2026-11-10T11:00:00.000Z', endsAt: '2026-11-10T11:30:00.000Z' } });
    expect(changed).toMatchObject({ ok: true, value: { id: eventId, title: 'Design review', startsAt: '2026-11-10T11:00:00.000Z', endsAt: '2026-11-10T11:30:00.000Z' } });
    expect(fake.updatedEvents.at(-1)).toMatchObject({ account: nadia.email, eventId, fields: { start: { dateTime: '2026-11-10T11:00:00.000Z' }, end: { dateTime: '2026-11-10T11:30:00.000Z' } } });
    expect(Object.keys(fake.updatedEvents.at(-1)!.fields)).not.toContain('summary');
  });

  it('cancels it; cancelling again, or an event that never existed, is not an error', async () => {
    expect(await door.cancelEvent(noTx, { ...caller(nadia, 'google'), eventId })).toEqual({ ok: true, value: null });
    expect(fake.deletedEvents.filter((d) => d.eventId === eventId)).toHaveLength(1);
    expect(await door.cancelEvent(noTx, { ...caller(nadia, 'google'), eventId })).toEqual({ ok: true, value: null });
    expect(await door.cancelEvent(noTx, { ...caller(nadia, 'google'), eventId: 'event-never' })).toEqual({ ok: true, value: null });
    expect(await door.getEvent(noTx, { ...caller(nadia, 'google'), eventId })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a write without the write service (scope_missing) and without a sign-in (not_connected), before anything is sent to the provider', async () => {
    const calls = fake.apiCalls.length;
    expect(await door.createEvent(noTx, { ...caller(priya, 'google'), event: EVENT })).toMatchObject({ ok: false, code: 'scope_missing' });
    expect(await door.createEvent(noTx, { ...caller(omar, 'google'), event: EVENT })).toMatchObject({ ok: false, code: 'not_connected' });
    expect(await door.updateEvent(noTx, { ...caller(priya, 'google'), eventId: 'x', changes: { title: 'y' } })).toMatchObject({ ok: false, code: 'scope_missing' });
    expect(await door.freeBusy(noTx, { ...caller(tariq, 'google'), emails: [], from: EVENT.startsAt, to: EVENT.endsAt })).toMatchObject({ ok: false, code: 'scope_missing' });
    expect(fake.apiCalls.length).toBe(calls);
  });

  it('answers free and busy for the person, a shared calendar as busy spans only, and one that is not shared as not visible', async () => {
    fake.account(nadia.email).events = [{ id: 'n1', title: 'Dentist (private)', start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' }];
    fake.account(omar.email).events = [{ id: 'o1', title: 'Secret strategy', start: '2026-11-10T09:30:00.000Z', end: '2026-11-10T10:30:00.000Z' }];
    fake.account(priya.email).shareCalendar = false;
    const answer = await door.freeBusy(noTx, { ...caller(nadia, 'google'), emails: [omar.email, priya.email, 'ghost@outside.test'], from: '2026-11-10T07:00:00.000Z', to: '2026-11-10T12:00:00.000Z' });
    expect(answer).toEqual({
      ok: true,
      value: [
        { email: 'self', visible: true, busy: [{ startsAt: '2026-11-10T08:00:00.000Z', endsAt: '2026-11-10T09:00:00.000Z' }] },
        { email: omar.email, visible: true, busy: [{ startsAt: '2026-11-10T09:30:00.000Z', endsAt: '2026-11-10T10:30:00.000Z' }] },
        { email: priya.email, visible: false, busy: [] },
        { email: 'ghost@outside.test', visible: false, busy: [] },
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(/Dentist|Secret strategy/);
  });
});

describe('Microsoft 365', () => {
  let eventId = '';

  it('creates, reads, changes and cancels an event with the same shape of answer', async () => {
    const made = await door.createEvent(noTx, { ...caller(rafi, 'microsoft'), event: EVENT });
    expect(made).toMatchObject({ ok: true, value: { title: 'Design review', startsAt: EVENT.startsAt, endsAt: EVENT.endsAt, cancelled: false } });
    if (!made.ok) throw new Error('unreachable');
    eventId = made.value.id;
    expect(fake.createdEvents.at(-1)).toMatchObject({ provider: 'microsoft', account: rafi.email, title: 'Design review', guests: [omar.email, 'x@outside.test'] });
    expect(fake.createdEventDetails.at(-1)).toMatchObject({ provider: 'microsoft', eventId, description: EVENT.description, location: EVENT.location });

    const changed = await door.updateEvent(noTx, { ...caller(rafi, 'microsoft'), eventId, changes: { title: 'Design review (moved)', startsAt: '2026-11-10T12:00:00.000Z', endsAt: '2026-11-10T12:30:00.000Z' } });
    expect(changed).toMatchObject({ ok: true, value: { id: eventId, title: 'Design review (moved)', startsAt: '2026-11-10T12:00:00.000Z', endsAt: '2026-11-10T12:30:00.000Z' } });

    expect(await door.cancelEvent(noTx, { ...caller(rafi, 'microsoft'), eventId })).toEqual({ ok: true, value: null });
    expect(await door.getEvent(noTx, { ...caller(rafi, 'microsoft'), eventId })).toMatchObject({ ok: true, value: { id: eventId, cancelled: true } });
    expect(await door.cancelEvent(noTx, { ...caller(rafi, 'microsoft'), eventId: 'event-never' })).toEqual({ ok: true, value: null });
  });

  it('answers free and busy: free items are not busy, an unshared mailbox is not visible, and no provider text is passed on', async () => {
    fake.account(rafi.email).events = [{ id: 'r1', title: 'Private errand', start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' }];
    fake.account(omar.email).events = [{ id: 'o1', title: 'Secret strategy', start: '2026-11-10T09:30:00.000Z', end: '2026-11-10T10:30:00.000Z' }];
    fake.account(priya.email).shareCalendar = false;
    const answer = await door.freeBusy(noTx, { ...caller(rafi, 'microsoft'), emails: [omar.email, priya.email], from: '2026-11-10T07:00:00.000Z', to: '2026-11-10T12:00:00.000Z' });
    expect(answer).toEqual({
      ok: true,
      value: [
        { email: 'self', visible: true, busy: [{ startsAt: '2026-11-10T08:00:00.000Z', endsAt: '2026-11-10T09:00:00.000Z' }] },
        { email: omar.email, visible: true, busy: [{ startsAt: '2026-11-10T09:30:00.000Z', endsAt: '2026-11-10T10:30:00.000Z' }] },
        { email: priya.email, visible: false, busy: [] },
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(/Private errand|Secret strategy|SECRET-MAILBOX-TEXT/);
  });

  it('a provider that stops accepting the token is not_connected, and an answer never carries the provider’s own words', async () => {
    const stop = await sys(async (tx) => tx.query(`UPDATE app.connection_oauth SET state = 'needs_reconnect' WHERE connection_id IN (SELECT id FROM app.connections WHERE owner_id = $1 AND slug = 'microsoft')`, [tariq.actorId]));
    expect(stop.rowCount).toBe(1);
    const lost = await door.createEvent(noTx, { ...caller(tariq, 'microsoft'), event: EVENT });
    expect(lost).toMatchObject({ ok: false, code: 'not_connected' });
    // his Google sign-in is still his own and still works
    expect(await door.calendarsOf(noTx, caller(tariq, 'google'))).toMatchObject({ ok: true });
    expect(await door.connectedProviders(noTx, { workspaceId: WS, personId: tariq.personId })).toEqual(['google']);
  });
});

describe('reading an event', () => {
  it('an all-day Google event is read as that day, a deleted one as cancelled, and a description is kept only as text', () => {
    expect(googleEvent({ id: 'a', summary: 'Offsite', start: { date: '2026-11-12' }, end: { date: '2026-11-13' }, status: 'cancelled', description: 'x'.repeat(30_000) })).toMatchObject({
      id: 'a',
      title: 'Offsite',
      startsAt: '2026-11-12T00:00:00.000Z',
      endsAt: '2026-11-13T00:00:00.000Z',
      cancelled: true,
    });
    expect(googleEvent({ description: 'x'.repeat(30_000) }).description).toHaveLength(20_000);
    expect(googleEvent(null)).toMatchObject({ id: '', title: '', startsAt: '', cancelled: false });
  });

  it('an Outlook event whose body is HTML is reduced to its text', () => {
    const e = graphEvent({ id: 'b', subject: 'Sync', body: { contentType: 'html', content: '<p>Agenda <b>one</b></p><script>alert(1)</script>' }, start: { dateTime: '2026-11-12T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-12T11:00:00.0000000', timeZone: 'UTC' }, isCancelled: true });
    expect(e).toMatchObject({ id: 'b', title: 'Sync', startsAt: '2026-11-12T10:00:00.000Z', endsAt: '2026-11-12T11:00:00.000Z', cancelled: true });
    expect(e.description).not.toContain('<');
    expect(e.description).toContain('Agenda');
  });
});
