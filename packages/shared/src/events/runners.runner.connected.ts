import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { RunnerId, TeamId, WorkspaceId } from '../ids.ts';
import { RunnerCapability } from '../entities/task.ts';

/** A runner opened its connection and said what it can do (SPEC §7.4, PLAN P6-06). Ids, the name and the capabilities; never the token. */
export const RunnersRunnerConnectedEvent = z.object({
  type: z.literal('runners.runner.connected'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  runnerId: RunnerId,
  name: z.string().min(1).max(80),
  capabilities: z.array(RunnerCapability),
  maxJobs: z.number().int().min(1),
  at: IsoDateTime,
});
export type RunnersRunnerConnectedEvent = z.infer<typeof RunnersRunnerConnectedEvent>;
