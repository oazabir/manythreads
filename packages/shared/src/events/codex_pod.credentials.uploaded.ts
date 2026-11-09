import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** An admin uploaded the first sign-in file of a Codex runner. Ids and the runner's name only: nothing from the sign-in file, not even a hash. */
export const CodexPodCredentialsUploadedEvent = z.object({
  type: z.literal('codex_pod.credentials.uploaded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  actorId: ActorId,
  at: IsoDateTime,
});
export type CodexPodCredentialsUploadedEvent = z.infer<typeof CodexPodCredentialsUploadedEvent>;
