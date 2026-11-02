import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * An email digest of unread mentions, replies and direct messages was handed to the mailer for a person (P14-09). The payload counts what the mail
 * held and never says what was written, who wrote it, which channel it was in or where the mail went. The notifications plugin writes it as the system
 * actor. No `teamId`: only workspace admins read it from the event log.
 */
export const NotificationsDigestSentEvent = z.object({
  type: z.literal('notifications.digest.sent'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  /** Unread items the person had since the last digest. */
  itemCount: z.number().int().nonnegative(),
  /** How many of them the mail listed (the rest was "and N more"). */
  shownCount: z.number().int().nonnegative(),
  /** In how many channels and conversations the listed items were. */
  channelCount: z.number().int().nonnegative(),
});
export type NotificationsDigestSentEvent = z.infer<typeof NotificationsDigestSentEvent>;
