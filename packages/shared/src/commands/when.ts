/*
 * Reading a time written in words (PLAN P14-04): "in 20 minutes", "at 15:30", "tomorrow at 9", "monday", "next week", "on 2026-12-01 at 10:00".
 * A fixed grammar read left to right, no model and no guessing: a time that could mean two things, that does not exist, or that is already
 * past is refused with a sentence that says what to write instead.
 *
 * Linear time. The text is cut into at most MAX_WORDS words, each word is looked at once with character codes (no regular expression, so there is
 * nothing to backtrack), and a word longer than MAX_WORD characters can never be a part of a time and is judged by its length alone. A hostile
 * text of any length costs one pass over the words it reads, and the rest of the text is only sliced, never scanned.
 *
 * Time zones: the caller passes the zone (an IANA name such as "Asia/Karachi") and "now"; the rules are applied to the wall clock of that zone.
 * "Tomorrow" and a weekday mean 9:00 when no clock time is given, like the preset times of the Later menu.
 */

const MAX_WORDS = 7;
const MAX_WORD = 24;
/** The longest span of time written as a count of minutes, hours, days or weeks (a year, which is also the longest reminder). */
const MAX_COUNT = 1000;
const DEFAULT_HOUR = 9;

export type WhenParse = { ok: true; at: Date; rest: string; phrase: string } | { ok: false; reason: string };

export const WHEN_USAGE =
  'Say when first: “in 20 minutes”, “in 2h”, “at 15:30”, “tomorrow at 9”, “monday”, “next week” or “on 2026-12-01 at 10:00”.';

type Word = { s: number; e: number };

/** The first MAX_WORDS words (runs of non-blank characters) of `text`, as ranges. One pass over the characters they cover. */
function words(text: string): Word[] {
  const out: Word[] = [];
  const n = text.length;
  let i = 0;
  while (i < n && out.length < MAX_WORDS) {
    while (i < n && isBlank(text.charCodeAt(i))) i += 1;
    if (i >= n) break;
    const s = i;
    while (i < n && !isBlank(text.charCodeAt(i))) i += 1;
    out.push({ s, e: i });
  }
  return out;
}

