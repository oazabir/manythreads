import { z } from 'zod';
import { CALL_INVITES_MAX, MeetingKind } from '../../entities/meeting.ts';
import { ChannelId, MeetingId, PersonId } from '../../ids.ts';

/*
 * The team schedule (P36-04..07, docs/plans/team-schedule.md): appointments of a team's common schedule, each with its own meeting space (a team-less private
 * channel of kind `meeting` whose members are the maker and the invited, from any team). The Schedule screen reads every appointment the person may see,
 * across all their teams.
 */

export const APPOINTMENT_TITLE_MAX = 120;
export const APPOINTMENT_AGENDA_MAX = 2000;

export const AppointmentPerson = z.object({ personId: PersonId, name: z.string() });
export type AppointmentPerson = z.infer<typeof AppointmentPerson>;

/** How a meeting series repeats (P17-05): every week, every two weeks, or every month on the same day (the last day of a shorter month). */
export const MeetingSeriesFrequency = z.enum(['weekly', 'biweekly', 'monthly']);
export type MeetingSeriesFrequency = z.infer<typeof MeetingSeriesFrequency>;
export const MeetingSeriesStatus = z.enum(['active', 'stopped']);
export type MeetingSeriesStatus = z.infer<typeof MeetingSeriesStatus>;

/** The series a meeting of the schedule belongs to, as its panel shows it. */
export const AppointmentSeries = z.object({
  id: z.uuid(),
  title: z.string(),
  frequency: MeetingSeriesFrequency,
  /** The last day a meeting may fall on (in the series' time zone), or null when it goes on. */
  untilDate: z.iso.date().nullable(),
  status: MeetingSeriesStatus,
});
export type AppointmentSeries = z.infer<typeof AppointmentSeries>;

export const Appointment = z.object({
  id: z.uuid(),
  team: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  title: z.string(),
  agenda: z.string(),
  kind: MeetingKind,
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['scheduled', 'cancelled']),
  /** Its meeting space: where its call, chat and notes are. */
  channelId: ChannelId,
  createdBy: AppointmentPerson.nullable(),
  invited: z.array(AppointmentPerson),
  /** The call live in its space now, if any. */
  liveMeetingId: MeetingId.nullable(),
  /** The caller may change or cancel it (its maker, a lead of its team, a workspace admin). */
  canEdit: z.boolean(),
  /** The series it is a meeting of (P17-05), or null for a meeting on its own. */
  series: AppointmentSeries.nullable().default(null),
  /** Its agenda page in the team's files (`meetings/series/<slug>/<date>-agenda.md`), once the platform wrote it; null before, and for a person not on the team. */
  agendaPath: z.string().nullable().default(null),
});
export type Appointment = z.infer<typeof Appointment>;

export const ListAppointmentsQuery = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });
export const ListAppointmentsResponse = z.object({ appointments: z.array(Appointment) });
export type ListAppointmentsResponse = z.infer<typeof ListAppointmentsResponse>;
export const listAppointmentsRoute = { method: 'GET', path: '/api/appointments' } as const;

const AppointmentFields = {
  title: z.string().trim().min(1).max(APPOINTMENT_TITLE_MAX),
  agenda: z.string().max(APPOINTMENT_AGENDA_MAX),
  kind: MeetingKind,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  inviteeIds: z.array(PersonId).max(CALL_INVITES_MAX),
};
export const CreateAppointmentRequest = z.strictObject({ ...AppointmentFields, agenda: AppointmentFields.agenda.default(''), kind: AppointmentFields.kind.default('audio'), inviteeIds: AppointmentFields.inviteeIds.default([]) });
export type CreateAppointmentRequest = z.input<typeof CreateAppointmentRequest>;
export const UpdateAppointmentRequest = z.strictObject({
  title: AppointmentFields.title.optional(),
  agenda: AppointmentFields.agenda.optional(),
  kind: AppointmentFields.kind.optional(),
  startsAt: AppointmentFields.startsAt.optional(),
  endsAt: AppointmentFields.endsAt.optional(),
  inviteeIds: AppointmentFields.inviteeIds.optional(),
});
export type UpdateAppointmentRequest = z.infer<typeof UpdateAppointmentRequest>;
export const AppointmentResponse = z.object({ appointment: Appointment });
export type AppointmentResponse = z.infer<typeof AppointmentResponse>;
export const createAppointmentRoute = { method: 'POST', path: '/api/teams/:slug/appointments' } as const;
export const updateAppointmentRoute = { method: 'PATCH', path: '/api/appointments/:id' } as const;
export const cancelAppointmentRoute = { method: 'POST', path: '/api/appointments/:id/cancel' } as const;
export const AppointmentParams = z.object({ id: z.uuid() });
/** Join an appointment (P36-07): its call in its meeting space, started with its kind, or joined when it is live. The answer is the open-meeting answer. */
export const joinAppointmentRoute = { method: 'POST', path: '/api/appointments/:id/join' } as const;
