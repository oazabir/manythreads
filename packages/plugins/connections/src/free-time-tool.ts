import { z } from 'zod';
import { readFreeBusy } from './calendar-provider.ts';
import { DAY, freeGaps, mergeBusy, oneLine, type PersonToolDef, type Span } from './person-kit.ts';

// Work package C (P16-05, decision D11): the person tool `calendar.find_free_time` ("when are Nadia and I both free?").
//
//   * The model gives NAMES (or @handles), never addresses. A name is turned into a person by the definer function `app.connections_resolve_people`, which answers only active
//     members who share a team with the asker (run in the asker's own transaction). A name that matches nobody, or nobody the asker shares a team with, is answered
//     "I could not find that person"; a name that matches several is answered with their display names so the asker can say which. An address of a person is used only to
//     ask the calendar and is never put in the answer.
//   * The asker's own sign-in asks the provider (Google, else Microsoft 365: whichever the asker has connected with "free and busy" agreed). Nothing is asked with anybody
//     else's grant. A calendar its owner did not share is answered as `notVisible` (the name, nothing else); the provider's own words are never read.
//   * Free time is looked for inside working hours, 09:00 to 18:00 Monday to Friday in the asker's time zone (their profile; UTC when they have none), from the next quarter
//     hour. The slots are data for the model to propose; nothing is booked here.

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;
const MAX_SLOTS = 10;
const MAX_PER_DAY = 3;

export const FreeTimeInput = z.strictObject({
  with: z.array(z.string().min(1).max(80)).min(1).max(5).describe('Names (or @handles) of the people to meet with, as the asker said them. Never an address.'),
  withinDays: z.number().int().min(1).max(14).describe('How many days ahead to look (default 7).').optional(),
  minutes: z.number().int().min(15).max(240).describe('How long the meeting should be, in minutes (default 30).').optional(),
});

// ---- time zones, without a library --------------------------------------------------------------------------------------------------------------------------

/** The zone if the platform knows it, else UTC. */
export function validZone(zone: string | null | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** How far the zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall clock (year, month, day, hour in the zone) shows. Twice, so a change of clocks near the time is followed. */
export function zonedInstant(year: number, month: number, day: number, hour: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetAt(guess, zone);
  return guess - offsetAt(first, zone);
}

/** The calendar day (and weekday, 0 = Sunday) an instant falls on in the zone. */
function dayOf(instant: number, zone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(instant));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const year = n('year');
  const month = n('month');
  const day = n('day');
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** The working-hours windows (Monday to Friday, 09:00-18:00 in the zone) that touch [from, to], clipped to it. */
export function workingWindows(from: number, to: number, zone: string): Span[] {
  const out: Span[] = [];
  // start a day early so a zone ahead of UTC does not lose its first morning, and stop when the window is passed
  let cursor = from - DAY;
  for (let guard = 0; guard < 20 && cursor < to + DAY; guard++, cursor += DAY) {
    const d = dayOf(cursor, zone);
    if (d.weekday === 0 || d.weekday === 6) continue;
    const a = Math.max(zonedInstant(d.year, d.month, d.day, WORK_START_HOUR, zone), from);
    const b = Math.min(zonedInstant(d.year, d.month, d.day, WORK_END_HOUR, zone), to);
    if (b > a && !out.some((w) => w.start === new Date(a).toISOString())) out.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString() });
  }
  return out;
}

const QUARTER = 15 * 60_000;
const roundUpToQuarter = (t: number): number => Math.ceil(t / QUARTER) * QUARTER;

// ---- the people ----------------------------------------------------------------------------------------------------------------------------------------------------

type Match = { name_key: string; person_id: string; display_name: string; email: string };

/** Slots of free time for everyone asked, from the busy spans of those whose calendars could be read. Exported for the tests. */
export function freeSlots(busy: readonly Span[], windows: readonly Span[], minutes: number): Span[] {
  const merged = mergeBusy(busy);
  const out: Span[] = [];
  for (const w of windows) {
    const perDay = freeGaps(merged, w, minutes, MAX_PER_DAY).map((g) => {
      // a slot starts on a quarter hour so the proposal reads naturally
      const a = roundUpToQuarter(Date.parse(g.start));
      return Date.parse(g.end) - a >= minutes * 60_000 ? { start: new Date(a).toISOString(), end: g.end } : null;
    });
    for (const slot of perDay) if (slot && out.length < MAX_SLOTS) out.push(slot);
  }
  return out;
}

