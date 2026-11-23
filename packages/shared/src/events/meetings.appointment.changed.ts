import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** An appointment of a team's schedule was made, changed or cancelled (P36-04). `invitedPersonIds` are the people newly invited (they are told). No title rides along. */
export const MeetingsAppointmentChangedEvent = z.object({
  type: z.literal('meetings.appointment.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  appointmentId: z.uuid(),
  change: z.enum(['created', 'changed', 'cancelled']),
  invitedPersonIds: z.array(PersonId).max(100),
  at: z.string(),
});
export type MeetingsAppointmentChangedEvent = z.infer<typeof MeetingsAppointmentChangedEvent>;
