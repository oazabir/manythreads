import { nextCronRun, parseCron } from '../common/cron.ts';

// Schedules in plain words and in a person's own time zone (PLAN P20-11). The platform stores a schedule as a 5-field cron expression in UTC; a person
// thinks "every weekday at 7" in the zone they live in. These pure helpers go both ways and know the zone's offset on the day in question (daylight saving
// included). They handle the shapes people actually write; anything else is left as "Custom schedule" and the person edits the proposal by hand.
//
// Note on daylight saving: a stored UTC cron has one offset baked in. A routine made in a zone that observes daylight saving drifts by an hour for part of
// the year; the screen says so ("kept at 07:00 until the clocks change") and `localTimeOfNextRun` lets a caller show the real local time of the next run.

const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** True for a zone name the platform's time library knows (`Asia/Dubai`, `UTC`). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
}

/** The wall-clock parts of an instant in a zone. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const get: Record<string, string> = {};
  for (const p of f.formatToParts(at)) get[p.type] = p.value;
  return {
    year: Number(get['year']),
    month: Number(get['month']),
    day: Number(get['day']),
    hour: Number(get['hour']) % 24,
    minute: Number(get['minute']),
    dow: DOW_SHORT.indexOf(get['weekday'] as (typeof DOW_SHORT)[number]),
  };
}

/** Minutes the zone is ahead of UTC at that instant (Dubai: 240; New York in winter: -300). */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant a wall-clock time happens in a zone (the first one when the clocks repeat it, the one after the gap when they skip it). */
export function zonedTimeToUtc(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - zoneOffsetMinutes(timeZone, new Date(guess)) * 60_000;
  t = guess - zoneOffsetMinutes(timeZone, new Date(t)) * 60_000;
  return new Date(t);
}

export interface LocalSchedule {
  minute: number;
  hour: number;
  /** Days of the week, 0 = Sunday; null = every day. */
  dow: readonly number[] | null;
}

/** The UTC cron for a local time of day on some days, using the zone's offset at `at` (default: now). */
export function localScheduleToCron(s: LocalSchedule, timeZone: string, at: Date = new Date()): string {
  const total = s.hour * 60 + s.minute - zoneOffsetMinutes(timeZone, at);
  const shift = Math.floor(total / 1440);
  const inDay = ((total % 1440) + 1440) % 1440;
  const days = s.dow === null ? '*' : [...new Set(s.dow.map((d) => (((d + shift) % 7) + 7) % 7))].sort((a, b) => a - b).join(',');
  return `${inDay % 60} ${Math.floor(inDay / 60)} * * ${compactDays(days)}`;
}

function compactDays(days: string): string {
  if (days === '*') return '*';
  const list = days.split(',').map(Number);
  const key = list.join(',');
  if (key === '1,2,3,4,5') return '1-5';
  return key;
}

const clock = (h: number, m: number): string => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

function daysWords(days: readonly number[] | null): string {
  if (days === null || days.length === 7) return 'Every day';
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (days.length === 1) return `Every ${capital(DOW_NAMES[days[0] as number] as string)}`;
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW_SHORT[d]).join(', ');
}
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Weekdays a cron's day-of-week field names, or null for `*`; undefined when it is something this module does not describe. */
function dowList(field: string): number[] | null | undefined {
  if (field === '*') return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return undefined;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo > 7 || hi > 7 || lo > hi) return undefined;
    for (let d = lo; d <= hi; d++) out.add(d % 7);
  }
  return [...out];
}

/**
 * A UTC cron in plain words, in the zone: "Weekdays at 7:00 AM", "Every Monday at 9:00 AM", "Every 30 minutes", "Every hour". The zone's offset on `at`
 * is used for the time of day. An expression this module does not describe comes back as "Custom schedule" so the screen never shows a wrong sentence.
 */
export function cronToWords(cron: string, timeZone: string, at: Date = new Date()): string {
  try {
    parseCron(cron);
  } catch {
    return 'Custom schedule';
  }
  const [min, hour, dom, month, dow] = cron.trim().split(/\s+/) as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === '*' && dom === '*' && month === '*' && dow === '*') return Number(every[1]) === 1 ? 'Every minute' : `Every ${every[1]} minutes`;
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') return min === '0' ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && everyHours && dom === '*' && month === '*' && dow === '*') return `Every ${everyHours[1]} hours`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || month !== '*') return 'Custom schedule';
  const offset = zoneOffsetMinutes(timeZone, at);
  const local = Number(hour) * 60 + Number(min) + offset;
  const shift = Math.floor(local / 1440);
  const inDay = ((local % 1440) + 1440) % 1440;
  const time = clock(Math.floor(inDay / 60), inDay % 60);
  if (dom !== '*') {
    if (!/^\d+$/.test(dom) || dow !== '*' || shift !== 0) return 'Custom schedule';
    return `On day ${dom} of each month at ${time}`;
  }
  const days = dowList(dow);
  if (days === undefined) return 'Custom schedule';
  const localDays = days === null ? null : days.map((d) => (((d + shift) % 7) + 7) % 7);
  return `${daysWords(localDays)} at ${time}`;
}

