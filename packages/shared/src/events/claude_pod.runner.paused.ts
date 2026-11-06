import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { BotRunnerId, WorkspaceId } from '../ids.ts';

/** Why a Claude Code runner stopped taking runs by itself. A fixed list of words, so the event holds no text from the CLI. */
export const ClaudePodPauseReason = z.enum(['plan_limit', 'needs_sign_in']);
export type ClaudePodPauseReason = z.infer<typeof ClaudePodPauseReason>;

/** A Claude Code runner paused itself: the plan's limit was reached (it resumes at `until`) or its sign-in was refused (an admin must upload a new file). Ids, the name and a reason only. */
export const ClaudePodRunnerPausedEvent = z.object({
  type: z.literal('claude_pod.runner.paused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  reason: ClaudePodPauseReason,
  until: IsoDateTime.nullable(),
  at: IsoDateTime,
});
export type ClaudePodRunnerPausedEvent = z.infer<typeof ClaudePodRunnerPausedEvent>;
