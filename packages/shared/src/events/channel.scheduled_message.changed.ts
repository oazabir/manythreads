import { z } from 'zod';
import { ActorId, ChannelId, MessageId, ScheduledMessageId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A scheduled message (P14-05) changed state. `scheduled`: a person scheduled it; `edited`: its text or time changed (a refused message edited
 * is scheduled again); `sent`: its time came and it was posted as a message (`messageId`); `refused`: its time came and the author could no
 * longer post there; `cancelled`: the author cancelled or dismissed it. The payload carries ids only: never the text of the message, never its
 * time and never the reason of a refusal (the event log is readable by the team's members and admins, and a scheduled message is private to its
 * author; the author reads the time and the reason from their own row). `authorId` is the person's actor; `refused` is written by the system, the
 * others by the author.
 */
export const ChannelScheduledMessageChangedEvent = z.object({
  type: z.literal('channel.scheduled_message.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  scheduledId: ScheduledMessageId,
  authorId: ActorId,
  change: z.enum(['scheduled', 'edited', 'sent', 'refused', 'cancelled']),
  /** The message that was posted; set only for `sent`. */
  messageId: MessageId.nullable(),
});
export type ChannelScheduledMessageChangedEvent = z.infer<typeof ChannelScheduledMessageChangedEvent>;
