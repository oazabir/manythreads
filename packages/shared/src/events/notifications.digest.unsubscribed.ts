import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person turned the email digest off (P14-09): with the link at the foot of a digest (`link`, no sign-in) or with the switch in their account
 * settings (`settings`). Written only when the digest was on before, so opening the link twice writes it once. The payload names the person and the
 * way, nothing else. No `teamId`: only workspace admins read it from the event log.
 */
export const NotificationsDigestUnsubscribedEvent = z.object({
  type: z.literal('notifications.digest.unsubscribed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  via: z.enum(['link', 'settings']),
});
export type NotificationsDigestUnsubscribedEvent = z.infer<typeof NotificationsDigestUnsubscribedEvent>;
