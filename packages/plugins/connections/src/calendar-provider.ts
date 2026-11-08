import {
  forbidden,
  json,
  route,
  type CalendarConnector,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarSummary,
  type ConnectorCaller,
  type ConnectorErrorCode,
  type ConnectorResult,
  type FreeBusyAnswer,
  type PluginContext,
} from '@manythreads/sdk';
import { ListMyCalendarsResponse, listMyCalendarsRoute, type ScheduledMeetingProvider } from '@manythreads/shared';
import { createProviderApi, ProviderError, type ProviderApi } from './oauth/api.ts';
import { createReconnectNotifier } from './oauth/notice.ts';
import { PROVIDERS, serviceDef } from './oauth/providers.ts';
import { ConnectionProblem, ownConnections, type OAuthDeps } from './oauth/store.ts';
import { graphTime } from './microsoft-tools.ts';
import { address, asArray, asRecord, enc, freeBusyInput, mergeBusy, str, stripHtml, type Span } from './person-kit.ts';
import { isUsable } from './rows.ts';

// Work package C (P16-05, decisions D3, D4, D8, D11): the `connector.calendar` provider and the list of calendars a person can plan a room in. The provider reads the person's own
// Google or Microsoft grant (the same sealed tokens the person tools use) and nothing else: every call names a person, and there is no workspace-wide token behind it.
//
//  * The `tx` that callers pass is NOT used. A call opens its own short system transaction to find the grant and closes it before the provider is asked, so a caller in a detached
//    job may pass any handle and a route's transaction is never the one the provider call waits in.
//  * Only the main calendar is offered. Google lists a person's calendars only with a wider permission (`calendar`, `calendar.calendarlist`) than the one a room needs
//    (`calendar.events`), and a room should not ask for more than it uses; Outlook's main calendar is `/me/calendar`.
//  * Writes (`createEvent`, `updateEvent`, `cancelEvent`) and reads of one event need the person to have agreed to "Calendar (add and change events)". Free and busy needs "Calendar
//    (free and busy)". A missing permission answers `scope_missing`; the caller shows the incremental-consent path.
//  * What a provider says in its own words never travels: an error carries our sentence only, never the provider's text, an address or a token.

const GOOGLE_EVENTS = (calendarId: string | undefined): string => `/calendar/v3/calendars/${enc(calendarId && calendarId !== '' ? calendarId : 'primary')}/events`;
const GRAPH_EVENTS = (calendarId: string | undefined): string => (calendarId && calendarId !== '' && calendarId !== 'primary' ? `/me/calendars/${enc(calendarId)}/events` : '/me/events');
/** Outlook answers times in UTC and the body as plain text when asked, so a description edited in Outlook comes back readable. */
const GRAPH_PREFER = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };
const GRAPH_UTC = { prefer: 'outlook.timezone="UTC"' };
const CALENDAR_PROVIDERS: readonly ScheduledMeetingProvider[] = ['google', 'microsoft'];
const DESCRIPTION_MAX = 20_000;

const iso = (v: unknown): string => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};
/** A time as Graph is sent it: the instant in UTC, written without an offset. */
const graphLocal = (v: string): { dateTime: string; timeZone: 'UTC' } => ({ dateTime: new Date(v).toISOString().slice(0, 19), timeZone: 'UTC' });

// ---- how a provider's event becomes ours ----------------------------------------------------------------------------------------------------------------

/** One Google Calendar event. An all-day event (a date, no time) is read as that day's start in UTC. */
export function googleEvent(doc: unknown): CalendarEvent {
  const r = asRecord(doc);
  const when = (v: unknown): string => iso(asRecord(v)['dateTime']) || iso(`${str(asRecord(v)['date'], 10) ?? ''}T00:00:00Z`);
  return {
    id: str(r['id'], 1024) ?? '',
    title: str(r['summary'], 300) ?? '',
    startsAt: when(r['start']),
    endsAt: when(r['end']),
    description: str(r['description'], DESCRIPTION_MAX) ?? '',
    cancelled: r['status'] === 'cancelled',
    url: str(r['htmlLink'], 500),
    version: str(r['etag'], 100) ?? str(r['updated'], 40),
  };
}

