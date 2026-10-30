import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { EvalMode, EvalRunStatus, EvalTrigger } from '../entities/eval.ts';
import { BotEvalRunId, BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A run of a bot's scenario set ended (PLAN P7-08), whoever started it: a lead on demand, a commit that changed the bot's BOT.md or its set, or the
 * nightly pass. `ok` is false when the score is below the BOT.md's `minScore` (what the bot page flags); null when nothing could be judged or the run
 * failed (`status: 'failed'`). Counts and the score only, never a case's answer text.
 */
export const BotsEvalRunFinishedEvent = z.object({
  type: z.literal('bots.eval.run.finished'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  runId: BotEvalRunId,
  set: z.string(),
  trigger: EvalTrigger,
  mode: EvalMode,
  status: EvalRunStatus,
  commitSha: z.string().nullable(),
  total: z.number().int().min(0),
  judged: z.number().int().min(0),
  passed: z.number().int().min(0),
  score: z.number().min(0).max(1).nullable(),
  minScore: z.number().min(0).max(1),
  ok: z.boolean().nullable(),
  at: IsoDateTime,
});
export type BotsEvalRunFinishedEvent = z.infer<typeof BotsEvalRunFinishedEvent>;
