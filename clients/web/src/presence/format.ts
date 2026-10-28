import { liveOutOfOffice, liveStatus, type CustomStatus, type OutOfOffice, type PresenceCard, type WorkingHours } from '@manythreads/shared';

/** The words beside a presence dot. */
export function presenceWord(card: Pick<PresenceCard, 'presence'> | undefined): 'Active' | 'Away' | 'Offline' {
  if (!card) return 'Offline';
  return card.presence === 'online' ? 'Active' : card.presence === 'away' ? 'Away' : 'Offline';
}

/** The status to show right now (`null` once its clear time has passed, even if the list was fetched before that). */
export const statusNow = (card: PresenceCard | undefined, now: Date): CustomStatus | null => (card ? liveStatus(card.status, now) : null);
export const oooNow = (card: PresenceCard | undefined, now: Date): OutOfOffice | null => (card ? liveOutOfOffice(card.outOfOffice, card.timeZone, now) : null);

/** `🍽️ Lunch`, or whichever of the two there is. */
export const statusText = (s: CustomStatus): string => [s.emoji, s.text].filter((x) => x !== null && x !== '').join(' ');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const dayName = (d: number): string => DAY_NAMES[d] ?? '';
/** Monday first, as people write a working week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** `Mon to Fri`, `Mon, Wed, Sat`, `Every day`. */
export function daysText(days: readonly number[]): string {
  const set = new Set(days);
  if (set.size === 7) return 'Every day';
  const ordered = WEEK_ORDER.filter((d) => set.has(d));
  const runs: number[][] = [];
  for (const d of ordered) {
    const run = runs[runs.length - 1];
    if (run && WEEK_ORDER.indexOf(d as never) === WEEK_ORDER.indexOf(run[run.length - 1] as never) + 1) run.push(d);
    else runs.push([d]);
  }
  return runs.map((r) => (r.length >= 3 ? `${dayName(r[0]!)} to ${dayName(r[r.length - 1]!)}` : r.map(dayName).join(', '))).join(', ');
}

export const hoursText = (h: WorkingHours): string => `${daysText(h.days)}, ${h.start} to ${h.end}`;

/** "Back on Mon 15 Jun" from `2026-06-15` (read as a calendar date, not shifted by any time zone). */
export function returnText(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Choices for "Clear after". `today` and `week` end at the device's local midnight. */
export const CLEAR_CHOICES = [
  { id: 'never', label: "Don't clear" },
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: '4h', label: '4 hours' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
] as const;
export type ClearChoice = (typeof CLEAR_CHOICES)[number]['id'];

/** The moment a "Clear after" choice means, counted from `now` on this device's clock. */
export function clearsAtFor(choice: ClearChoice, now: Date): string | null {
  if (choice === 'never') return null;
  if (choice === '30m') return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (choice === '1h') return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (choice === '4h') return new Date(now.getTime() + 4 * 60 * 60_000).toISOString();
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  if (choice === 'week') {
    // the coming Sunday midnight (a Sunday ends that same day's week at the next midnight a week away)
    const toSunday = (7 - end.getDay()) % 7;
    end.setDate(end.getDate() + toSunday);
  }
  return end.toISOString();
}

/** Ready-made statuses, as chat apps offer them. */
export const STATUS_PRESETS = [
  { emoji: '📅', text: 'In a meeting', clear: '1h' },
  { emoji: '🚌', text: 'Commuting', clear: '30m' },
  { emoji: '🏠', text: 'Working remotely', clear: 'today' },
  { emoji: '🤒', text: 'Out sick', clear: 'today' },
  { emoji: '🌴', text: 'On holiday', clear: 'never' },
] as const satisfies ReadonlyArray<{ emoji: string; text: string; clear: ClearChoice }>;
