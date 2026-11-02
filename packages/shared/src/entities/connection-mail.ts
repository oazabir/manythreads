import { z } from 'zod';
import { ConnectionId } from './connection.ts';

// The mailbox of a mail connection (PLAN P8-29): the mails the dummy transport keeps in the database, and the ids the `inbox` trigger (P8-30) hands around.
// A mail is TEXT other people wrote: nothing in a schema, an event or an audit row repeats its subject, sender or body.

export const MailMessageId = z.uuid().brand<'MailMessageId'>();
export type MailMessageId = z.infer<typeof MailMessageId>;
/** One bot's claim on one mail thread: the row that makes "one run per bot per mail thread" true. */
export const MailClaimId = z.uuid().brand<'MailClaimId'>();
export type MailClaimId = z.infer<typeof MailClaimId>;

/** `in` arrived from outside, `out` was sent through the connection, `draft` was saved and not sent. */
export const MailDirection = z.enum(['in', 'out', 'draft']);
export type MailDirection = z.infer<typeof MailDirection>;

/** An address as a mail carries it. Plain, bounded, no display name (`name <a@b.c>` is not accepted here). */
export const MailAddress = z.email().max(320);
export type MailAddress = z.infer<typeof MailAddress>;

/** A mail's own id in a mail system (`Message-ID`): printable, no spaces, bounded. */
export const MailMessageRef = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\x21-\x7e]+$/, 'visible characters only, no spaces');
export type MailMessageRef = z.infer<typeof MailMessageRef>;

/** One mail as the delivery door answers it: where it landed, never what it said. */
export const DeliveredMail = z.strictObject({
  id: MailMessageId,
  connectionId: ConnectionId,
  /** The mail thread the mail belongs to: the first mail's own id, or the thread of the mail it answers. */
  threadKey: MailMessageRef,
  messageRef: MailMessageRef,
  /** True when this exact mail (same connection, same message id) was already there: nothing was added. */
  duplicate: z.boolean(),
});
export type DeliveredMail = z.infer<typeof DeliveredMail>;
