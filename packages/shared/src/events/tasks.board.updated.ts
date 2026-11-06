import { z } from 'zod';
import { ActorId, BoardId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A board's columns changed: one was added, renamed or deleted, or the order changed. Carries ids and a count, never a column's name or a card. */
export const TasksBoardUpdatedEvent = z.object({
  type: z.literal('tasks.board.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  boardId: BoardId,
  channelId: ChannelId.nullable(),
  actorId: ActorId,
  change: z.enum(['column_added', 'column_renamed', 'column_deleted', 'columns_reordered']),
  columnCount: z.number().int().min(1),
});
export type TasksBoardUpdatedEvent = z.infer<typeof TasksBoardUpdatedEvent>;
