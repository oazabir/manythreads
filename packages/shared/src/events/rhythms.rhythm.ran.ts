import { z } from 'zod';
import { RhythmKind, RhythmRunStatus } from '../entities/rhythm.ts';
import { BotId, RhythmId, RhythmRunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/** A rhythm fired (PLAN P6-08): queued, done, or failed with the reason (a bad contract, a missing page). */
export const RhythmsRhythmRanEvent = z.object({
  type: z.literal('rhythms.rhythm.ran'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  rhythmId: RhythmId,
  rhythmRunId: RhythmRunId,
  botId: BotId,
  kind: RhythmKind,
  status: RhythmRunStatus,
  outputPath: z.string().nullable(),
  taskId: TaskId.nullable(),
  reason: z.string().max(500),
});
export type RhythmsRhythmRanEvent = z.infer<typeof RhythmsRhythmRanEvent>;