/** The smallest gap, in minutes, between two runs of a cron over its next 200 runs; null when it never runs twice. */
export function minGapMinutes(cron: string, from: Date = new Date()): number | null {
  let prev = nextCronRun(cron, from);
  let best: number | null = null;
  for (let i = 0; i < 200 && prev; i++) {
    const next = nextCronRun(cron, prev);
    if (!next) break;
    const gap = Math.round((next.getTime() - prev.getTime()) / 60_000);
    if (best === null || gap < best) best = gap;
    prev = next;
  }
  return best;
}

/** The first time of day in a sentence ("7", "7am", "7:30 pm", "18:30", "noon"), or null. Hours without am/pm are read as written (0 to 23). */
function timeOfDay(text: string): { hour: number; minute: number } | null {
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 };
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\d)/.exec(text.replace(/\b(\d{1,2})\s*o'?clock/g, '$1'));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const mer = m[3]?.replace(/\./g, '');
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export interface ParsedSchedule {
  cron: string;
  words: string;
  /** What was assumed, in plain words ("no time was given, so 9:00 AM"). */
  notes: string[];
}

/**
 * Read the schedule out of a sentence, by plain rules (no model): "every weekday at 7", "each Monday at 9am", "daily at 18:30", "every 30 minutes", "every hour",
 * "every Friday at 4pm". Returns null when no schedule can be told. Used when the model is not available, and by tests as the reference reading.
 */
export function wordsToSchedule(sentence: string, timeZone: string, at: Date = new Date()): ParsedSchedule | null {
  const text = sentence.toLowerCase();
  const notes: string[] = [];
  const mins = /\bevery\s+(\d{1,3})\s*(minutes?|mins?)\b/.exec(text);
  if (mins) {
    const n = Number(mins[1]);
    if (n >= 1 && n <= 59) return { cron: `*/${n} * * * *`, words: cronToWords(`*/${n} * * * *`, timeZone, at), notes };
  }
  const hours = /\bevery\s+(\d{1,2})\s*hours?\b/.exec(text);
  if (hours) {
    const n = Number(hours[1]);
    if (n >= 1 && n <= 23) return { cron: `0 */${n} * * *`, words: `Every ${n} hours`, notes };
  }
  if (/\b(every|each)\s+hour\b|\bhourly\b/.test(text)) return { cron: '0 * * * *', words: 'Every hour', notes };

  let dow: number[] | null = null;
  if (/\bweekdays?\b|\bworking days?\b|\bmonday (to|through|-) friday\b/.test(text)) dow = [...WEEKDAYS];
  else if (/\bweekends?\b/.test(text)) dow = [0, 6];
  else {
    const named = DOW_NAMES.map((n, i) => (new RegExp(`\\b${n}s?\\b|\\b${n.slice(0, 3)}\\b`).test(text) ? i : -1)).filter((i) => i >= 0);
    if (named.length > 0) dow = named;
    else if (!/\b(every day|daily|each day|every morning|every evening|every night|every afternoon)\b/.test(text)) {
      if (!/\bevery\b|\beach\b|\bdaily\b|\bweekly\b/.test(text)) return null;
    }
  }
  let t = timeOfDay(text);
  if (t === null) {
    if (/\bmorning\b/.test(text)) t = { hour: 8, minute: 0 };
    else if (/\bafternoon\b/.test(text)) t = { hour: 14, minute: 0 };
    else if (/\bevening\b/.test(text)) t = { hour: 18, minute: 0 };
    else if (/\bnight\b/.test(text)) t = { hour: 21, minute: 0 };
    else {
      t = { hour: 9, minute: 0 };
      notes.push('No time was given, so it is set to 9:00 AM.');
    }
  }
  if (/\bweekly\b/.test(text) && dow === null) {
    dow = [1];
    notes.push('“Weekly” is set to Monday.');
  }
  const cron = localScheduleToCron({ hour: t.hour, minute: t.minute, dow }, timeZone, at);
  return { cron, words: cronToWords(cron, timeZone, at), notes };
}

export interface QuietHours {
  from: string;
  to: string;
}
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when `at` falls inside the quiet window in the zone. The window includes `from` and excludes `to`, and may cross midnight. */
export function inQuietHours(at: Date, timeZone: string, quiet: QuietHours | null): boolean {
  if (quiet === null) return false;
  const p = localParts(at, timeZone);
  const now = p.hour * 60 + p.minute;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The first instant at or after `at` that is outside the quiet window (the window's end today or tomorrow, in the zone). */
export function quietHoursEnd(at: Date, timeZone: string, quiet: QuietHours): Date {
  if (!inQuietHours(at, timeZone, quiet)) return at;
  const to = minutesOf(quiet.to);
  const p = localParts(at, timeZone);
  const now = p.hour * 60 + p.minute;
  const base = Date.UTC(p.year, p.month - 1, p.day);
  const dayOffset = to > now ? 0 : 1;
  const d = new Date(base + dayOffset * 86_400_000);
  return zonedTimeToUtc(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(to / 60), to % 60);
}

/** The next run of a cron as a local wall-clock time in the zone ("Mon 7:00 AM"), or null. */
export function localTimeOfNextRun(cron: string, timeZone: string, from: Date = new Date()): string | null {
  const next = nextCronRun(cron, from);
  if (!next) return null;
  const p = localParts(next, timeZone);
  return `${DOW_SHORT[p.dow]} ${clock(p.hour, p.minute)}`;
}
