/*
 * The spend report's range (PLAN P5-08). A `<input type="date">` gives a calendar day; `llm_spend` is queried by
 * instant, with `until` exclusive. So the day chosen as *from* becomes the instant that starts it, and the day chosen as
 * *to* becomes the instant that starts the day after it — which is what makes "1st to the 31st" include the 31st rather
 * than stopping at its midnight.
 *
 * Kept apart from the component because it is the one part of the page with a rule worth asserting: an off-by-one day
 * would quietly hide a month's last day of spend from the number an admin reads as their budget total.
 */

const DAY_START = 'T00:00:00.000Z';
const ONE_DAY_MS = 86_400_000;

/** The instant a chosen calendar day starts (UTC), or undefined when the field was left empty. */
export const startOfDay = (day: string): string | undefined => (day ? new Date(`${day}${DAY_START}`).toISOString() : undefined);

/** The instant the day after the chosen one starts, so the whole chosen day falls inside the range. */
export const afterDay = (day: string): string | undefined => (day ? new Date(new Date(`${day}${DAY_START}`).getTime() + ONE_DAY_MS).toISOString() : undefined);

/** What the form sends: both days optional, and an empty field is left out rather than sent as an empty string. */
export function spendRange(since: string, until: string): { since?: string; until?: string } {
  const from = startOfDay(since);
  const to = afterDay(until);
  return { ...(from ? { since: from } : {}), ...(to ? { until: to } : {}) };
}
