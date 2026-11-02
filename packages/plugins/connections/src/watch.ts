import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { ConnectionsInboxClaimedEvent, type BotTrigger } from '@manythreads/shared';
import { z } from 'zod';
import { createDummyTransport, wordsOf } from './email/dummy.ts';
import type { MailSummary } from './email/transport.ts';

// The inbox watch (PLAN P8-30): the job that turns a mail arriving on a connection into ONE run of each bot whose `inbox` trigger matches it.
//
//   poll      every minute for every workspace, and at once for one connection when the delivery door puts a mail in. It asks the connection's transport for the newest inbound
//             mail of the last two days (at most 200), through the same `EmailTransport` interface a real transport implements.
//   match     a bot is watched when it is active, its definition lists an `inbox` trigger naming the connection (or no connection: any mail connection of its team), the connection
//             is switched on and usable, and the bot HOLDS `email.read` on that connection: the mail's text goes into the bot's prompt, so the bot must be one that may read it.
//             The trigger's `folder` (default INBOX) and `filter` (words that must all appear in the subject or the sender, any case) narrow it further.
//   dedupe    by MAIL THREAD, per bot: the first matching mail of a thread inserts a claim (`connection_mail_claims`, unique on connection + bot + thread) and emits
//             `connections.inbox.claimed`; the runtime turns that event into one run. A second mail in a thread the bot already claimed, the same mail twice, and a poll that sees the
//             same mail again all find the claim and do nothing. The claim and the event are written in one transaction, so a claim without its event cannot exist.
//
// Bounded: a pass claims at most `MAX_CLAIMS_PER_BOT` threads per bot and connection (the rest wait for the next pass), looks back `LOOKBACK_HOURS`, and reads at most `LIST_LIMIT` mails.
// A mail older than the look-back that no bot claimed is never answered: switching a bot on does not make it answer last month's mail.

export const WATCH_QUEUE = 'connections.inbox-watch';
const LOOKBACK_HOURS = 48;
const LIST_LIMIT = 200;
const MAX_CLAIMS_PER_BOT = 20;

/** The payload of a targeted pass (the delivery door's): one connection of one workspace. A pass with no payload (the cron's) looks at every workspace. */
export const WatchPayload = z.strictObject({ workspaceId: z.uuid(), connectionId: z.uuid() });
export type WatchPayload = z.infer<typeof WatchPayload>;

type InboxTrigger = Extract<BotTrigger, { type: 'inbox' }>;

/** Does the trigger fire for this mail? Pure and linear: plain word search, no pattern the mail's text could make slow. */
export function triggerMatches(trigger: InboxTrigger, connectionSlug: string, mail: Pick<MailSummary, 'folder' | 'subject' | 'from'>): boolean {
  if (trigger.connection !== undefined && trigger.connection !== connectionSlug) return false;
  if (mail.folder.toLowerCase() !== (trigger.folder ?? 'INBOX').toLowerCase()) return false;
  const haystack = `${mail.subject} ${mail.from}`.toLowerCase();
  return wordsOf(trigger.filter).every((word) => haystack.includes(word));
}

type Pair = {
  bot_id: string;
  team_id: string;
  workspace_id: string;
  triggers: BotTrigger[] | null;
  connection_id: string;
  slug: string;
  [key: string]: unknown;
};

/** Every (bot, connection) pair a pass may act on: see the header for the conditions. `connectionId` narrows to one connection. */
const PAIRS = `
  SELECT b.id AS bot_id, b.team_id, b.workspace_id, b.triggers, c.id AS connection_id, c.slug
    FROM app.bots b
    JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
    JOIN app.connections c ON c.team_id = b.team_id AND c.workspace_id = b.workspace_id AND c.scope = 'team' AND c.kind = 'email'
                          AND c.status = 'enabled' AND c.has_credentials AND (c.expires_at IS NULL OR c.expires_at > now())
    JOIN app.connection_grants g ON g.actor_id = a.id AND g.connection_id = c.id AND g.tool = 'email.read'
   WHERE b.workspace_id = $1 AND b.status = 'active' AND ($2::uuid IS NULL OR c.id = $2::uuid)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.triggers) = 'array' THEN b.triggers ELSE '[]'::jsonb END) t WHERE t ->> 'type' = 'inbox' AND (t ->> 'connection' IS NULL OR t ->> 'connection' = c.slug))
   ORDER BY c.id, b.id`;