/** One Outlook event. A body that still came back as HTML (older events) is reduced to its text. */
export function graphEvent(doc: unknown): CalendarEvent {
  const r = asRecord(doc);
  const body = asRecord(r['body']);
  const raw = str(body['content'], DESCRIPTION_MAX * 2) ?? '';
  return {
    id: str(r['id'], 1024) ?? '',
    title: str(r['subject'], 300) ?? '',
    startsAt: iso(graphTime(r['start'])),
    endsAt: iso(graphTime(r['end'])),
    description: (String(body['contentType']).toLowerCase() === 'html' ? stripHtml(raw) : raw).slice(0, DESCRIPTION_MAX),
    cancelled: r['isCancelled'] === true,
    url: str(r['webLink'], 500),
    version: str(r['changeKey'], 100),
  };
}

// ---- finding the grant ----------------------------------------------------------------------------------------------------------------------------------------

interface Grant {
  connectionId: string;
  scopes: string[];
  accountLabel: string | null;
}

/** The services of a provider a call needs; each is a service of `providers.ts`, so the scope strings are written once. */
type Need = 'calendar_write' | 'calendar_free_busy';

const hasService = (provider: ScheduledMeetingProvider, need: Need, scopes: readonly string[]): boolean => {
  const service = serviceDef(PROVIDERS[provider], need);
  return service !== undefined && service.scopes.every((s) => scopes.includes(s));
};

const fail = <T>(code: ConnectorErrorCode, message: string): ConnectorResult<T> => ({ ok: false, code, message });

/** A provider or sign-in problem as the door's answer. The message is ours. */
function problemOf<T>(err: unknown): ConnectorResult<T> {
  if (err instanceof ProviderError) {
    if (err.status === 401) return fail('not_connected', err.message);
    if (err.status === 403) return fail('scope_missing', err.message);
    if (err.status === 404 || err.status === 410) return fail('not_found', err.message);
    return fail('provider_down', err.message);
  }
  if (err instanceof ConnectionProblem) return fail(err.code === 'needs_reconnect' || err.code === 'not_connected' ? 'not_connected' : 'provider_down', err.message);
  return fail('provider_down', 'The calendar could not be reached. Try again in a minute.');
}

