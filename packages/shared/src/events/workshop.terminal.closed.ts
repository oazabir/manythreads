import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, TeamId, TerminalSessionId, WorkspaceId } from '../ids.ts';
import { TerminalEndReason } from '../entities/terminal.ts';

/** A terminal into a bot's sandbox ended (PLAN P7-09): why, for how long, and how much went in and out. Counts and ids only. */
export const WorkshopTerminalClosedEvent = z.object({
  type: z.literal('workshop.terminal.closed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  sessionId: TerminalSessionId,
  adminId: ActorId,
  reason: TerminalEndReason,
  /** How long the shell was open; 0 for a terminal that never connected. */
  durationMs: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  /** True when the recorded text was cut at the size limit. */
  truncated: z.boolean(),
  at: IsoDateTime,
});
export type WorkshopTerminalClosedEvent = z.infer<typeof WorkshopTerminalClosedEvent>;