/**
 * One pass over one workspace (or one connection of it). `tx` is a system transaction scoped to the workspace. Returns how many threads it claimed. Safe to run twice and
 * concurrently with itself: the claim's uniqueness decides, never the order of the runs.
 */
export async function watchInbox(ctx: PluginContext, tx: PluginTx, scope: { workspaceId: string; connectionId?: string | undefined }): Promise<number> {
  const pairs = (await tx.query<Pair>(PAIRS, [scope.workspaceId, scope.connectionId ?? null])).rows;
  if (pairs.length === 0) return 0;
  const since = new Date(ctx.runtime.now().getTime() - LOOKBACK_HOURS * 3_600_000);

  const mailOf = new Map<string, MailSummary[]>();
  let claimed = 0;
  for (const pair of pairs) {
    let mails = mailOf.get(pair.connection_id);
    if (!mails) {
      // oldest first, so the first mail of a thread is the one that opens it
      mails = (await createDummyTransport(tx, { id: pair.connection_id }).list({ direction: 'in', since, limit: LIST_LIMIT })).reverse();
      mailOf.set(pair.connection_id, mails);
    }
    const triggers = (pair.triggers ?? []).filter((t): t is InboxTrigger => t.type === 'inbox');
    const matching = mails.filter((mail) => triggers.some((t) => triggerMatches(t, pair.slug, mail)));
    if (matching.length === 0) continue;

    const seen = new Set(
      (
        await tx.query<{ thread_key: string }>('SELECT thread_key FROM app.connection_mail_claims WHERE connection_id = $1::uuid AND bot_id = $2::uuid AND thread_key = ANY ($3::text[])', [
          pair.connection_id,
          pair.bot_id,
          [...new Set(matching.map((m) => m.threadKey))],
        ])
      ).rows.map((r) => r.thread_key),
    );
    let claimsHere = 0;
    for (const mail of matching) {
      if (seen.has(mail.threadKey)) continue;
      seen.add(mail.threadKey);
      if (claimsHere >= MAX_CLAIMS_PER_BOT) break;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO app.connection_mail_claims (workspace_id, team_id, connection_id, bot_id, thread_key, mail_id)
         VALUES ($1, $2, $3, $4, $5, $6::uuid) ON CONFLICT (connection_id, bot_id, thread_key) DO NOTHING RETURNING id`,
        [pair.workspace_id, pair.team_id, pair.connection_id, pair.bot_id, mail.threadKey, mail.id],
      );
      const claimId = inserted.rows[0]?.id;
      if (!claimId) continue; // another pass claimed it between our read and our write
      claimsHere += 1;
      claimed += 1;
      await ctx.audit.emit(
        tx,
        ConnectionsInboxClaimedEvent.parse({
          type: 'connections.inbox.claimed',
          schemaVersion: 1,
          workspaceId: pair.workspace_id,
          teamId: pair.team_id,
          connectionId: pair.connection_id,
          botId: pair.bot_id,
          claimId,
          mailId: mail.id,
          at: ctx.runtime.now().toISOString(),
        }),
      );
    }
  }
  return claimed;
}

/** Registers the queue: a pass every minute over every workspace that has a watched connection, and the targeted pass the delivery door asks for. */
export function registerWatch(ctx: PluginContext): void {
  ctx.jobs.register(
    WATCH_QUEUE,
    async (raw, _unusable, job) => {
      const targeted = WatchPayload.safeParse(raw);
      if (targeted.success) {
        const n = await ctx.db.system((tx) => watchInbox(ctx, tx, targeted.data), { workspaceId: targeted.data.workspaceId });
        if (n > 0) job.log.info(`connections: ${String(n)} mail thread(s) claimed`);
        return;
      }
      const workspaces = await ctx.db.system(async (tx) =>
        (
          await tx.query<{ workspace_id: string }>(
            `SELECT DISTINCT b.workspace_id FROM app.bots b
              WHERE b.status = 'active' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.triggers) = 'array' THEN b.triggers ELSE '[]'::jsonb END) t WHERE t ->> 'type' = 'inbox') LIMIT 100`,
          )
        ).rows.map((r) => r.workspace_id),
      );
      for (const workspaceId of workspaces) {
        const n = await ctx.db.system((tx) => watchInbox(ctx, tx, { workspaceId }), { workspaceId });
        if (n > 0) job.log.info(`connections: ${String(n)} mail thread(s) claimed`);
      }
    },
    { cron: '* * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}
