import { ago, clock } from '../../channels/format';

/** Today as a clock time, this week as a weekday, older as a date (the list's When column). */
export function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? clock(iso) : ago(iso, now);
}
