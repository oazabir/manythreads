import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ConnectionsInboxClaimedEvent, type BotTrigger } from '@manythreads/shared';
import { buildInboxPrompt } from './match.ts';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// The `inbox` trigger (PLAN P8-30). The connections plugin's watch claims a mail thread for a bot and says so with `connections.inbox.claimed`; this turns that into
// exactly one bot run, the way `router-rhythms.ts` turns a firing into one.
//
//  * The ids in the event are only a pointer. The bot, the claim, the mail and the connection are read again from their rows and must agree with each other and with the
//    event; a bot that is no longer active, or no longer lists an `inbox` trigger, gets no run (the claim stays: the thread is not answered later by surprise).
//  * Where the run answers: an inbox run has no thread to answer in (the mail is not a channel message). It posts at the top of the channel the trigger names
//    (`channel: "#support"`), or, with none, the first public channel of the team the bot may post in. The post it makes opens the thread the conversation continues in,
//    and the connections plugin links the mail to that post (link.ts).
//  * Exactly one run per claim: the job's dedupe key is the claim's id, and a durable latch row keeps a second delivery of the event, after the first run has finished, from
//    starting another. The claim itself is unique per (connection, bot, mail thread), so the same mail twice never gets here twice.
//  * The mail's text is never an instruction: it travels inside a fenced block labelled as the sender's words (`buildInboxPrompt`).

interface BotRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  triggers: BotTrigger[] | null;
  actor_id: string;
  [key: string]: unknown;
}

interface MailRow {
  claim_bot: string;
  claim_connection: string;
  claim_mail: string;
  claim_team: string;
  slug: string;
  kind: string;
  from_address: string;
  subject: string;
  body: string;
  direction: string;
  created_at: Date;
  [key: string]: unknown;
}

/** The channel a named trigger points at (by name, public, in the team, not archived, and one the bot may post in), or null. */
async function namedChannel(tx: PluginTx, teamId: string, botActorId: string, ref: string): Promise<string | null> {
  return (
    (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c
          WHERE c.team_id = $1::uuid AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL AND lower(c.name) = lower($3)
            AND app.channel_actor_can_post($2::uuid, c.id)
          LIMIT 1`,
        [teamId, botActorId, ref.slice(1)],
      )
    ).rows[0]?.id ?? null
  );
}

/** The first public channel of the team the bot may post in, or null. */
async function homeChannel(tx: PluginTx, teamId: string, botActorId: string): Promise<string | null> {
  return (
    (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c
          WHERE c.team_id = $1::uuid AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL
            AND app.channel_actor_can_post($2::uuid, c.id)
          ORDER BY c.position, c.created_at, c.id LIMIT 1`,
        [teamId, botActorId],
      )
    ).rows[0]?.id ?? null
  );
}

/** True the first time a claim is seen, false for every later delivery (kernel `outbox_processed`, written with the job). */
async function firstDelivery(tx: PluginTx, claimId: string): Promise<boolean> {
  const row = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ('runtime-hermes:inbox', md5($1)::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    [claimId],
  );
  return row.rows.length > 0;
}

export function registerInboxRouter(ctx: PluginContext): void {
  ctx.events.subscribe('connections.inbox.claimed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ConnectionsInboxClaimedEvent.parse(raw);
    if (!(await firstDelivery(tx, event.claimId))) return;

    const bot = (
      await tx.query<BotRow>(
        `SELECT b.id, b.slug, b.name, b.status, b.triggers, a.id AS actor_id
           FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id
          WHERE b.id = $1::uuid AND b.team_id = $2::uuid AND b.workspace_id = $3::uuid`,
        [event.botId, event.teamId, event.workspaceId],
      )
    ).rows[0];
    if (!bot || bot.status !== 'active') return;

    const mail = (
      await tx.query<MailRow>(
        `SELECT c.bot_id AS claim_bot, c.connection_id AS claim_connection, c.mail_id AS claim_mail, c.team_id AS claim_team,
                k.slug, k.kind, m.from_address, m.subject, m.body, m.direction, m.created_at
           FROM app.connection_mail_claims c
           JOIN app.connections k ON k.id = c.connection_id AND k.team_id = c.team_id
           JOIN app.connection_messages m ON m.id = c.mail_id AND m.connection_id = c.connection_id
          WHERE c.id = $1::uuid AND c.workspace_id = $2::uuid`,
        [event.claimId, event.workspaceId],
      )
    ).rows[0];
    if (
      !mail ||
      mail.kind !== 'email' ||
      mail.direction !== 'in' ||
      mail.claim_bot !== bot.id ||
      mail.claim_connection !== event.connectionId ||
      mail.claim_mail !== event.mailId ||
      mail.claim_team !== event.teamId
    ) {
      console.warn(`runtime-hermes: inbox claim ${event.claimId} does not match its rows; no run started`);
      return;
    }

    const trigger = (bot.triggers ?? []).find(
      (t): t is Extract<BotTrigger, { type: 'inbox' }> => t.type === 'inbox' && (t.connection === undefined || t.connection === mail.slug),
    );
    if (!trigger) return;

    const channelId =
      (trigger.channel === undefined ? null : await namedChannel(tx, event.teamId, bot.actor_id, trigger.channel)) ?? (await homeChannel(tx, event.teamId, bot.actor_id));
    if (!channelId) {
      console.warn(`runtime-hermes: bot ${bot.slug} cannot post in any public channel of its team; the mail ${event.mailId} starts no run`);
      return;
    }

    const prompt = buildInboxPrompt({
      connection: mail.slug,
      from: mail.from_address,
      subject: mail.subject,
      receivedAt: mail.created_at.toISOString(),
      body: mail.body,
      self: { name: bot.name, slug: bot.slug },
    });
    const payload: RunPayload = {
      workspaceId: event.workspaceId,
      botId: bot.id,
      teamId: event.teamId,
      channelId,
      trigger: 'inbox',
      askerActorId: null,
      replyRootId: null,
      runThreadId: null,
      prompt,
      text: prompt.slice(0, 40_000),
      inbox: { claimId: event.claimId, connectionId: event.connectionId, mailId: event.mailId },
    };
    await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:inbox:${event.claimId}` });
  });
}
