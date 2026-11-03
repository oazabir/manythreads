import {
  HttpError,
  forbidden,
  invalid,
  json,
  notFound,
  requireTeam,
  route,
  type BlobStorage,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import { readMailHeaders, type MailEnvelope } from '@manythreads/sdk/extract';
import {
  INBOX_NAME_MAX,
  DeliverInboxMailParams,
  DeliverInboxMailQuery,
  DeliverInboxMailResponse,
  InboxEmailParams,
  InboxEmailResponse,
  deliverInboxMailRoute,
  getInboxEmailRoute,
  type InboxMailDelivery,
} from '@manythreads/shared';
import { loadInboxConfig, type InboxConfig } from './config.ts';
import { MAIL_TEAMS_MAX, combineAuth, inboxAddress, mailDomain, senderCheckOf, teamSlugsOf } from './mail-address.ts';
import { dropBytes } from './receive.ts';
import { inboxMaxBytes, takeUploadSlot, tapped, UploadStalledError, type ReadableLike } from './upload.ts';

// The email door (PLAN P8-19, SPEC section 12.2): mail sent to a team's address becomes an inbox item. The subject is the title, the attachments become items of their
// own (the pipeline's extract step makes them from the message, with the message's sender and trust), and NO bot runs for the message: a bot hears about a mail only
// through an `inbox` trigger of the connections plugin, which this door does not touch. A message to a team's address is filed by the platform, never answered.
//
// Who is let in is decided by two facts, kept apart. What the sending domain proved (SPF/DKIM) comes from the mail transport, in the query of the delivery, because
// every header inside a message is written by whoever sent it. Who the sender is comes from the From address, looked up among the workspace's people. Together they
// give the item's `sender_check` (`pass`: proved, and a person of this team or a workspace admin; `none`: proved, but a stranger; `fail`: not proved), and the
// pipeline's hold check does the rest (a failed check holds; a stranger holds unless the team named the address in `allowEmailFrom`).

const READ_LIMIT = { limit: 120, windowMs: 60_000 };

type Reader = ReadableLike;

async function workspaceRole(tx: PluginTx): Promise<string | null> {
  return (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role ?? null;
}

/** The workspace mailbox team addresses are made on: the oldest enabled `email` connection with workspace scope (read as the platform: only admins can see it as a person). */
async function mailboxOf(ctx: PluginContext, workspaceId: string, slug?: string): Promise<{ id: string; slug: string; name: string } | null> {
  return ctx.db.system(
    async (tx) =>
      (
        await tx.query<{ id: string; slug: string; name: string }>(
          `SELECT id, slug, name FROM app.connections
            WHERE workspace_id = $1 AND scope = 'workspace' AND kind = 'email' AND status = 'enabled' AND (expires_at IS NULL OR expires_at > now())
              AND ($2::text IS NULL OR slug = $2)
            ORDER BY created_at, id LIMIT 1`,
          [workspaceId, slug ?? null],
        )
      ).rows[0] ?? null,
    { workspaceId },
  );
}

/** The one sentence the Inbox tab shows about who is let in, from the team's own settings. */
export function ruleSentence(config: Pick<InboxConfig, 'review' | 'allowEmailFrom'>): string {
  if (config.review === 'all') return 'Every mail waits for a lead or admin to look at it first.';
  if (config.review === 'none') return 'Mail goes in as soon as the sender’s own domain has been checked. Mail that fails the check waits for a lead or admin.';
  return config.allowEmailFrom.length > 0
    ? 'Mail from people on this team goes straight in, and so does mail from the addresses listed here. Mail from anyone else, or that fails the sender check, waits for a lead or admin.'
    : 'Mail from people on this team goes straight in. Mail from anyone else, or that fails the sender check, waits for a lead or admin.';
}

interface Sender {
  address: string;
  actorId: string | null;
  name: string | null;
  trusted: boolean;
}

/** Who the From address is among the workspace's people, and whether they belong to this team (or are a workspace owner or admin). Platform-side reads only. */
async function senderOf(tx: PluginTx, workspaceId: string, teamId: string, address: string): Promise<Sender> {
  const person = (
    await tx.query<{ actor_id: string; display_name: string; role: string; in_team: boolean }>(
      `SELECT a.id AS actor_id, p.display_name, m.role,
              EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $2 AND tm.actor_id = a.id) AS in_team
         FROM app.people p
         JOIN app.workspace_members m ON m.person_id = p.id AND m.workspace_id = p.workspace_id
         JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id AND a.workspace_id = p.workspace_id
        WHERE p.workspace_id = $1 AND p.status = 'active'
          AND (lower(p.primary_email) = $3
               OR EXISTS (SELECT 1 FROM app.person_emails e WHERE e.person_id = p.id AND lower(e.email) = $3 AND e.verified_at IS NOT NULL))
        LIMIT 1`,
      [workspaceId, teamId, address],
    )
  ).rows[0];
  if (!person) return { address, actorId: null, name: null, trusted: false };
  const trusted = person.role !== 'guest' && (person.in_team || person.role === 'owner' || person.role === 'admin');
  return { address, actorId: person.actor_id, name: person.display_name, trusted };
}

interface Delivery {
  bytes: Uint8Array;
  envelope: MailEnvelope;
  auth: 'pass' | 'fail';
  connectionId: string;
}

/** One message into one team, as the platform. Returns what the transport is told about it. */
async function deliverToTeam(ctx: PluginContext, storage: BlobStorage, workspaceId: string, teamSlug: string, mail: Delivery): Promise<InboxMailDelivery> {
  return ctx.db.system(
    async (tx): Promise<InboxMailDelivery> => {
      const team = (
        await tx.query<{ id: string; workspace_id: string; archived_at: Date | null }>('SELECT id, workspace_id, archived_at FROM app.teams WHERE workspace_id = $1 AND slug = $2', [workspaceId, teamSlug])
      ).rows[0];
      if (!team) return { teamSlug, status: 'ignored', itemId: null, reason: 'There is no team with that name.' };
      if (team.archived_at) return { teamSlug, status: 'ignored', itemId: null, reason: 'This team is archived, so its inbox takes no mail.' };

      // one message, one item: the same Message-ID for the same team is the first delivery again
      if (mail.envelope.messageId !== null) {
        const logged = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.memory_inbox_mail (workspace_id, team_id, connection_id, message_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (team_id, message_id) DO NOTHING RETURNING id`,
            [workspaceId, team.id, mail.connectionId, mail.envelope.messageId],
          )
        ).rows[0];
        if (!logged) {
          const earlier = (await tx.query<{ item_id: string | null }>('SELECT item_id FROM app.memory_inbox_mail WHERE team_id = $1 AND message_id = $2', [team.id, mail.envelope.messageId])).rows[0];
          return { teamSlug, status: 'duplicate', itemId: (earlier?.item_id ?? null) as InboxMailDelivery['itemId'], reason: 'This message was already delivered to this team.' };
        }
      }

      const address = mail.envelope.from[0] as string;
      const sender = await senderOf(tx, workspaceId, team.id, address);
      const check = senderCheckOf(mail.auth, sender.trusted);
      // an item is credited to a person only when the sending domain proved the mail and the person belongs here: a forged mail never carries a real name
      const credited = check === 'pass' && sender.actorId !== null;
      const name = (mail.envelope.subject ?? '(no subject)').replace(/\s+/g, ' ').trim().slice(0, INBOX_NAME_MAX) || '(no subject)';
      const dropped = await dropBytes(ctx, tx, { id: team.id, workspace_id: team.workspace_id, archived_at: team.archived_at }, storage, mail.bytes, {
        origin: 'email',
        kind: 'eml',
        name,
        teamOnly: false,
        dropperId: credited ? sender.actorId : null,
        dropperName: credited ? sender.name : null,
        sender: address,
        senderCheck: check,
      });
      if (mail.envelope.messageId !== null) {
        await tx.query('UPDATE app.memory_inbox_mail SET item_id = $3 WHERE team_id = $1 AND message_id = $2', [team.id, mail.envelope.messageId, dropped.item.id]);
      }
      return { teamSlug, status: dropped.duplicate ? 'duplicate' : 'received', itemId: dropped.item.id as InboxMailDelivery['itemId'], reason: dropped.duplicate ? 'The same message is already in this team’s inbox.' : null };
    },
    { workspaceId },
  );
}

export function registerEmailDoor(ctx: PluginContext): void {
  const storageOf = (): BlobStorage => {
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
    return storage;
  };

  // The address, for the Inbox tab.
  ctx.http.route({
    ...getInboxEmailRoute,
    schema: { response: InboxEmailResponse },
    rateLimit: READ_LIMIT,
    handler: route(async (req, tx) => {
      const { slug } = InboxEmailParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const role = await workspaceRole(tx);
      if (role === 'guest') throw forbidden('A guest has no team inbox.');
      const canSetUp = role === 'owner' || role === 'admin';
      const config = await loadInboxConfig(ctx, tx, team.id);
      const box = await mailboxOf(ctx, team.workspace_id);
      const reason = box
        ? null
        : canSetUp
          ? 'The workspace has no mailbox for team inboxes yet. Switch it on once and every team gets an address.'
          : 'The workspace has no mailbox for team inboxes yet. Ask a workspace admin to switch it on.';
      return json(
        InboxEmailResponse.parse({
          address: box ? inboxAddress(box.slug, slug, mailDomain()) : null,
          connection: box ? { slug: box.slug, name: box.name } : null,
          reason,
          allowedSenders: config.allowEmailFrom,
          rule: ruleSentence(config),
          canSetUp,
        }),
      );
    }),
  });

  // Delivery: the transport (or an admin, until there is a real one) pushes a received message through. The body is the message.
  ctx.http.route({
    ...deliverInboxMailRoute,
    rawBody: true,
    schema: { query: DeliverInboxMailQuery, response: DeliverInboxMailResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const source = req.stream as Reader | undefined;
      const drain = (): void => void source?.resume?.();
      try {
        const { connection: connectionSlug } = DeliverInboxMailParams.parse(req.params);
        const query = DeliverInboxMailQuery.parse(req.query);
        const role = await workspaceRole(tx);
        if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can put mail into a team inbox.');
        const box = await mailboxOf(ctx, tx.actor.workspaceId, connectionSlug);
        if (!box) throw notFound(`The workspace has no switched-on mailbox called “${connectionSlug}”.`);
        if (!source) throw invalid('The body must be the message');
        const limit = inboxMaxBytes();
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'validation_failed', `That message is larger than the ${String(Math.max(1, Math.floor(limit / 1024 / 1024)))} MB limit.`);
        const release = takeUploadSlot(tx.actor.id);
        if (!release) throw new HttpError(429, 'rate_limited', 'Too many messages are being delivered at once: wait for one to finish.');

        const parts: Uint8Array[] = [];
        let total = 0;
        try {
          for await (const part of tapped(source).stream) {
            total += part.length;
            if (total > limit) throw new HttpError(413, 'validation_failed', `That message is larger than the ${String(Math.max(1, Math.floor(limit / 1024 / 1024)))} MB limit.`);
            parts.push(part);
          }
        } catch (err) {
          if (err instanceof UploadStalledError) throw invalid('The delivery stalled.');
          throw err;
        } finally {
          release();
        }
        if (total === 0) throw invalid('That message is empty.');
        const bytes = Buffer.concat(parts);
        const envelope = readMailHeaders(bytes);
        if (envelope.from.length === 0) throw invalid('That is not an email message: it has no From address.');
        const domain = mailDomain();
        const slugs = teamSlugsOf(envelope, box.slug, domain);
        if (slugs.length === 0) throw invalid(`None of this message’s recipients is a team inbox address on ${domain}.`);

        const auth = combineAuth(query.spf, query.dkim);
        const storage = storageOf();
        const deliveries: InboxMailDelivery[] = [];
        for (const teamSlug of slugs.slice(0, MAIL_TEAMS_MAX)) {
          deliveries.push(await deliverToTeam(ctx, storage, tx.actor.workspaceId, teamSlug, { bytes, envelope, auth, connectionId: box.id }));
        }
        for (const teamSlug of slugs.slice(MAIL_TEAMS_MAX)) {
          deliveries.push({ teamSlug, status: 'ignored', itemId: null, reason: `A message is delivered to at most ${String(MAIL_TEAMS_MAX)} teams.` });
        }
        const anyNew = deliveries.some((d) => d.status === 'received');
        return json(DeliverInboxMailResponse.parse({ messageId: envelope.messageId, authentication: auth, deliveries }), anyNew ? 201 : 200);
      } catch (err) {
        drain();
        throw err;
      }
    }),
  });
}
