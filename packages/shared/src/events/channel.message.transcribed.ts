import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The server finished with the transcript of a voice message (P32-04, decision D13): `server` when the words were written into the message body,
 * `failed` when they could not be (the message keeps its stand-in line and says why), `none` when an admin switched transcripts off after the message was
 * sent (the message keeps its stand-in line). The payload carries ids, the state and the transcribed range,
 * never the words: a consumer reads the message when it needs them. The bot router answers a voice message on this event, once, and memory reads it
 * as an edit.
 */
export const ChannelMessageTranscribedEvent = z.object({
  type: z.literal('channel.message.transcribed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  authorId: ActorId,
  threadRootId: MessageId.nullable(),
  state: z.enum(['server', 'failed', 'none']),
  /** `server` only: where the transcribed range ends, in milliseconds (the range starts at 0); null otherwise. */
  transcriptEndMs: z.number().int().min(0).nullable(),
});
export type ChannelMessageTranscribedEvent = z.infer<typeof ChannelMessageTranscribedEvent>;
