import { z } from 'zod';
import { CALL_INVITES_MAX, MeetingKind } from '../../entities/meeting.ts';
import { PersonId } from '../../ids.ts';
import { APPOINTMENT_AGENDA_MAX, APPOINTMENT_TITLE_MAX, Appointment, MeetingSeriesFrequency, MeetingSeriesStatus } from './appointments.ts';

/*
 * Meeting series (P17-05, docs/plans/meeting-series.md): a meeting of the team schedule that repeats on a simple rule. Every meeting of it is an appointment
 * (`series` set); they share one meeting space. The series keeps one folder in the team's files, `meetings/series/<slug>/`, with an agenda page per meeting that
 * the team edits live; the open action items of the last meeting are copied into the next agenda.
 */

/** Meetings are planned this many days ahead; a job adds the next ones as time goes by. */
export const SERIES_PLAN_DAYS = 92;

/** An IANA time zone name as the browser reports it (`Europe/Berlin`); the database checks it is one it knows. */
export const SeriesTimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+/-]+$/, 'a time zone name such as Europe/Berlin');

export const MeetingSeries = z.object({
  id: z.uuid(),
  team: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  title: z.string(),
  /** Its folder in the team's files. */
  folder: z.string(),
  frequency: MeetingSeriesFrequency,
  untilDate: z.iso.date().nullable(),
  timeZone: z.string(),
  status: MeetingSeriesStatus,
  /** The caller may change or stop it (its maker, a lead of its team, a workspace admin). */
  canEdit: z.boolean(),
});
export type MeetingSeries = z.infer<typeof MeetingSeries>;

export const CreateMeetingSeriesRequest = z.strictObject({
  title: z.string().trim().min(1).max(APPOINTMENT_TITLE_MAX),
  agenda: z.string().max(APPOINTMENT_AGENDA_MAX).default(''),
  kind: MeetingKind.default('audio'),
  /** The first meeting. */
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  inviteeIds: z.array(PersonId).max(CALL_INVITES_MAX).default([]),
  frequency: MeetingSeriesFrequency,
  untilDate: z.iso.date().nullable().default(null),
  timeZone: SeriesTimeZone,
});
export type CreateMeetingSeriesRequest = z.input<typeof CreateMeetingSeriesRequest>;

export const UpdateMeetingSeriesRequest = z.strictObject({
  title: z.string().trim().min(1).max(APPOINTMENT_TITLE_MAX).optional(),
  inviteeIds: z.array(PersonId).max(CALL_INVITES_MAX).optional(),
});
export type UpdateMeetingSeriesRequest = z.infer<typeof UpdateMeetingSeriesRequest>;

export const MeetingSeriesParams = z.object({ id: z.uuid() });
export const MeetingSeriesResponse = z.object({ series: MeetingSeries });
export type MeetingSeriesResponse = z.infer<typeof MeetingSeriesResponse>;
/** The series and its first meeting. */
export const CreateMeetingSeriesResponse = z.object({ series: MeetingSeries, appointment: Appointment });
export type CreateMeetingSeriesResponse = z.infer<typeof CreateMeetingSeriesResponse>;

export const createMeetingSeriesRoute = { method: 'POST', path: '/api/teams/:slug/meeting-series' } as const;
export const updateMeetingSeriesRoute = { method: 'PATCH', path: '/api/meeting-series/:id' } as const;
export const stopMeetingSeriesRoute = { method: 'POST', path: '/api/meeting-series/:id/stop' } as const;
