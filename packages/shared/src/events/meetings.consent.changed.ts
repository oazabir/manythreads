import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { MeetingConsent } from '../entities/meeting.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A person answered "may your voice be written down / recorded" in a voice room, or the room's transcription or recording was turned on or off (P15-05). */
export const MeetingsConsentChangedEvent = z.object({
  type: z.literal('meetings.consent.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  /** Whose answer it is; for a change of the room's setting, the person who changed it. */
  actorId: ActorId,
  subject: z.enum(['transcribe', 'record', 'room_transcription', 'room_recording']),
  /** The new answer for a person's consent; `yes` or `no` for a room setting turned on or off. */
  value: MeetingConsent,
  at: IsoDateTime,
});
export type MeetingsConsentChangedEvent = z.infer<typeof MeetingsConsentChangedEvent>;
