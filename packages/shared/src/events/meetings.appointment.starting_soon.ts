import { z } from 'zod';
import { ChannelId, PersonId, WorkspaceId } from '../ids.ts';

/** An appointment starts in about five minutes (P36-07): said once by the reminder job (again when its time moves). The people are its maker and its invited. */
export const MeetingsAppointmentStartingSoonEvent = z.object({
  type: z.literal('meetings.appointment.starting_soon'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  appointmentId: z.uuid(),
  channelId: ChannelId,
  personIds: z.array(PersonId).max(101),
  at: z.string(),
});
export type MeetingsAppointmentStartingSoonEvent = z.infer<typeof MeetingsAppointmentStartingSoonEvent>;
