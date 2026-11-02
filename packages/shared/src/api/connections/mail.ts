import { z } from 'zod';
import { ConnectionSlug } from '../../entities/connection.ts';
import { DeliveredMail, MailAddress, MailMessageRef } from '../../entities/connection-mail.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The delivery door of the dummy mail transport (PLAN P8-29): a workspace admin puts a mail into a team connection's mailbox, for tests and for the support
// journey. It is the same door a real provider would deliver through. The mail is stored as it arrived; the answer says where it landed and carries no text.
// docs/plugins/connections.md.

export const DeliverMailParams = z.object({ slug: TeamSlug, connection: ConnectionSlug });
export type DeliverMailParams = z.infer<typeof DeliverMailParams>;

export const DeliverMailRequest = z.strictObject({
  from: MailAddress,
  to: MailAddress,
  subject: z.string().max(300),
  body: z.string().max(40_000),
  /** The mail's own id. Left out, the platform makes one (and a second delivery is then a second mail). The same id twice is one mail. */
  messageRef: MailMessageRef.optional(),
  /** The id of the mail this one answers: it joins that mail's thread when the mailbox holds it. */
  inReplyTo: MailMessageRef.optional(),
  /** Where it landed in the mailbox (default `INBOX`). */
  folder: z.string().min(1).max(100).optional(),
});
export type DeliverMailRequest = z.infer<typeof DeliverMailRequest>;

export const DeliverMailResponse = z.strictObject({ mail: DeliveredMail });
export type DeliverMailResponse = z.infer<typeof DeliverMailResponse>;
export const deliverMailRoute = { method: 'POST', path: '/api/teams/:slug/connections/:connection/mail' } as const satisfies ApiRoute;
