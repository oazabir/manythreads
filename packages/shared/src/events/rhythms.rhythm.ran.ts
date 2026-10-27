import { z } from 'zod';
import { RhythmKind, RhythmRunStatus } from '../entities/rhythm.ts';
import { BotId, RhythmId, RhythmRunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A rhythm's run changed state (PLAN P6-08): filed as `queued` (the runtime then starts the bot), `running` when the bot's run opened, and
 * `done` or `failed` with the reason (a bad contract, a bot that cannot be woken, a run that wrote no output).
 */
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
  /**
   * What the runtime needs to start a queued run, so it never reads the rhythm's tables or contract file itself (added after the first
   * release of this event; an older event without them reads as empty): the rhythm's name, the routine contract's prompt and output
   * mode, and the rhythm's own model alias and effort overrides.
   */
  rhythmName: z.string().max(80).default(''),
  prompt: z.string().max(20_000).default(''),
  outputMode: z.enum(['create', 'replace', 'append']).nullable().default(null),
  modelAlias: z.string().max(40).nullable().default(null),
  effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
});
export type RhythmsRhythmRanEvent = z.infer<typeof RhythmsRhythmRanEvent>;
