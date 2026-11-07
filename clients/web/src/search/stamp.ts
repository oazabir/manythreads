const PARTS = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * The whole date of a search hit, always with the year: "Tue 4 Nov 2026, 14:02" (the reader's time zone). Built from parts so the commas
 * and spacing do not depend on the browser's locale data. An unreadable date gives an empty string.
 */
export function searchStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const part = (type: Intl.DateTimeFormatPartTypes): string => PARTS.formatToParts(d).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
