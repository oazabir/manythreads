/*
 * The calendar's arithmetic for the Schedule screen (P36-05), in the person's own time (the browser's): which days a view shows, where a block sits in a day
 * column, and how overlapping blocks share it. Pure, so it is tested on its own.
 */

export type CalendarView = 'day' | 'week' | 'month';

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Monday of the week of `d`. */
export const startOfWeek = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

/** The days a view shows around `anchor`: one, the seven of its week, or the whole weeks that cover its month. */
export function viewDays(view: CalendarView, anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const weeks = Math.ceil((((last.getTime() - start.getTime()) / 86_400_000) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

/** The next or previous anchor of a view. */
export function step(view: CalendarView, anchor: Date, dir: 1 | -1): Date {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

/** "Mon 23 Nov", "23 – 29 Nov 2026", "November 2026". */
export function viewLabel(view: CalendarView, anchor: Date): string {
  if (view === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const days = viewDays('week', anchor);
  const a = days[0]!;
  const b = days[6]!;
  const sameMonth = a.getMonth() === b.getMonth();
  return `${a.toLocaleDateString(undefined, { day: 'numeric', ...(sameMonth ? {} : { month: 'short' }) })} – ${b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export type Placed<T> = { item: T; top: number; height: number; lane: number; lanes: number };

/**
 * Where each appointment of one day sits in its column, as fractions of the day (top and height from 0 to 1), with overlapping ones side by side: each in a
 * lane of its group of overlaps. An appointment that crosses midnight is cut at the edge of the day.
 */
export function placeInDay<T extends { startsAt: string; endsAt: string }>(items: readonly T[], day: Date): Placed<T>[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(day, 1).getTime();
  const span = dayEnd - dayStart;
  const inDay = items
    .map((item) => ({ item, s: Math.max(Date.parse(item.startsAt), dayStart), e: Math.min(Date.parse(item.endsAt), dayEnd) }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed<T>[] = [];
  let group: Array<{ x: (typeof inDay)[number]; lane: number }> = [];
  let groupEnd = -Infinity;
  const flush = (): void => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) out.push({ item: g.x.item, top: (g.x.s - dayStart) / span, height: Math.max((g.x.e - g.x.s) / span, 1 / 96), lane: g.lane, lanes });
    group = [];
  };
  for (const x of inDay) {
    if (x.s >= groupEnd && group.length > 0) {
      flush();
      groupEnd = -Infinity;
    }
    const busy = new Set(group.filter((g) => Date.parse(String((g.x.item as { endsAt: string }).endsAt)) > x.s && g.x.e > x.s).map((g) => g.lane));
    let lane = 0;
    while (busy.has(lane)) lane += 1;
    group.push({ x, lane });
    groupEnd = Math.max(groupEnd, x.e);
  }
  if (group.length > 0) flush();
  return out;
}

/** The appointments that touch a day (for the month grid), earliest first. */
export const onDay = <T extends { startsAt: string; endsAt: string }>(items: readonly T[], day: Date): T[] =>
  items.filter((i) => Date.parse(i.startsAt) < addDays(day, 1).getTime() && Date.parse(i.endsAt) > startOfDay(day).getTime()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

/** "14:00 – 15:30" in the person's time. */
export const timeRange = (startsAt: string, endsAt: string): string => {
  // 24-hour, as the calendar's hour labels are
  const f = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${f(startsAt)} – ${f(endsAt)}`;
};

/** Join is offered from ten minutes before an appointment until it ends. */
export const joinable = (a: { startsAt: string; endsAt: string; status: string }, now: number): boolean =>
  a.status === 'scheduled' && now >= Date.parse(a.startsAt) - 10 * 60_000 && now < Date.parse(a.endsAt);
