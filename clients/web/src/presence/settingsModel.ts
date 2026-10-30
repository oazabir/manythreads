import {
  CustomStatusInput,
  STATUS_EMOJI_MAX,
  STATUS_TEXT_MAX,
  WorkingHours,
  isValidTimeZone,
  localTimeText,
  minutesOf,
  type CustomStatus,
  type DndSchedule,
  type DndState,
  type DndWindow,
  type UpdateDndRequest,
  type UpdateMyPresenceRequest,
} from '@manythreads/shared';
import { clock } from '../channels/format';
import { fromLocalInput } from '../later/times';
import { WEEK_ORDER, clearsAtFor, dayName, type ClearChoice } from './format';

/*
 * The rules behind the Do not disturb screen (PLAN P14-01): which pauses are offered and how long each lasts, the words for the paused state, the
 * weekly schedule as one row per weekday, a custom status, the time zone and the working hours. Everything here is pure (no network, no DOM), so
 * the screen, the menu and the tests agree. The server stays the authority: it checks every request again.
 */

// ---- pausing ---------------------------------------------------------------------------------------------------------------------

export const PAUSE_PRESETS = [
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: 'tomorrow', label: 'Until tomorrow morning' },
] as const;
export type PausePreset = (typeof PAUSE_PRESETS)[number]['id'];

/** The hour (local, on this device) that "tomorrow morning" means. */
export const MORNING_HOUR = 9;
/** The server refuses a pause longer than this (7 days). */
export const MAX_PAUSE_MINUTES = 7 * 24 * 60;

/** When a ready-made pause ends, counted from `now` on this device's clock. */
export function pauseEnd(preset: PausePreset, now: Date): Date {
  if (preset === '30m') return new Date(now.getTime() + 30 * 60_000);
  if (preset === '1h') return new Date(now.getTime() + 60 * 60_000);
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), MORNING_HOUR, 0, 0, 0);
  morning.setDate(morning.getDate() + 1);
  return morning;
}

/** Whole minutes from `now` to `end`, rounded up so the pause never ends early; at least 1. */
export const minutesUntil = (end: Date, now: Date): number => Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 60_000));

/** A ready-made pause turns a hand-set Do not disturb off, so the pause (with its end) is what the person sees. */
export function pauseRequest(preset: PausePreset, now: Date): UpdateDndRequest {
  return { enabled: false, pauseMinutes: minutesUntil(pauseEnd(preset, now), now) };
}

/** "Until I turn it off": Do not disturb stays on until the person ends it. */
export const HOLD_REQUEST: UpdateDndRequest = { enabled: true, pauseMinutes: null };
/** "Resume now": ends a hand-set Do not disturb and any pause. */
export const RESUME_REQUEST: UpdateDndRequest = { enabled: false, pauseMinutes: null };

export type CustomPause = { ok: true; end: Date; request: UpdateDndRequest } | { ok: false; problem: string };

/** A pause that ends at a day and time the person typed (`datetime-local`, this device's clock). */
export function customPause(value: string, now: Date): CustomPause {
  const end = fromLocalInput(value);
  if (!end) return { ok: false, problem: 'Choose a day and a time.' };
  if (end.getTime() <= now.getTime()) return { ok: false, problem: 'That time has already passed. Choose a later one.' };
  const minutes = minutesUntil(end, now);
  if (minutes > MAX_PAUSE_MINUTES) return { ok: false, problem: 'A pause can last at most 7 days.' };
  return { ok: true, end, request: { enabled: false, pauseMinutes: minutes } };
}

// ---- words for the state ---------------------------------------------------------------------------------------------------------

