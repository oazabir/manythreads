import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An admin signed an agent runner (Claude Code or Codex on an agent bridge) in or out from the Runners page (P25-09): started a sign-in, gave the code or key the page asked
 * for, cancelled, or signed out; and how a sign-in ended (`login_succeeded`, `login_failed`, seen when the page asked for its state). The first four are written BEFORE the
 * bridge is asked, so a request that fails still leaves its line: `refused` is then set on a second line. The ids, the runner's name, the agent, the kind of change, the kind of
 * sign-in (`how`) and whether a code or a key was given (`answerKind`): never the code, the key, the page's address or anything the agent said about the account.
 */
export const BotRunnerAgentAuthChangedEvent = z.object({
  type: z.literal('bot_runner.agent_auth.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  agent: z.enum(['claude-code', 'codex']),
  change: z.enum(['login_started', 'answer_given', 'login_cancelled', 'signed_out', 'login_succeeded', 'login_failed']),
  /** The kind of sign-in: a code typed on a page, a code pasted back, an API key. Known for the end of a sign-in. */
  how: z.enum(['device_code', 'paste_code', 'api_key']).optional(),
  /** What the person gave with `answer_given`: a code or a key. */
  answerKind: z.enum(['code', 'key']).optional(),
  /** True on the line written when the bridge did not carry the request out (it was refused, or did not answer). */
  refused: z.boolean().optional(),
  /** The team whose own sign-in it was, on a runner where each team signs in (P35-10). Absent for a runner with one sign-in for all its teams. */
  teamId: TeamId.optional(),
  actorId: ActorId,
  at: IsoDateTime,
});
export type BotRunnerAgentAuthChangedEvent = z.infer<typeof BotRunnerAgentAuthChangedEvent>;
