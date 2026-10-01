import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MessageId, WorkspaceId } from '../ids.ts';

export const Message = z.object({
  id: MessageId,
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  authorId: ActorId,
  body: z.string().min(1).max(40_000), // markdown
  bodyPlain: z.string(), // derived by the server, used for search
  threadRootId: MessageId.nullable(),
  editedAt: IsoDateTime.nullable(),
  deletedAt: IsoDateTime.nullable(),
  meta: z.object({ answerRef: z.string().optional(), surfaceRef: z.string().optional() }),
  createdAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;
