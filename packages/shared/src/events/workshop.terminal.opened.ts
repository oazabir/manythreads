import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, RunId, TeamId, TerminalSessionId, WorkspaceId } from '../ids.ts';

/**
 * An admin's terminal into a bot's sandbox opened (PLAN P7-09). `credentialsRevoked` is how many credentials minted for the sandbox run were revoked as it opened (the shell holds none).
 * Carries ids only: never what was typed or printed (that is the recording, which only workspace admins read).
 */
export const WorkshopTerminalOpenedEvent = z.object({
  type: z.literal('workshop.terminal.opened'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  sessionId: TerminalSessionId,
  /** The admin who opened it (their actor). */
  adminId: ActorId,
  /** The rehearsal run behind the sandbox. */
  runId: RunId,
  credentialsRevoked: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type WorkshopTerminalOpenedEvent = z.infer<typeof WorkshopTerminalOpenedEvent>;
