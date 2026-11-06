import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** An admin replaced the sign-in file of a Claude Code runner. Ids and the runner's name only: nothing from the sign-in file, not even a hash. */
export const ClaudePodCredentialsReplacedEvent = z.object({
  type: z.literal('claude_pod.credentials.replaced'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  actorId: ActorId,
  at: IsoDateTime,
});
export type ClaudePodCredentialsReplacedEvent = z.infer<typeof ClaudePodCredentialsReplacedEvent>;
