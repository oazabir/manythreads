import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ConnectionId } from '../entities/connection.ts';
import { MailClaimId, MailMessageId } from '../entities/connection-mail.ts';
import { BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A mail was claimed for a bot's `inbox` trigger (PLAN P8-30): the connections plugin saw the first mail of a mail thread that the bot's trigger matches and
 * recorded the bot's claim on the thread, so the runtime opens exactly one run. Ids only: never the sender, the subject or any of the text (the runtime reads
 * the mail from its own row).
 */
export const ConnectionsInboxClaimedEvent = z.object({
  type: z.literal('connections.inbox.claimed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  connectionId: ConnectionId,
  botId: BotId,
  claimId: MailClaimId,
  mailId: MailMessageId,
  at: IsoDateTime,
});
export type ConnectionsInboxClaimedEvent = z.infer<typeof ConnectionsInboxClaimedEvent>;
