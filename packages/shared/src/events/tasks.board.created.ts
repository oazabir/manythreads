import { z } from 'zod';
import { ActorId, BoardId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A board was created for a channel (the "Bot Board" a bot's `boards.ensure` makes). Carries ids and the name, never cards. */
export const TasksBoardCreatedEvent = z.object({
  type: z.literal('tasks.board.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  boardId: BoardId,
  channelId: ChannelId.nullable(),
  name: z.string().min(1).max(80),
  creatorId: ActorId,
});
export type TasksBoardCreatedEvent = z.infer<typeof TasksBoardCreatedEvent>;