export function createCalendarConnector(deps: OAuthDeps): CalendarConnector & { grantsOf(workspaceId: string, personId: string): Promise<Array<Grant & { provider: ScheduledMeetingProvider }>> } {
  /** The person's actor id (their connections belong to the actor). */
  const actorOf = (workspaceId: string, personId: string): Promise<string | null> =>
    deps.db.system(
      async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1::uuid AND workspace_id = $2::uuid`, [personId, workspaceId])).rows[0]?.id ?? null,
      { workspaceId },
    );

  /** The person's usable calendar sign-ins, oldest first. */
  const grantsOf = (workspaceId: string, personId: string): Promise<Array<Grant & { provider: ScheduledMeetingProvider }>> =>
    deps.db.system(
      async (tx) => {
        const rows = await tx.query<{ id: string; slug: string; status: 'enabled' | 'disabled'; has_credentials: boolean; expired: boolean; scopes: string[]; state: string; account_label: string | null }>(
          `SELECT c.id, c.slug, c.status, c.has_credentials, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired, o.scopes, o.state, o.account_label
             FROM app.connections c
             JOIN app.connection_oauth o ON o.connection_id = c.id
             JOIN app.actors a ON a.id = c.owner_id AND a.kind = 'person'
            WHERE c.workspace_id = $1::uuid AND c.scope = 'person' AND a.ref_id = $2::uuid AND c.slug = ANY ($3::text[])
            ORDER BY c.created_at, c.slug`,
          [workspaceId, personId, [...CALENDAR_PROVIDERS]],
        );
        return rows.rows.filter((r) => isUsable(r) && r.state === 'ok').map((r) => ({ provider: r.slug as ScheduledMeetingProvider, connectionId: r.id, scopes: r.scopes, accountLabel: r.account_label }));
      },
      { workspaceId },
    );

  /** The provider's door for this person, or the reason there is none. */
  async function doorFor(caller: ConnectorCaller & { provider: ScheduledMeetingProvider }, need: Need): Promise<ConnectorResult<ProviderApi>> {
    if (!CALENDAR_PROVIDERS.includes(caller.provider)) return fail('not_connected', 'That calendar service is not one a room can be planned in.');
    const actor = await actorOf(caller.workspaceId, caller.personId);
    if (actor === null) return fail('not_connected', 'That person is not in this workspace.');
    const grant = (await grantsOf(caller.workspaceId, caller.personId)).find((g) => g.provider === caller.provider);
    const label = PROVIDERS[caller.provider].label;
    if (!grant) return fail('not_connected', `${label} is not connected. Connect your ${label} calendar first.`);
    if (!hasService(caller.provider, need, grant.scopes)) {
      return fail('scope_missing', need === 'calendar_write' ? `${label} was connected without permission to add and change calendar events. Add Calendar to your connection.` : `${label} was connected without permission to see when people are free. Add free and busy to your connection.`);
    }
    return { ok: true, value: createProviderApi(deps, { id: grant.connectionId, workspaceId: caller.workspaceId, provider: caller.provider }) };
  }

  /** Runs `fn` with the door; a provider or sign-in problem becomes the door's answer. */
  async function withDoor<T>(caller: ConnectorCaller & { provider: ScheduledMeetingProvider }, need: Need, fn: (api: ProviderApi) => Promise<T>): Promise<ConnectorResult<T>> {
    try {
      const door = await doorFor(caller, need);
      if (!door.ok) return door;
      return { ok: true, value: await fn(door.value) };
    } catch (err) {
      return problemOf<T>(err);
    }
  }

  const googleBody = (e: Partial<CalendarEventInput>): Record<string, unknown> => ({
    ...(e.title !== undefined ? { summary: e.title } : {}),
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.location !== undefined ? { location: e.location } : {}),
    ...(e.startsAt !== undefined ? { start: { dateTime: new Date(e.startsAt).toISOString() } } : {}),
    ...(e.endsAt !== undefined ? { end: { dateTime: new Date(e.endsAt).toISOString() } } : {}),
    ...(e.attendeeEmails !== undefined ? { attendees: e.attendeeEmails.map((email) => ({ email })) } : {}),
  });
  const graphBody = (e: Partial<CalendarEventInput>): Record<string, unknown> => ({
    ...(e.title !== undefined ? { subject: e.title } : {}),
    ...(e.description !== undefined ? { body: { contentType: 'Text', content: e.description } } : {}),
    ...(e.location !== undefined ? { location: { displayName: e.location } } : {}),
    ...(e.startsAt !== undefined ? { start: graphLocal(e.startsAt) } : {}),
    ...(e.endsAt !== undefined ? { end: graphLocal(e.endsAt) } : {}),
    ...(e.attendeeEmails !== undefined ? { attendees: e.attendeeEmails.map((a) => ({ emailAddress: { address: a }, type: 'required' })) } : {}),
  });

  const readOne = async (api: ProviderApi, provider: ScheduledMeetingProvider, calendarId: string | undefined, eventId: string): Promise<CalendarEvent> => {
    if (provider === 'google') return googleEvent(await api.json(`${GOOGLE_EVENTS(calendarId)}/${enc(eventId)}`));
    return graphEvent(await api.json(`${GRAPH_EVENTS(calendarId)}/${enc(eventId)}`, { headers: GRAPH_PREFER }));
  };

  return {
    id: 'connections',
    grantsOf,

    async connectedProviders(_tx, caller) {
      // in the order the person connected them (grantsOf is oldest first)
      return [...new Set((await grantsOf(caller.workspaceId, caller.personId)).map((g) => g.provider))];
    },

    async calendarsOf(_tx, caller) {
      const grant = (await grantsOf(caller.workspaceId, caller.personId)).find((g) => g.provider === caller.provider);
      if (!grant) return fail('not_connected', `${PROVIDERS[caller.provider].label} is not connected.`);
      if (!hasService(caller.provider, 'calendar_write', grant.scopes)) return fail('scope_missing', `${PROVIDERS[caller.provider].label} was connected without permission to add and change calendar events.`);
      return { ok: true, value: [mainCalendar(caller.provider, grant.accountLabel)] };
    },

    createEvent(_tx, caller) {
      return withDoor(caller, 'calendar_write', async (api) => {
        if (caller.provider === 'google') {
          // sendUpdates=all: the guests get the invitation from the calendar itself, which is what the person who planned the room expects
          return googleEvent(await api.json(GOOGLE_EVENTS(caller.calendarId), { method: 'POST', query: { sendUpdates: 'all' }, body: googleBody(caller.event) }));
        }
        return graphEvent(await api.json(GRAPH_EVENTS(caller.calendarId), { method: 'POST', headers: GRAPH_PREFER, body: graphBody(caller.event) }));
      });
    },

    updateEvent(_tx, caller) {
      return withDoor(caller, 'calendar_write', async (api) => {
        const path = `${caller.provider === 'google' ? GOOGLE_EVENTS(caller.calendarId) : GRAPH_EVENTS(caller.calendarId)}/${enc(caller.eventId)}`;
        if (caller.provider === 'google') await api.json(path, { method: 'PATCH', query: { sendUpdates: 'all' }, body: googleBody(caller.changes) });
        else await api.json(path, { method: 'PATCH', headers: GRAPH_PREFER, body: graphBody(caller.changes) });
        // the answer to a change is read again, so what the caller keeps is what the calendar now says
        return readOne(api, caller.provider, caller.calendarId, caller.eventId);
      });
    },

    async cancelEvent(_tx, caller) {
      const done = await withDoor(caller, 'calendar_write', async (api) => {
        try {
          if (caller.provider === 'google') {
            await api.json(`${GOOGLE_EVENTS(caller.calendarId)}/${enc(caller.eventId)}`, { method: 'DELETE', query: { sendUpdates: 'all' } });
            return null;
          }
          // a meeting with guests is cancelled (the guests are told); an event that cannot be cancelled that way (no guests) is deleted
          try {
            await api.json(`${GRAPH_EVENTS(caller.calendarId)}/${enc(caller.eventId)}/cancel`, { method: 'POST', body: { comment: 'This room was cancelled.' } });
          } catch (err) {
            if (!(err instanceof ProviderError) || ![400, 409].includes(err.status)) throw err;
            await api.json(`${GRAPH_EVENTS(caller.calendarId)}/${enc(caller.eventId)}`, { method: 'DELETE' });
          }
          return null;
        } catch (err) {
          // already gone (or already cancelled) is the result the caller wanted
          if (err instanceof ProviderError && (err.status === 404 || err.status === 410)) return null;
          throw err;
        }
      });
      return done;
    },

    getEvent(_tx, caller) {
      return withDoor(caller, 'calendar_write', (api) => readOne(api, caller.provider, caller.calendarId, caller.eventId));
    },

    freeBusy(_tx, caller) {
      return withDoor(caller, 'calendar_free_busy', (api) => readFreeBusy(api, caller.provider, caller.emails, caller.from, caller.to));
    },
  };
}

function mainCalendar(provider: ScheduledMeetingProvider, accountLabel: string | null): CalendarSummary {
  const base = provider === 'google' ? 'Google Calendar' : 'Outlook calendar';
  return { id: 'primary', name: (accountLabel ? `${base} · ${accountLabel}` : base).slice(0, 200), primary: true };
}

// ---- free and busy, shared with the person tool `calendar.find_free_time` ------------------------------------------------------------------------------------

/** Spans of an answer that cannot be read are dropped by `mergeBusy`; at most this many are read from one calendar. */
const MAX_BUSY = 500;

/**
 * When the person and the given addresses are busy between two instants. The first answer is always the person (`email: 'self'`); the others are in the order asked, with
 * `visible: false` for a calendar its owner has not shared (the provider's own words are never read). Titles and places of events are never read.
 */
export async function readFreeBusy(api: ProviderApi, provider: ScheduledMeetingProvider, emails: readonly string[], from: string, to: string): Promise<FreeBusyAnswer[]> {
  const window = { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
  const others = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => address.safeParse(e).success);
  const span = (b: unknown): Span => ({ start: str(asRecord(b)['start'], 40) ?? '', end: str(asRecord(b)['end'], 40) ?? '' });
  if (provider === 'google') {
    const doc = asRecord(await api.json('/calendar/v3/freeBusy', { method: 'POST', body: { timeMin: window.start, timeMax: window.end, items: ['primary', ...others].map((id) => ({ id })) } }));
    const answered = new Map(Object.entries(asRecord(doc['calendars'])).map(([k, v]) => [k.toLowerCase(), asRecord(v)]));
    const read = (key: string): { visible: boolean; busy: Span[] } => {
      const entry = answered.get(key);
      const visible = entry !== undefined && asArray(entry['errors']).length === 0;
      return { visible, busy: visible ? mergeBusy(asArray(entry['busy']).slice(0, MAX_BUSY).map(span)) : [] };
    };
    // Google may key the person's own answer by their address rather than by "primary"
    const own = answered.has('primary') ? read('primary') : read([...answered.keys()].find((k) => !others.includes(k)) ?? 'primary');
    return [
      { email: 'self', visible: true, busy: own.busy.map((b) => ({ startsAt: b.start, endsAt: b.end })) },
      ...others.map((email) => {
        const r = read(email);
        return { email, visible: r.visible, busy: r.busy.map((b) => ({ startsAt: b.start, endsAt: b.end })) };
      }),
    ];
  }
  const me = asRecord(await api.json('/me', { query: { $select: 'mail,userPrincipalName' } }));
  const mine = (str(me['mail'], 320) || str(me['userPrincipalName'], 320) || '').toLowerCase();
  if (!address.safeParse(mine).success) throw new ProviderError(502, 'Outlook did not give this account’s address, so free and busy cannot be asked.');
  const ids = [mine, ...others.filter((e) => e !== mine)];
  const doc = asRecord(
    await api.json('/me/calendar/getSchedule', {
      method: 'POST',
      headers: GRAPH_UTC,
      body: { schedules: ids, startTime: { dateTime: window.start.slice(0, 19), timeZone: 'UTC' }, endTime: { dateTime: window.end.slice(0, 19), timeZone: 'UTC' }, availabilityViewInterval: 30 },
    }),
  );
  const answered = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(doc['value']).slice(0, 25)) {
    const r = asRecord(entry);
    const id = str(r['scheduleId'], 320);
    if (id) answered.set(id.toLowerCase(), r);
  }
  const read = (key: string): { visible: boolean; busy: Span[] } => {
    const entry = answered.get(key);
    const visible = entry !== undefined && entry['error'] === undefined && Array.isArray(entry['scheduleItems']);
    const spans = visible
      ? asArray(entry['scheduleItems'])
          .slice(0, MAX_BUSY)
          // free and "working elsewhere" are not busy; the subject and place of an item are never read
          .filter((s) => !['free', 'workingElsewhere'].includes(String(asRecord(s)['status'])))
          .map((s) => ({ start: graphTime(asRecord(s)['start']) ?? '', end: graphTime(asRecord(s)['end']) ?? '' }))
      : [];
    return { visible, busy: mergeBusy(spans) };
  };
  return [
    { email: 'self', visible: true, busy: read(mine).busy.map((b) => ({ startsAt: b.start, endsAt: b.end })) },
    ...others.map((email) => {
      const r = email === mine ? { visible: true, busy: read(mine).busy } : read(email);
      return { email, visible: r.visible, busy: r.busy.map((b) => ({ startsAt: b.start, endsAt: b.end })) };
    }),
  ];
}

export { freeBusyInput };

// ---- registration -----------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Registers the calendar door (`connector.calendar`) and `GET /api/me/calendars`. The door is looked up by the meetings plugin in its own route or job, never at start-up.
 */
export function registerCalendarProvider(ctx: PluginContext): void {
  const deps: OAuthDeps = { db: ctx.db, secrets: ctx.secrets, now: () => ctx.runtime.now(), env: process.env, onNeedsReconnect: createReconnectNotifier(ctx) };
  const provider = createCalendarConnector(deps);
  ctx.providers.register('connector.calendar', provider);

  ctx.http.route({
    ...listMyCalendarsRoute,
    schema: { response: ListMyCalendarsResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      if (tx.actor.kind !== 'person') throw forbidden('Only a person has a calendar of their own.');
      // the person's own sign-ins only (their transaction shows nobody else's); a sign-in that needs signing in again is treated as none
      const own = await ownConnections(tx, tx.actor.id);
      const calendars: ListMyCalendarsResponse['calendars'] = [];
      const needsCalendarAccess: ScheduledMeetingProvider[] = [];
      for (const id of CALENDAR_PROVIDERS) {
        const mine = own.get(id);
        if (!mine || mine.status !== 'enabled' || mine.state !== 'ok') continue;
        if (!hasService(id, 'calendar_write', mine.scopes)) {
          needsCalendarAccess.push(id);
          continue;
        }
        const main = mainCalendar(id, mine.accountLabel);
        calendars.push({ provider: id, calendarId: main.id, name: main.name, primary: main.primary });
      }
      return json(ListMyCalendarsResponse.parse({ calendars, needsCalendarAccess }));
    }),
  });
}