function isBlank(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** The lower-cased text of a word, or '' when it is too long to be part of a time. */
function lower(text: string, w: Word | undefined): string {
  if (!w || w.e - w.s > MAX_WORD) return '';
  return text.slice(w.s, w.e).toLowerCase();
}

// ---- durations -------------------------------------------------------------------------------------------------------------------

/** A value of a word table, only when the word is one of the table's own keys (a plain object also answers `constructor`, `toString` and `__proto__`). */
function own<T>(table: Readonly<Record<string, T>>, word: string): T | undefined {
  return Object.hasOwn(table, word) ? table[word] : undefined;
}

type Unit = 'minute' | 'hour' | 'day' | 'week';
const UNITS: Record<string, Unit> = {
  m: 'minute', min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
  h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour',
  d: 'day', day: 'day', days: 'day',
  w: 'week', wk: 'week', wks: 'week', week: 'week', weeks: 'week',
};
const UNIT_MINUTES: Record<Unit, number> = { minute: 1, hour: 60, day: 1440, week: 10080 };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export const DURATION_USAGE = 'Write a length of time like “30m”, “2h”, “1 day” or “2 weeks”.';

type Duration = { ok: true; minutes: number; used: number } | { ok: false; reason: string };

/** Reads a count and a unit from the words starting at `at` ("20 minutes", "2h", "an hour"); `used` is how many words it took. */
function readDuration(text: string, ws: Word[], at: number): Duration {
  const first = ws[at];
  if (!first) return { ok: false, reason: DURATION_USAGE };
  const w = lower(text, first);
  if (w === '') return { ok: false, reason: DURATION_USAGE };
  // "20m", "2h": digits and then the unit in one word
  let k = 0;
  while (k < w.length && isDigit(w.charCodeAt(k))) k += 1;
  let count: number;
  let unitWord: string;
  let used: number;
  if (k > 0 && k < w.length) {
    count = Number(w.slice(0, k));
    unitWord = w.slice(k);
    used = 1;
  } else {
    // "20 minutes", "an hour"
    count = k === w.length && k > 0 ? Number(w) : (own(NUMBER_WORDS, w) ?? Number.NaN);
    unitWord = lower(text, ws[at + 1]);
    used = 2;
  }
  if (!Number.isFinite(count)) return { ok: false, reason: DURATION_USAGE };
  if (unitWord === '') return { ok: false, reason: DURATION_USAGE };
  const unit = own(UNITS, unitWord);
  if (!unit) {
    return { ok: false, reason: unitWord === 's' || unitWord === 'sec' || unitWord === 'secs' || unitWord.startsWith('second') ? 'Times are set in whole minutes or longer. Use minutes, hours, days or weeks.' : DURATION_USAGE };
  }
  if (count < 1) return { ok: false, reason: 'A length of time must be at least one minute.' };
  if (count > MAX_COUNT) return { ok: false, reason: 'That is too long. Reminders can be set at most a year ahead.' };
  return { ok: true, minutes: count * UNIT_MINUTES[unit], used };
}

/** A whole text that is one length of time ("45m", "2 hours"), for commands such as `/dnd 2h`. */
export function parseDurationOnly(input: string): { ok: true; minutes: number } | { ok: false; reason: string } {
  const text = input.trim();
  if (text === '') return { ok: false, reason: DURATION_USAGE };
  const ws = words(text);
  const d = readDuration(text, ws, 0);
  if (!d.ok) return d;
  const last = ws[d.used - 1];
  if (last && text.slice(last.e).trim() !== '') return { ok: false, reason: DURATION_USAGE };
  return { ok: true, minutes: d.minutes };
}

// ---- the wall clock of a zone ----------------------------------------------------------------------------------------------------

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

type Zone = { wall(ms: number): Wall; offset(ms: number): number };

function makeZone(timeZone: string): Zone | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch {
    return null;
  }
  const wall = (ms: number): Wall => {
    const out: Wall = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
    for (const p of fmt.formatToParts(new Date(ms))) {
      const v = Number(p.value);
      if (p.type === 'year') out.y = v;
      else if (p.type === 'month') out.mo = v;
      else if (p.type === 'day') out.d = v;
      else if (p.type === 'hour') out.h = v === 24 ? 0 : v;
      else if (p.type === 'minute') out.mi = v;
      else if (p.type === 'second') out.s = v;
    }
    return out;
  };
  const offset = (ms: number): number => {
    const w = wall(ms);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  };
  return { wall, offset };
}

type Resolved = { ok: true; ms: number } | { ok: false; reason: string };

const DAY_MS = 86_400_000;

/**
 * The instant at which the wall clock of `zone` reads y-mo-d h:mi. A time the clocks skip (spring forward) does not exist and a time they repeat
 * (fall back) happens twice: both are refused, never guessed.
 */
function wallToInstant(zone: Zone, y: number, mo: number, d: number, h: number, mi: number): Resolved {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  const found = new Set<number>();
  for (const o of new Set([zone.offset(naive - DAY_MS), zone.offset(naive + DAY_MS)])) {
    const t = naive - o;
    const w = zone.wall(t);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi) found.add(t);
  }
  if (found.size === 0) return { ok: false, reason: 'That time does not exist on that day in your time zone, because the clocks change. Pick another time.' };
  if (found.size > 1) return { ok: false, reason: 'That time happens twice on that day in your time zone, because the clocks change. Pick another time.' };
  return { ok: true, ms: [...found][0]! };
}

// ---- clock times -------------------------------------------------------------------------------------------------------------------

type Clock = { ok: true; h: number; mi: number; used: number } | { ok: false; reason: string };

const CLOCK_USAGE = 'Write the time like 15:30, 3pm or 9:00.';
export const AMBIGUOUS_HOUR = (shown: string): string => `“${shown}” could be the morning or the afternoon. Write ${shown}am or ${shown}pm, or the 24-hour time with a leading zero.`;

/**
 * Reads a clock time at word `at`: `15:30`, `9:05`, `3pm`, `3:30pm`, `3 pm`, `noon`, or a bare hour from 8 to 23 (`9` is 9:00). An hour from 1 to 7
 * with no am or pm is ambiguous (morning or afternoon) unless it is written with a leading zero and minutes (`07:30`).
 */
