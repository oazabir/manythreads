import { z } from 'zod';
import { ScheduledMeetingProvider } from '../../entities/scheduled-meeting.ts';
import type { ApiRoute } from '../client/route.ts';

// The calendars a person can plan a room in (PLAN Bundle D, P16-05, plugin `connections`). Only calendars of the caller's OWN Google or Microsoft connection that was
// granted the calendar service with write access are offered; nobody else's calendar is ever listed. docs/plugins/connections.md.

export const CalendarChoice = z.object({
  provider: ScheduledMeetingProvider,
  /** The provider's id of the calendar; `primary` for the main one. */
  calendarId: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  primary: z.boolean(),
});
export type CalendarChoice = z.infer<typeof CalendarChoice>;

/** Which services the caller connected but without the calendar-write service: the dialog offers "Connect your calendar" with the service ticked. */
export const ListMyCalendarsResponse = z.object({
  calendars: z.array(CalendarChoice).max(200),
  /** Connected, but the calendar service is missing or read-only: the page can offer to add it. */
  needsCalendarAccess: z.array(ScheduledMeetingProvider),
});
export type ListMyCalendarsResponse = z.infer<typeof ListMyCalendarsResponse>;
export const listMyCalendarsRoute = { method: 'GET', path: '/api/me/calendars' } as const satisfies ApiRoute;
