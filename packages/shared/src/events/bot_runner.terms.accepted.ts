import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotRunnerName } from '../entities/bot-runner.ts';
import { ActorId, BotRunnerId, WorkspaceId } from '../ids.ts';

/** An admin confirmed that the plan's provider terms allow sharing a subscription runner (Claude Code or Codex). Who and which runner; the sign-in task of the phase emits it. */
export const BotRunnerTermsAcceptedEvent = z.object({
  type: z.literal('bot_runner.terms.accepted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runnerId: BotRunnerId,
  name: BotRunnerName,
  acceptedBy: ActorId,
  at: IsoDateTime,
});
export type BotRunnerTermsAcceptedEvent = z.infer<typeof BotRunnerTermsAcceptedEvent>;
