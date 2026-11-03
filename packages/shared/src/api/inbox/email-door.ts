import { z } from 'zod';
import { InboxItemId } from '../../entities/inbox.ts';
import type { ApiRoute } from '../client/route.ts';
import { ConnectionSlug } from '../../entities/connection.ts';
import { TeamSlug } from '../teams/common.ts';

// The email door of a team's memory inbox (PLAN P8-19, SPEC section 12.2). A workspace has one mailbox for the whole company (a connection of kind `email` with
// workspace scope); every team has an address on it, `<connection>+<team>@<mail domain>`. Mail sent to that address becomes an inbox item: the subject is its
// title, the attachments are items of their own, and no bot runs for the message. docs/plugins/memory-inbox.md.

export const InboxEmailParams = z.object({ slug: TeamSlug });
export type InboxEmailParams = z.infer<typeof InboxEmailParams>;

/**
 * What the Inbox tab shows about the team's address. `address` is null when the workspace has no mailbox for it yet, with `reason` in plain words (and, for an
 * admin, the way to set it up). `allowedSenders` are the addresses and domains the team's settings let in from outside the team (`memory.inbox.allowEmailFrom`).
 */
export const InboxEmailResponse = z.object({
  address: z.string().nullable(),
  connection: z.object({ slug: ConnectionSlug, name: z.string() }).nullable(),
  reason: z.string().nullable(),
  allowedSenders: z.array(z.string()),
  /** The rule in one sentence for the screen: who is let in straight away and who waits for a lead or admin. */
  rule: z.string(),
  /** Whether the signed-in person may set up the workspace mailbox (a workspace admin). */
  canSetUp: z.boolean(),
});
export type InboxEmailResponse = z.infer<typeof InboxEmailResponse>;
export const getInboxEmailRoute = { method: 'GET', path: '/api/teams/:slug/inbox/email' } as const satisfies ApiRoute;

/** A workspace admin switches the workspace mailbox on: one `email` connection with workspace scope, short name `inbox`. Answers the same on the second call. */
export const SetUpInboxMailResponse = z.object({
  connection: z.object({ slug: ConnectionSlug, name: z.string() }),
  created: z.boolean(),
  /** The domain addresses are made on (`MANYTHREADS_MAIL_DOMAIN`). */
  domain: z.string(),
});
export type SetUpInboxMailResponse = z.infer<typeof SetUpInboxMailResponse>;
export const setUpInboxMailRoute = { method: 'POST', path: '/api/workspace/inbox-mail' } as const satisfies ApiRoute;

/**
 * Delivery: the door the mail transport (or, until a real one exists, an admin) pushes a received message through. The body is the whole message (RFC 822, the
 * same bytes a `.eml` file holds). What the sending domain proved travels OUT of the message, in the query: the transport read SPF and DKIM when it took the
 * message in. A header inside the message ("Authentication-Results") is written by the sender and is never believed.
 */
export const InboxMailAuth = z.enum(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror']);
export type InboxMailAuth = z.infer<typeof InboxMailAuth>;
export const DeliverInboxMailParams = z.object({ connection: ConnectionSlug });
export type DeliverInboxMailParams = z.infer<typeof DeliverInboxMailParams>;
export const DeliverInboxMailQuery = z.object({ spf: InboxMailAuth.optional(), dkim: InboxMailAuth.optional() });
export type DeliverInboxMailQuery = z.infer<typeof DeliverInboxMailQuery>;

export const InboxMailDelivery = z.object({
  teamSlug: z.string(),
  /** `received` an item was made; `duplicate` this team already has this message; `ignored` the address named a team that cannot take it. */
  status: z.enum(['received', 'duplicate', 'ignored']),
  itemId: InboxItemId.nullable(),
  /** The item's first state (`queued`); the hold check runs next and may hold it. Null when ignored. */
  reason: z.string().nullable(),
});
export type InboxMailDelivery = z.infer<typeof InboxMailDelivery>;
export const DeliverInboxMailResponse = z.object({
  messageId: z.string().nullable(),
  /** `pass` when SPF or DKIM passed and neither failed; `fail` otherwise. */
  authentication: z.enum(['pass', 'fail']),
  deliveries: z.array(InboxMailDelivery),
});
export type DeliverInboxMailResponse = z.infer<typeof DeliverInboxMailResponse>;
export const deliverInboxMailRoute = { method: 'POST', path: '/api/workspace/inbox-mail/:connection' } as const satisfies ApiRoute;
