import { checkRemindAt } from '@manythreads/shared';
import { clock, dayLabel } from '../channels/format';

/*
 * The times "Remind me" offers (PLAN P14-04). Every one is worked out in the browser, in the person's own time zone, and sent as an exact moment;
 * the server never guesses a zone. "Tomorrow morning" is 9:00 tomorrow and "Next week" is 9:00 next Monday.
 */

export type RemindPreset = 'in20' | 'in60' | 'tomorrow' | 'nextweek';

export const REMIND_PRESETS: ReadonlyArray<{ id: RemindPreset; label: string }> = [
  { id: 'in20', label: 'In 20 minutes' },
  { id: 'in60', label: 'In 1 hour' },
  { id: 'tomorrow', label: 'Tomorrow morning' },
  { id: 'nextweek', label: 'Next week' },
];

/** Hour of the day (local) that "morning" means. */
export const MORNING_HOUR = 9;

/** The moment a preset means, counted from `now`. */
export function presetTime(preset: RemindPreset, now: Date): Date {
  if (preset === 'in20') return new Date(now.getTime() + 20 * 60_000);
  if (preset === 'in60') return new Date(now.getTime() + 60 * 60_000);
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), MORNING_HOUR, 0, 0, 0);
  if (preset === 'tomorrow') {
    day.setDate(day.getDate() + 1);
    return day;
  }
  // next week: the coming Monday, never today (a Monday asks for the Monday after)
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  day.setDate(day.getDate() + untilMonday);
  return day;
}

/** The value a `datetime-local` field takes (local time, minutes), for a moment. */
export function toLocalInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** What a `datetime-local` field holds, as a moment in the person's zone; null for an empty or unreadable field. */
export function fromLocalInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // new Date rolls 31 February over to March: refuse what does not survive the round trip
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** A sentence for what is wrong with a custom time, or null when it can be set. */
export function customTimeError(value: string, now: Date): string | null {
  const at = fromLocalInput(value);
  if (!at) return 'Choose a day and a time.';
  const check = checkRemindAt(at, now);
  return check.ok ? null : check.reason;
}

/** "Today at 14:05", "Tomorrow at 09:00", "Friday 6 November at 09:00": when a reminder is due. */
export function remindWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : dayLabel(iso, now);
  return `${day} at ${clock(iso)}`;
}
