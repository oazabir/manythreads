import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin pinned a pod runner to a machine of the cluster, moved it to another, or let the cluster choose again (P19-08). Content-blind: the machine's
 * name is not in the event (it is a setting only an admin reads); the event says only that a node was set before, is set now, and whether the move makes the
 * pods' work volumes start empty on the new machine.
 */
export const BotRunnerNodeChangedEvent = z.object({
  type: z.literal('bot_runner.node.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  /** A machine was chosen before this change. */
  wasPinned: z.boolean(),
  /** A machine is chosen after it (false: the cluster picks again). */
  isPinned: z.boolean(),
  /** Pods of this runner will get new, empty work volumes on the new machine. */
  recreatesWorkVolume: z.boolean(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerNodeChangedEvent = z.infer<typeof BotRunnerNodeChangedEvent>;