export const FREE_TIME_TOOLS: PersonToolDef[] = [
  {
    name: 'calendar.find_free_time',
    provider: 'google',
    alsoProviders: ['microsoft'],
    service: 'calendar_free_busy',
    kind: 'read',
    description:
      'Find times when the asking person and the people they name are all free, using the asker’s own Google or Microsoft 365 calendar (only free and busy, never what an event is about). Give names or @handles, not addresses; only people who share a team with the asker can be found. Looks inside working hours (09:00-18:00, Monday to Friday, in the asker’s time zone). Answers `slots` (start and end), `notVisible` (people whose calendar is not shared, so they were left out), `notFound` and `ambiguous` (names to ask the asker about). Nothing is booked.',
    input: FreeTimeInput,
    async run(api, input, context) {
      // the context is the run's own (source.ts always gives it); a caller without one cannot resolve names
      if (!context) return { ok: false, code: 'unavailable', message: 'This tool needs the run of the person who asked.' };
      const i = input as z.infer<typeof FreeTimeInput>;
      const withinDays = i.withinDays ?? 7;
      const minutes = i.minutes ?? 30;

      // 1. names -> people (the asker's transaction: only people who share a team with them)
      const asked = [...new Set(i.with.map((n) => n.replace(/\s+/g, ' ').trim()).filter((n) => n !== ''))].slice(0, 5);
      const resolved = await context.tx.query<Match>('SELECT name_key, person_id, display_name, email FROM app.connections_resolve_people($1::text[])', [asked]);
      const byKey = new Map<string, Match[]>();
      for (const m of resolved.rows) byKey.set(m.name_key, [...(byKey.get(m.name_key) ?? []), m]);
      const keyOf = (n: string): string => n.replace('@', '').trim().toLowerCase();
      const found: Match[] = [];
      const notFound: string[] = [];
      const ambiguous: Array<{ name: string; candidates: string[] }> = [];
      for (const name of asked) {
        const matches = byKey.get(keyOf(name)) ?? [];
        if (matches.length === 0) notFound.push(oneLine(name, 80));
        else if (matches.length > 1) ambiguous.push({ name: oneLine(name, 80), candidates: matches.map((m) => oneLine(m.display_name, 80)) });
        else found.push(matches[0]!);
      }
      // the same person named twice is asked about once
      const people = [...new Map(found.map((m) => [m.person_id, m])).values()];
      if (people.length === 0) {
        return { ok: true, slots: [], people: [], notVisible: [], notFound, ambiguous, note: notFound.length > 0 ? 'I could not find that person among the people who share a team with the asker.' : 'Ask the asker which person they mean.' };
      }

      // 2. the asker's time zone (their profile; UTC without one)
      const zone = validZone(
        (await context.tx.query<{ time_zone: string | null }>(`SELECT ps.time_zone FROM app.person_status ps JOIN app.actors a ON a.kind = 'person' AND a.ref_id = ps.person_id WHERE a.id = $1`, [context.tx.actor.id])).rows[0]?.time_zone,
      );

      // 3. free and busy, with the asker's own sign-in
      const from = roundUpToQuarter(api.now().getTime());
      const to = from + withinDays * DAY;
      if (context.provider !== 'google' && context.provider !== 'microsoft') return { ok: false, code: 'unavailable', message: 'That service has no calendar.' };
      const answers = await readFreeBusy(api, context.provider, people.map((p) => p.email), new Date(from).toISOString(), new Date(to).toISOString());
      const self = answers.find((a) => a.email === 'self');
      const theirs = new Map(answers.filter((a) => a.email !== 'self').map((a) => [a.email.toLowerCase(), a]));
      const notVisible: string[] = [];
      const busy: Span[] = (self?.busy ?? []).map((b) => ({ start: b.startsAt, end: b.endsAt }));
      for (const p of people) {
        const a = theirs.get(p.email.toLowerCase());
        if (!a || !a.visible) notVisible.push(oneLine(p.display_name, 80));
        else for (const b of a.busy) busy.push({ start: b.startsAt, end: b.endsAt });
      }

      // 4. the gaps inside working hours
      const slots = freeSlots(busy, workingWindows(from, to, zone), minutes);
      return {
        ok: true,
        zone,
        workingHours: `${String(WORK_START_HOUR).padStart(2, '0')}:00-${String(WORK_END_HOUR)}:00, Monday to Friday, in the asker’s time zone`,
        minutes,
        people: people.map((p) => oneLine(p.display_name, 80)),
        slots: slots.map((s) => ({ start: s.start, end: s.end })),
        notVisible,
        notFound,
        ambiguous,
        note:
          notVisible.length > 0
            ? `${notVisible.join(', ')} ${notVisible.length === 1 ? 'has' : 'have'} not shared a calendar, so the slots only take account of the others.`
            : slots.length === 0
              ? 'There is no time when everyone is free in that period. Try a longer period or a shorter meeting.'
              : null,
      };
    },
  },
];
