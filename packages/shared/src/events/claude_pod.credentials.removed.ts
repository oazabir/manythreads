import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** An admin removed the sign-in file of a Claude Code runner. Ids and the runner's name only: nothing from the sign-in file, not even a hash. */
export const ClaudePodCredentialsRemovedEvent = z.object({
  type: z.literal('claude_pod.credentials.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  actorId: ActorId,
  at: IsoDateTime,
});
export type ClaudePodCredentialsRemovedEvent = z.infer<typeof ClaudePodCredentialsRemovedEvent>;
