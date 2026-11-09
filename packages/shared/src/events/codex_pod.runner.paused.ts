import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { BotRunnerId, WorkspaceId } from '../ids.ts';

/** Why a Codex runner stopped taking runs by itself. A fixed list of words, so the event holds no text from the CLI. */
export const CodexPodPauseReason = z.enum(['plan_limit', 'needs_sign_in']);
export type CodexPodPauseReason = z.infer<typeof CodexPodPauseReason>;

/** A Codex runner paused itself: the plan's limit was reached (it resumes at `until`) or its sign-in was refused (an admin must upload a new file). Ids, the name and a reason only. */
export const CodexPodRunnerPausedEvent = z.object({
  type: z.literal('codex_pod.runner.paused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  reason: CodexPodPauseReason,
  until: IsoDateTime.nullable(),
  at: IsoDateTime,
});
export type CodexPodRunnerPausedEvent = z.infer<typeof CodexPodRunnerPausedEvent>;
