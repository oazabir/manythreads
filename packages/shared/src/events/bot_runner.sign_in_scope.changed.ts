import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName, BotRunnerSignInScope } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin changed who signs a Claude Code or Codex runner in (P35-10): one sign-in for all its teams (`shared`) or each team on its own (`per_team`). The old sign-ins
 * were signed out and removed. Content-blind: the two scopes and how many team sign-ins were signed out, never an account or a team's name.
 */
export const BotRunnerSignInScopeChangedEvent = z.object({
  type: z.literal('bot_runner.sign_in_scope.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  from: BotRunnerSignInScope,
  to: BotRunnerSignInScope,
  /** How many sign-ins were signed out on the way (the shared one counts as one). */
  signedOut: z.number().int().min(0).max(10_000),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerSignInScopeChangedEvent = z.infer<typeof BotRunnerSignInScopeChangedEvent>;