const DAY_PARTS = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "14:30" today, "tomorrow 09:00", "Mon 9 Nov 09:00": when something ends, on this device's clock. */
export function untilText(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((dayStart(d) - dayStart(now)) / 86_400_000);
  if (days <= 0) return clock(iso);
  if (days === 1) return `tomorrow ${clock(iso)}`;
  const part = (type: Intl.DateTimeFormatPartTypes): string => DAY_PARTS.formatToParts(d).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${clock(iso)}`;
}

export type DndBanner = {
  /** The sentence shown while Do not disturb is on. */
  text: string;
  /** A pause or a hand-set Do not disturb can be ended on the spot; quiet hours can only be changed in the schedule. */
  canResume: boolean;
  reason: 'manual' | 'paused' | 'schedule';
};

/** The paused state in words, or null when Do not disturb is off. */
export function dndBanner(state: DndState | null, now: Date): DndBanner | null {
  if (!state || !state.active || state.reason === null) return null;
  if (state.reason === 'manual') return { text: 'Do not disturb is on', canResume: true, reason: 'manual' };
  if (state.reason === 'paused') return { text: state.until ? `Paused until ${untilText(state.until, now)}` : 'Notifications are paused', canResume: true, reason: 'paused' };
  return { text: state.until ? `Quiet hours until ${untilText(state.until, now)}` : 'Quiet hours', canResume: false, reason: 'schedule' };
}

/** What happens to messages that arrive meanwhile. Checked against `notifications/src/hold.ts`: held rows are released together, by the minute job. */
export const HELD_NOTE = 'Notifications that arrive meanwhile are kept back and delivered together when it ends, within about a minute.';

/** The bell's accessible name. */
export function bellLabel(unread: number, banner: DndBanner | null): string {
  const base = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return banner ? `${base}, ${banner.text.charAt(0).toLowerCase()}${banner.text.slice(1)}` : base;
}

// ---- custom status ---------------------------------------------------------------------------------------------------------------

export type StatusClear = ClearChoice | 'keep';
export type StatusDraft = { emoji: string; text: string; clear: StatusClear };

/** Emoji offered as quick starts beside the text box. */
export const QUICK_EMOJI = ['💬', '📅', '🍽️', '🚌', '🏠', '🤒', '🌴', '☕', '🎧', '🎯'] as const;

/** The editor's first state: the current status (its clear time is kept unless changed), or empty. */
export function statusDraftOf(status: CustomStatus | null): StatusDraft {
  if (!status) return { emoji: '', text: '', clear: 'never' };
  return { emoji: status.emoji ?? '', text: status.text, clear: status.clearsAt ? 'keep' : 'never' };
}

/** A sentence for what is wrong with a status, or null when it can be saved. */
export function statusProblem(draft: StatusDraft): string | null {
  const emoji = draft.emoji.trim();
  const text = draft.text.trim();
  if (emoji === '' && text === '') return 'Add an emoji or a few words.';
  if (text.length > STATUS_TEXT_MAX) return `Keep the words under ${STATUS_TEXT_MAX} characters.`;
  if (emoji.length > STATUS_EMOJI_MAX) return 'Use one emoji.';
  return null;
}

export type StatusBuilt = { ok: true; body: UpdateMyPresenceRequest } | { ok: false; problem: string };

/** The request that saves a status. `current` supplies the clear time that "keep" means. */
export function statusRequest(draft: StatusDraft, current: CustomStatus | null, now: Date): StatusBuilt {
  const problem = statusProblem(draft);
  if (problem) return { ok: false, problem };
  const clearsAt = draft.clear === 'keep' ? (current?.clearsAt ?? null) : clearsAtFor(draft.clear, now);
  const parsed = CustomStatusInput.safeParse({ emoji: draft.emoji.trim() === '' ? null : draft.emoji.trim(), text: draft.text, clearsAt });
  if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? 'That status cannot be saved.' };
  return { ok: true, body: { status: parsed.data } };
}

/** "Clears 14:30", "Clears tomorrow 09:00", "Clears at midnight": when the shown status goes, or null when it stays. */
export function clearsText(status: CustomStatus | null, now: Date): string | null {
  if (!status || !status.clearsAt) return null;
  const d = new Date(status.clearsAt);
  if (d.getHours() === 0 && d.getMinutes() === 0) return 'Clears at midnight';
  return `Clears ${untilText(status.clearsAt, now)}`;
}

// ---- the weekly schedule ---------------------------------------------------------------------------------------------------------

export type DayRow = { day: number; on: boolean; start: string; end: string };

/** The quiet hours a day starts with when the schedule is first switched on: late evening to early morning. */
export const DEFAULT_QUIET = { start: '22:00', end: '07:00' } as const;

export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Seven rows, Monday first. A day that no period covers is off; a day in several periods takes the first. */
export function rowsOf(schedule: DndSchedule): DayRow[] {
  return WEEK_ORDER.map((day) => {
    const w = schedule.windows.find((x) => x.days.includes(day));
    return { day, on: w !== undefined, start: w?.start ?? DEFAULT_QUIET.start, end: w?.end ?? DEFAULT_QUIET.end };
  });
}

/** Every day on, with the default quiet hours: where a schedule that was never set starts. */
export const defaultRows = (): DayRow[] => WEEK_ORDER.map((day) => ({ day, on: true, ...DEFAULT_QUIET }));

/** True when no weekday is in two periods, so one row per day shows the schedule without loss. */
export function fitsRows(schedule: DndSchedule): boolean {
  const seen = new Set<number>();
  for (const w of schedule.windows) {
    for (const d of w.days) {
      if (seen.has(d)) return false;
      seen.add(d);
    }
  }
  return true;
}

/** The periods the rows mean: days with the same hours share one period (at most seven in all). */
export function windowsOf(rows: readonly DayRow[]): DndWindow[] {
  const groups = new Map<string, DndWindow>();
  for (const r of rows) {
    if (!r.on) continue;
    const key = `${r.start}-${r.end}`;
    const g = groups.get(key);
    if (g) g.days.push(r.day);
    else groups.set(key, { days: [r.day], start: r.start, end: r.end });
  }
  return [...groups.values()];
}

/** An end earlier than the start runs overnight into the next morning. */
export const runsOvernight = (r: Pick<DayRow, 'start' | 'end'>): boolean => CLOCK_TIME.test(r.start) && CLOCK_TIME.test(r.end) && minutesOf(r.end) < minutesOf(r.start);

/** A sentence for what is wrong with the rows, or null when they can be saved. */
export function scheduleProblem(enabled: boolean, rows: readonly DayRow[]): string | null {
  for (const r of rows) {
    if (!r.on) continue;
    if (!CLOCK_TIME.test(r.start) || !CLOCK_TIME.test(r.end)) return `${dayName(r.day)}: choose a start and an end time.`;
    if (r.start === r.end) return `${dayName(r.day)}: the start and the end must differ.`;
  }
  if (enabled && !rows.some((r) => r.on)) return 'Choose at least one day, or switch the schedule off.';
  return null;
}

export type ScheduleBuilt = { ok: true; request: UpdateDndRequest } | { ok: false; problem: string };

/** The request that saves the schedule. A schedule that is switched off still keeps its periods. */
export function scheduleRequest(enabled: boolean, rows: readonly DayRow[]): ScheduleBuilt {
  const problem = scheduleProblem(enabled, rows);
  if (problem) return { ok: false, problem };
  return { ok: true, request: { schedule: { enabled, windows: windowsOf(rows) } } };
}

export const sameRows = (a: readonly DayRow[], b: readonly DayRow[]): boolean =>
  a.length === b.length && a.every((r, i) => r.day === b[i]?.day && r.on === b[i].on && (!r.on || (r.start === b[i].start && r.end === b[i].end)));

// ---- time zone and working hours -------------------------------------------------------------------------------------------------

/** The zone this device is set to, when the runtime names a valid one. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

const FALLBACK_ZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];

/** The zones to choose from (the runtime's list, `UTC`, this device's zone and the saved one, once each, sorted). */
export function timeZoneChoices(saved: string | null, device: string | null = deviceTimeZone()): string[] {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    known = FALLBACK_ZONES;
  }
  return [...new Set([...known, 'UTC', ...(device ? [device] : []), ...(saved ? [saved] : [])])].sort((a, b) => a.localeCompare(b));
}

/** "14:32" in `zone` now; empty for a name the runtime does not know. */
export const zoneClock = (zone: string | null, now: Date): string => (zone && isValidTimeZone(zone) ? localTimeText(now, zone) : '');

export type HoursDraft = { on: boolean; days: number[]; start: string; end: string };
export const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } as const;

export function hoursDraftOf(hours: { days: number[]; start: string; end: string } | null): HoursDraft {
  return hours ? { on: true, days: [...hours.days], start: hours.start, end: hours.end } : { on: false, days: [...DEFAULT_HOURS.days], start: DEFAULT_HOURS.start, end: DEFAULT_HOURS.end };
}

export type ProfileBuilt = { ok: true; body: UpdateMyPresenceRequest } | { ok: false; problem: string };

/** The request that saves the time zone and working hours together (hours need a zone, and the server says so too). */
export function profileRequest(zone: string | null, hours: HoursDraft): ProfileBuilt {
  if (zone !== null && !isValidTimeZone(zone)) return { ok: false, problem: 'Choose a time zone from the list.' };
  if (!hours.on) return { ok: true, body: { timeZone: zone, workingHours: null } };
  if (zone === null) return { ok: false, problem: 'Choose your time zone before you set working hours.' };
  if (hours.days.length === 0) return { ok: false, problem: 'Choose at least one working day.' };
  if (!CLOCK_TIME.test(hours.start) || !CLOCK_TIME.test(hours.end)) return { ok: false, problem: 'Choose a start and an end time.' };
  const parsed = WorkingHours.safeParse({ days: [...hours.days].sort((a, b) => a - b), start: hours.start, end: hours.end });
  if (!parsed.success) return { ok: false, problem: minutesOf(hours.start) >= minutesOf(hours.end) ? 'Working hours must end after they start.' : 'Those working hours cannot be saved.' };
  return { ok: true, body: { timeZone: zone, workingHours: parsed.data } };
}

export const sameHours = (a: HoursDraft, b: HoursDraft): boolean =>
  a.on === b.on && (!a.on || (a.start === b.start && a.end === b.end && [...a.days].sort().join() === [...b.days].sort().join()));
