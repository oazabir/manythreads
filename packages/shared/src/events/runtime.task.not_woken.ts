import { z } from 'zod';
import { BotId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A card was handed to a bot (or finished, for the bot that created it) and the bot's `task_assigned` trigger could not start a run
 * (PLAN P6-03). Emitted by the runtime so the miss is on the record instead of silent; the tasks plugin writes it on the card's history
 * as a `not_woken` line. `reason`: `no_thread` (the card has no thread to answer in), `channel_unavailable` (its channel was archived,
 * deleted or is not the team's), `receiver_cannot_post` (the bot may not post in that channel), `wake_limit` (the creator was already
 * woken three times in the last hour by finished cards). Ids and a reason code only, never card text.
 */
export const RuntimeTaskNotWokenEvent = z.object({
  type: z.literal('runtime.task.not_woken'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  botId: BotId,
  reason: z.enum(['no_thread', 'channel_unavailable', 'receiver_cannot_post', 'wake_limit']),
});
export type RuntimeTaskNotWokenEvent = z.infer<typeof RuntimeTaskNotWokenEvent>;
