import type { AppointmentSeries, CreateMeetingSeriesRequest, MeetingSeriesFrequency } from '@manythreads/shared';

/*
 * Meeting series on the Schedule (P17-05, docs/plans/meeting-series.md): the words the form and the panel use, and the request the form sends. Pure, so tested
 * without a browser.
 */

export type Repeat = 'none' | MeetingSeriesFrequency;

export const REPEAT_OPTIONS: ReadonlyArray<{ value: Repeat; label: string }> = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
];

const longDate = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** "Every week", "Every 2 weeks until 31 March 2027", "Stopped". */
export function repeatLabel(series: Pick<AppointmentSeries, 'frequency' | 'untilDate' | 'status'>): string {
  if (series.status === 'stopped') return 'Stopped';
  const every = REPEAT_OPTIONS.find((o) => o.value === series.frequency)?.label ?? 'Repeats';
  return series.untilDate ? `${every} until ${longDate(series.untilDate)}` : every;
}

/** The browser's own time zone, so 10:00 stays 10:00 for the maker when the clocks change. */
export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function buildSeriesBody(input: {
  title: string;
  startsAt: string;
  endsAt: string;
  kind: 'audio' | 'video';
  agenda: string;
  inviteeIds: readonly string[];
  repeat: MeetingSeriesFrequency;
  until: string;
  timeZone: string;
}): CreateMeetingSeriesRequest {
  return {
    title: input.title.trim(),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    kind: input.kind,
    agenda: input.agenda,
    inviteeIds: [...input.inviteeIds] as CreateMeetingSeriesRequest['inviteeIds'],
    frequency: input.repeat,
    untilDate: input.until === '' ? null : input.until,
    timeZone: input.timeZone,
  };
}

/** The line under Repeats that says where the agenda lives and who reads it. */
export const agendaNotice = (teamName: string): string =>
  `Each meeting gets an agenda page in ${teamName}'s files that everyone on ${teamName} can read and edit. Open action items from the last meeting are copied into the next agenda.`;

/** The day of an agenda page from its path (`…/2026-12-01-agenda.md`), as the dialog's title says it. */
export function agendaDay(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  const day = name.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : null;
}
