import { minutesOf, type CustomStatus, type DndSettings, type DndState, type DndWindow, type OutOfOffice, type WorkingHours } from './presence.ts';

// Pure clock rules for presence (PLAN P14-01): what time it is for someone else, whether they are within their working hours, and whether
// Do not disturb is on. They run in the server (the notifications plugin holds messages by them) and in the browser (the profile card), so a
// weekly schedule means the same thing on both sides. Time zones come from the runtime's database through `Intl`, so daylight saving shifts
// are applied for the date asked about, never guessed from a fixed offset.

const formatters = new Map<string, Intl.DateTimeFormat>();
function clockFormat(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, f);
  }
  return f;
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The weekday (0 = Sunday) and minutes after midnight that it is in `zone` at `at`. */
export function localClock(at: Date, zone: string): { weekday: number; minutes: number } {
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of clockFormat(zone).formatToParts(at)) {
    if (part.type === 'weekday') weekday = WEEKDAY[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

/** `14:32`: the time of day in `zone`, for "Their time". */
export function localTimeText(at: Date, zone: string): string {
  const { minutes } = localClock(at, zone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Is `at` within these working hours, as the clock reads in `zone`? */
export function withinWorkingHours(hours: WorkingHours, zone: string, at: Date): boolean {
  const { weekday, minutes } = localClock(at, zone);
  return hours.days.includes(weekday) && minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end);
}

/** Is a quiet period running at this local weekday and minute? An overnight window carries into the morning of the next day. */
function windowActive(w: DndWindow, weekday: number, minutes: number): boolean {
  const [start, end] = [minutesOf(w.start), minutesOf(w.end)];
  if (start < end) return w.days.includes(weekday) && minutes >= start && minutes < end;
  return (w.days.includes(weekday) && minutes >= start) || (w.days.includes((weekday + 6) % 7) && minutes < end);
}

function scheduleActive(windows: readonly DndWindow[], zone: string, at: Date): boolean {
  const { weekday, minutes } = localClock(at, zone);
  return windows.some((w) => windowActive(w, weekday, minutes));
}

const MINUTE = 60_000;
/** A schedule that is still running after this long is reported as having no end. */
const SCHEDULE_SCAN_LIMIT_MINUTES = 7 * 24 * 60;

/** When a running schedule next stops: scans forward a minute at a time (the clock may jump at a daylight saving change). */
function scheduleEnd(windows: readonly DndWindow[], zone: string, at: Date): Date | null {
  const first = Math.floor(at.getTime() / MINUTE) * MINUTE;
  for (let i = 1; i <= SCHEDULE_SCAN_LIMIT_MINUTES; i += 1) {
    const t = new Date(first + i * MINUTE);
    if (!scheduleActive(windows, zone, t)) return t;
  }
  return null;
}

/**
 * Whether Do not disturb is on at `at`, with the reason and the end. Switched on by hand beats a pause, and a pause beats the schedule;
 * a time zone of `null` reads the schedule in UTC. Pass `withEnd: false` to skip finding the end of a schedule (the notifications plugin
 * asks only "is it on?" for every message it writes).
 */
export function dndState(settings: DndSettings, zone: string | null, at: Date, withEnd = true): DndState {
  if (settings.enabled) return { active: true, reason: 'manual', until: null };
  if (settings.pausedUntil !== null && Date.parse(settings.pausedUntil) > at.getTime()) {
    return { active: true, reason: 'paused', until: settings.pausedUntil };
  }
  const { schedule } = settings;
  const where = zone ?? 'UTC';
  if (schedule.enabled && scheduleActive(schedule.windows, where, at)) {
    const end = withEnd ? scheduleEnd(schedule.windows, where, at) : null;
    return { active: true, reason: 'schedule', until: end ? end.toISOString() : null };
  }
  return { active: false, reason: null, until: null };
}

/** The status to show: `null` once its clear time has passed. */
export function liveStatus(status: CustomStatus | null, at: Date): CustomStatus | null {
  if (status === null) return null;
  if (status.clearsAt !== null && Date.parse(status.clearsAt) <= at.getTime()) return null;
  return status;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
/** The calendar date `YYYY-MM-DD` it is in `zone` at `at`. */
export function localDate(at: Date, zone: string): string {
  let f = dateFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(zone, f);
  }
  return f.format(at);
}

/** The out-of-office note to show: `null` when it is off, or when the person's first day back (in their time zone) has come. */
export function liveOutOfOffice(note: OutOfOffice | null, zone: string | null, at: Date): OutOfOffice | null {
  if (note === null || !note.active) return null;
  if (note.returnsOn !== null && localDate(at, zone ?? 'UTC') >= note.returnsOn) return null;
  return note;
}