function readClock(text: string, ws: Word[], at: number): Clock {
  const w = lower(text, ws[at]);
  if (w === '') return { ok: false, reason: CLOCK_USAGE };
  if (w === 'noon') return { ok: true, h: 12, mi: 0, used: 1 };
  let i = 0;
  const n = w.length;
  while (i < n && isDigit(w.charCodeAt(i))) i += 1;
  const hourDigits = i;
  if (hourDigits === 0 || hourDigits > 2) return { ok: false, reason: CLOCK_USAGE };
  const hour = Number(w.slice(0, hourDigits));
  let mi = 0;
  let colon = false;
  if (w[i] === ':') {
    colon = true;
    const ms = i + 1;
    let j = ms;
    while (j < n && isDigit(w.charCodeAt(j))) j += 1;
    if (j - ms !== 2) return { ok: false, reason: CLOCK_USAGE };
    mi = Number(w.slice(ms, j));
    if (mi > 59) return { ok: false, reason: CLOCK_USAGE };
    i = j;
  }
  let suffix = w.slice(i);
  let used = 1;
  if (suffix === '') {
    // "3 pm": the suffix is the next word
    const next = lower(text, ws[at + 1]);
    if (next === 'am' || next === 'pm' || next === 'a.m.' || next === 'p.m.') {
      suffix = next;
      used = 2;
    }
  }
  const ampm = suffix === 'am' || suffix === 'a.m.' ? 'am' : suffix === 'pm' || suffix === 'p.m.' ? 'pm' : '';
  if (suffix !== '' && ampm === '') return { ok: false, reason: CLOCK_USAGE };
  if (ampm !== '') {
    if (hour < 1 || hour > 12) return { ok: false, reason: CLOCK_USAGE };
    return { ok: true, h: (hour % 12) + (ampm === 'pm' ? 12 : 0), mi, used };
  }
  if (hour > 23) return { ok: false, reason: CLOCK_USAGE };
  const leadingZero = colon && hourDigits === 2 && w.charCodeAt(0) === 48;
  if (hour >= 1 && hour <= 7 && !leadingZero) return { ok: false, reason: AMBIGUOUS_HOUR(colon ? `${hour}:${w.slice(hourDigits + 1, hourDigits + 3)}` : String(hour)) };
  // a bare 0 has no colon to say it is a clock time at all
  if (hour === 0 && !colon) return { ok: false, reason: CLOCK_USAGE };
  return { ok: true, h: hour, mi, used };
}

/** An optional clock after a day word: `at 9`, or a time that cannot be anything else (`9:30`, `3pm`). Returns the default when none follows. */
function clockAfter(text: string, ws: Word[], at: number): Clock | { ok: true; h: number; mi: number; used: 0 } {
  const w = lower(text, ws[at]);
  if (w === 'at') {
    const c = readClock(text, ws, at + 1);
    return c.ok ? { ...c, used: c.used + 1 } : c;
  }
  // without "at", only a word that can be nothing but a time counts (`9:30`, `3pm`, `noon`); anything else starts the reminder text
  const clearlyATime = w === 'noon' || (isDigit(w.charCodeAt(0)) && (w.includes(':') || w.endsWith('am') || w.endsWith('pm')));
  if (clearlyATime) return readClock(text, ws, at);
  return { ok: true, h: DEFAULT_HOUR, mi: 0, used: 0 };
}

// ---- days ----------------------------------------------------------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** `YYYY-MM-DD` as a calendar date, or null when the word is not one (or not a real day). */
function readDate(w: string): { y: number; mo: number; d: number } | null {
  if (w.length !== 10 || w[4] !== '-' || w[7] !== '-') return null;
  for (let i = 0; i < 10; i += 1) {
    if (i === 4 || i === 7) continue;
    if (!isDigit(w.charCodeAt(i))) return null;
  }
  const y = Number(w.slice(0, 4));
  const mo = Number(w.slice(5, 7));
  const d = Number(w.slice(8, 10));
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d) return null;
  return { y, mo, d };
}

