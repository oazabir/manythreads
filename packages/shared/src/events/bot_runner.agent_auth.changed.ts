import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/**
 * An admin signed an agent runner (Claude Code or Codex on an agent bridge) in or out from the Runners page (P25-09): started a sign-in, gave the code or key the page asked
 * for, cancelled, or signed out. The ids, the runner's name, the agent and the kind of change only: never the code, the key, the page's address or anything the agent
 * said about the account.
 */
export const BotRunnerAgentAuthChangedEvent = z.object({
  type: z.literal('bot_runner.agent_auth.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  agent: z.enum(['claude-code', 'codex']),
  change: z.enum(['login_started', 'answer_given', 'login_cancelled', 'signed_out']),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerAgentAuthChangedEvent = z.infer<typeof BotRunnerAgentAuthChangedEvent>;
