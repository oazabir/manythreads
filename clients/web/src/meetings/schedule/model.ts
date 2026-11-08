import { SCHEDULED_AGENDA_MAX, SCHEDULED_ATTENDEES_MAX, SCHEDULED_TITLE_MAX, type CreateScheduledMeetingRequest, type ScheduledMeeting, type ScheduledMeetingProvider } from '@manythreads/shared';

// Rooms planned ahead (PLAN Bundle D, P16-05): the pure parts of the dialog and the chip, so they can be tested without a browser. Times are the person's own (the browser's zone);
// the server stores UTC.

export const LENGTHS = [15, 30, 45, 60, 90] as const;

/** How soon a planned room can be started, in minutes; the server allows two minutes of grace for a time that has just passed. */
const PAST_GRACE_MS = 2 * 60_000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-11-09` in the zone of the date. */
export const dateInput = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `15:00` in the zone of the date. */
export const timeInput = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The next half hour after `now`: the start the dialog proposes. */
export function proposedStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  if (d.getTime() - now.getTime() < 5 * 60_000) d.setMinutes(d.getMinutes() + 30);
  return d;
}

/** The instant a date input (`YYYY-MM-DD`) and a time input (`HH:MM`) show in the browser's zone; null when either is not filled in. */
export function localInstant(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const out = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  // `new Date(2026, 1, 31)` rolls over to March: a day that is not on the calendar is not a time
  if (out.getFullYear() !== Number(d[1]) || out.getMonth() !== Number(d[2]) - 1 || out.getDate() !== Number(d[3])) return null;
  return Number.isNaN(out.getTime()) ? null : out;
}

/** An ISO time with the zone's offset ("2026-11-09T15:00:00+03:00"), as the server's contract names it. */
export function isoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const ADDRESS = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]{2,}$/;

/** The addresses typed into the "people outside" box (separated by commas, semicolons, spaces or lines): the good ones, lower-cased and without repeats, and the ones that are not addresses. */
export function parseAddresses(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const part = raw.trim().replace(/^<|>$/g, '');
    if (part === '') continue;
    const address = part.toLowerCase();
    if (!ADDRESS.test(address) || address.length > 320) invalid.push(part.slice(0, 80));
    else if (!valid.includes(address)) valid.push(address);
  }
  return { valid, invalid };
}

export type ScheduleForm = {
  title: string;
  date: string;
  time: string;
  lengthMinutes: number;
  attendeePersonIds: readonly string[];
  outsideText: string;
  agenda: string;
  calendar: { provider: ScheduledMeetingProvider; calendarId: string } | null;
};

export type BuiltRequest = { ok: true; body: CreateScheduledMeetingRequest } | { ok: false; error: string };

/** The request the server takes, or the sentence that says what to fix. */
export function buildCreateRequest(form: ScheduleForm, now: Date): BuiltRequest {
  const title = form.title.replace(/\s+/g, ' ').trim();
  if (title === '') return { ok: false, error: 'Give the meeting a title.' };
  if ([...title].length > SCHEDULED_TITLE_MAX) return { ok: false, error: `A title can have at most ${SCHEDULED_TITLE_MAX} characters.` };
  const start = localInstant(form.date, form.time);
  if (!start) return { ok: false, error: 'Choose a date and a start time.' };
  if (start.getTime() < now.getTime() - PAST_GRACE_MS) return { ok: false, error: 'That time has already passed. Choose a time that is still to come.' };
  if (!LENGTHS.some((l) => l === form.lengthMinutes)) return { ok: false, error: 'Choose how long the meeting lasts.' };
  const { valid, invalid } = parseAddresses(form.outsideText);
  if (invalid.length > 0) return { ok: false, error: `“${invalid[0]}” is not an email address.` };
  if (form.attendeePersonIds.length + valid.length > SCHEDULED_ATTENDEES_MAX) return { ok: false, error: `At most ${SCHEDULED_ATTENDEES_MAX} people can be invited.` };
  if (form.agenda.length > SCHEDULED_AGENDA_MAX) return { ok: false, error: `The agenda can have at most ${SCHEDULED_AGENDA_MAX} characters.` };
  if (!form.calendar) return { ok: false, error: 'Connect a calendar first.' };
  return {
    ok: true,
    body: {
      title,
      startsAt: isoWithOffset(start),
      lengthMinutes: form.lengthMinutes,
      agendaMd: form.agenda.trim(),
      calendarProvider: form.calendar.provider,
      calendarId: form.calendar.calendarId,
      attendeePersonIds: [...form.attendeePersonIds] as CreateScheduledMeetingRequest['attendeePersonIds'],
      outsideAddresses: valid,
    },
  };
}

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 15:00", "tomorrow 09:30", or "Mon 9 Nov 15:00" in the viewer's zone. */
export function whenWords(startsAt: string, now: Date, locale?: string): string {
  const d = new Date(startsAt);
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  if (sameDay(d, now)) return `today ${clock}`;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(d, tomorrow)) return `tomorrow ${clock}`;
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${clock}`;
}

/** The header chip's words: "Design review, today 15:00", or "Design review, live now" once its room is open. */
export function chipText(plan: Pick<ScheduledMeeting, 'title' | 'startsAt' | 'status'>, now: Date, locale?: string): string {
  const title = plan.title.length > 28 ? `${[...plan.title].slice(0, 27).join('')}…` : plan.title;
  return plan.status === 'started' ? `${title}, live now` : `${title}, ${whenWords(plan.startsAt, now, locale)}`;
}

/** "3 invited, 1 outside" for the popover; nothing invited says so. */
export function invitedWords(plan: Pick<ScheduledMeeting, 'attendeeCount' | 'outsideCount'>): string {
  const inside = plan.attendeeCount;
  const outside = plan.outsideCount;
  if (inside + outside === 0) return 'Nobody invited yet';
  const parts = [`${inside} invited`];
  if (outside > 0) parts.push(`${outside} outside`);
  return parts.join(', ');
}