/** The calendar date `days` after y-mo-d. */
function addDays(y: number, mo: number, d: number, days: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const weekdayOf = (y: number, mo: number, d: number): number => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

// ---- the reader ---------------------------------------------------------------------------------------------------------------------

/**
 * Reads the time at the start of `input` and returns it with the text that follows (`rest`). Forms: `in <n> <unit>` (minutes, hours, days,
 * weeks; `in 2h`), `at <clock>` (today), `today at <clock>`, `tomorrow [at <clock>]`, `[next] <weekday> [at <clock>]` (always the next one after
 * today), `next week` (next Monday), `[on] YYYY-MM-DD [at <clock>]`. With no clock the time is 9:00. `now` is the current instant, `timeZone` an
 * IANA name. The result is an exact instant; whether it is far enough ahead is the caller's check (`checkRemindAt`), except that a time earlier
 * today or on a given date that has passed is refused here with a sentence of its own.
 */
export function parseWhen(input: string, now: Date, timeZone: string): WhenParse {
  const ws = words(input);
  const first = lower(input, ws[0]);
  if (first === '') return { ok: false, reason: WHEN_USAGE };
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'The clock of this page is not readable.' };

  const done = (ms: number, used: number): WhenParse => {
    const last = ws[used - 1]!;
    return { ok: true, at: new Date(ms), rest: input.slice(last.e).trim(), phrase: input.slice(ws[0]!.s, last.e) };
  };

  // relative: no zone needed
  if (first === 'in') {
    const d = readDuration(input, ws, 1);
    if (!d.ok) return d;
    return done(nowMs + d.minutes * 60_000, d.used + 1);
  }

  const zone = makeZone(timeZone);
  if (!zone) return { ok: false, reason: 'Your time zone is not known to this browser. Use “in 20 minutes” instead.' };
  const today = zone.wall(nowMs);

  const atDay = (day: { y: number; mo: number; d: number }, clock: { h: number; mi: number }, used: number): WhenParse => {
    const r = wallToInstant(zone, day.y, day.mo, day.d, clock.h, clock.mi);
    if (!r.ok) return r;
    return done(r.ms, used);
  };

  if (first === 'at') {
    const c = readClock(input, ws, 1);
    if (!c.ok) return c;
    const r = wallToInstant(zone, today.y, today.mo, today.d, c.h, c.mi);
    if (!r.ok) return r;
    if (r.ms < nowMs - 60_000) return { ok: false, reason: 'That time has already passed today. Say “tomorrow at …” or give a date.' };
    return done(r.ms, 1 + c.used);
  }

  if (first === 'today') {
    const c = clockAfter(input, ws, 1);
    if (!c.ok) return c;
    if (c.used === 0) return { ok: false, reason: 'Say what time today, for example “today at 15:00”.' };
    const r = wallToInstant(zone, today.y, today.mo, today.d, c.h, c.mi);
    if (!r.ok) return r;
    if (r.ms < nowMs - 60_000) return { ok: false, reason: 'That time has already passed today. Say “tomorrow at …” or give a date.' };
    return done(r.ms, 1 + c.used);
  }

  if (first === 'tomorrow') {
    const c = clockAfter(input, ws, 1);
    if (!c.ok) return c;
    return atDay(addDays(today.y, today.mo, today.d, 1), c, 1 + c.used);
  }

  if (first === 'next' && lower(input, ws[1]) === 'week') {
    // the next Monday, never today (the Later menu's “Next week”)
    const ahead = ((1 - weekdayOf(today.y, today.mo, today.d) + 7) % 7) || 7;
    const c = clockAfter(input, ws, 2);
    if (!c.ok) return c;
    return atDay(addDays(today.y, today.mo, today.d, ahead), c, 2 + c.used);
  }

  // a weekday, with or without "next"
  const dayAt = first === 'next' ? 1 : 0;
  const dayWord = lower(input, ws[dayAt]);
  const wd = own(WEEKDAYS, dayWord);
  if (wd !== undefined) {
    const ahead = ((wd - weekdayOf(today.y, today.mo, today.d) + 7) % 7) || 7;
    const c = clockAfter(input, ws, dayAt + 1);
    if (!c.ok) return c;
    return atDay(addDays(today.y, today.mo, today.d, ahead), c, dayAt + 1 + c.used);
  }

  // a date
  const dateAt = first === 'on' ? 1 : 0;
  const date = readDate(lower(input, ws[dateAt]));
  if (date) {
    const c = clockAfter(input, ws, dateAt + 1);
    if (!c.ok) return c;
    const r = wallToInstant(zone, date.y, date.mo, date.d, c.h, c.mi);
    if (!r.ok) return r;
    if (r.ms < nowMs - 60_000) return { ok: false, reason: 'That date has already passed. Choose a later one.' };
    return done(r.ms, dateAt + 1 + c.used);
  }
  if (first === 'on') return { ok: false, reason: 'After “on”, write the date as year-month-day, for example on 2026-12-01.' };

  return { ok: false, reason: WHEN_USAGE };
}
