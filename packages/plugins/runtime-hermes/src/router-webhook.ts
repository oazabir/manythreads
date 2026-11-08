import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { PROVIDER_BOT_RUNS_PER_HOUR, WebhooksProviderEventReceivedEvent, WebhooksProviderEventRefusedEvent, type BotTrigger, type ProviderRefusalReason } from '@manythreads/shared';
import { buildWebhookPrompt } from './match.ts';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// The `webhook` trigger (PLAN Bundle D, P16-10, decisions D19 to D21). The webhooks plugin verifies a work app's delivery and says so with `webhooks.provider_event.received` (ids and
// the kind only); this turns that into one bot run per (event, bot), the way `router-inbox.ts` does for mail.
//
//  * The ids in the event are only a pointer. The stored event, its endpoint and the bots are read again from their rows and must agree with the event; an endpoint that was switched
//    off in the meantime starts nothing.
//  * Which bots: the active bots of the endpoint's team with a `webhook` trigger whose `connection` is the endpoint's short name (the name the lead gave it) and, when the trigger names an
//    `event`, whose kind matches (`ticket.created`, or `ticket.*` for everything under `ticket.`). A bot with no such trigger gets nothing, and a trigger with no `connection` matches no endpoint.
//  * Where the run answers: at the top of the endpoint's channel (the post opens the thread; its `meta.runId` is stamped because the channel's capabilities allow a `webhook` run to post
//    there). A bot that may not post in that channel gets no run, and the lead is told once a minute (`no_channel`).
//  * No asker: the run has the bot's own rights, like an inbox run. Nothing in the app's text is an instruction: it travels inside one fenced block (`buildWebhookPrompt`).
//  * Exactly one run per (event, bot): a latch row in `outbox_processed` is written here, and the run itself claims the delivery again with `app.webhooks_claim_run` when it opens, so a
//    redelivery of the announcement and a replayed job both stop. A bot is also capped at 30 webhook runs an hour (`bot_busy`: dropped, and the lead is told once a minute).

const subscriberOf = (botId: string): string => `runtime-hermes:webhook:${botId}`;

interface EventRow {
  id: string;
  webhook_id: string;
  team_id: string;
  channel_id: string;
  provider: string;
  kind: string;
  title: string | null;
  url: string | null;
  actor_label: string | null;
  payload: { data?: unknown } | null;
  received_at: Date;
  slug: string;
  name: string;
  revoked_at: Date | null;
  live: boolean;
  [key: string]: unknown;
}

interface BotRow {
  id: string;
  slug: string;
  name: string;
  triggers: BotTrigger[] | null;
  actor_id: string;
  [key: string]: unknown;
}

/** An exact kind, or `ticket.*` for everything under `ticket.`. */
export const webhookKindMatches = (pattern: string, kind: string): boolean => (pattern.endsWith('.*') ? kind.startsWith(pattern.slice(0, -1)) : pattern === kind);

export function registerWebhookRouter(ctx: PluginContext): void {
  // A refusal is told at most once a minute for each endpoint and reason, with how many were held back.
  const told = new Map<string, { at: number; held: number }>();
  const tell = async (tx: PluginTx, e: WebhooksProviderEventReceivedEvent, reason: ProviderRefusalReason, why: string): Promise<void> => {
    const now = ctx.runtime.now().getTime();
    const key = `${e.webhookId}:${reason}`;
    const seen = told.get(key);
    if (seen && now - seen.at < 60_000) {
      seen.held += 1;
      return;
    }
    console.warn(`runtime-hermes: ${why}`);
    const count = 1 + (seen?.held ?? 0);
    told.set(key, { at: now, held: 0 });
    if (told.size > 2_000) for (const [k, v] of told) if (now - v.at >= 60_000) told.delete(k);
    await ctx.audit.emit(
      tx,
      WebhooksProviderEventRefusedEvent.parse({
        type: 'webhooks.provider_event.refused',
        schemaVersion: 1,
        workspaceId: e.workspaceId,
        teamId: e.teamId,
        channelId: e.channelId,
        webhookId: e.webhookId,
        provider: e.provider,
        reason,
        count,
        at: ctx.runtime.now().toISOString(),
      }),
    );
  };

  ctx.events.subscribe('webhooks.provider_event.received', async (raw: PluginEvent, tx: PluginTx) => {
    const event = WebhooksProviderEventReceivedEvent.parse(raw);

    const row = (
      await tx.query<EventRow>(
        `SELECT e.id, e.webhook_id, w.team_id, w.channel_id, e.provider, e.kind, e.title, e.url, e.actor_label, e.payload, e.received_at, p.slug, w.name, w.revoked_at, p.live
           FROM app.webhook_provider_events e
           JOIN app.webhooks w ON w.id = e.webhook_id
           JOIN app.webhook_provider p ON p.webhook_id = w.id
          WHERE e.id = $1::uuid AND e.workspace_id = $2::uuid`,
        [event.eventId, event.workspaceId],
      )
    ).rows[0];
    if (!row) return;
    if (row.webhook_id !== event.webhookId || row.team_id !== event.teamId || row.channel_id !== event.channelId || row.provider !== event.provider || row.kind !== event.kind) {
      console.warn(`runtime-hermes: delivery ${event.eventId} does not match its rows; no run started`);
      return;
    }
    // switched off or revoked since the app called: nothing starts
    if (row.revoked_at !== null || !row.live) return;

    const bots = (
      await tx.query<BotRow>(
        `SELECT b.id, b.slug, b.name, b.triggers, a.id AS actor_id
           FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id
          WHERE b.team_id = $1::uuid AND b.workspace_id = $2::uuid AND b.status = 'active'
          ORDER BY b.slug`,
        [event.teamId, event.workspaceId],
      )
    ).rows;

    for (const bot of bots) {
      const listens = (bot.triggers ?? []).some((t) => t.type === 'webhook' && t.connection === row.slug && (t.event === undefined || webhookKindMatches(t.event, row.kind)));
      if (!listens) continue;

      const canPost = (await tx.query<{ ok: boolean }>('SELECT app.channel_actor_can_post($1::uuid, $2::uuid) AS ok', [bot.actor_id, event.channelId])).rows[0]?.ok === true;
      if (!canPost) {
        await tell(tx, event, 'no_channel', `bot ${bot.slug} cannot post in the channel of address “${row.slug}”; the delivery ${event.eventId} starts no run for it`);
        continue;
      }

      const recent = Number(
        (
          await tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.outbox_processed WHERE subscriber = $1 AND processed_at > now() - interval '1 hour'`, [subscriberOf(bot.id)])
        ).rows[0]?.n ?? '0',
      );
      if (recent >= PROVIDER_BOT_RUNS_PER_HOUR) {
        await tell(tx, event, 'bot_busy', `bot ${bot.slug} has started ${PROVIDER_BOT_RUNS_PER_HOUR} runs from work apps in the last hour; the delivery ${event.eventId} is dropped for it`);
        continue;
      }

      // first time this bot sees this delivery (a redelivered announcement finds the row and stops)
      const first = await tx.query(`INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`, [subscriberOf(bot.id), event.eventId]);
      if (first.rows.length === 0) continue;

      const prompt = buildWebhookPrompt({
        provider: row.provider,
        kind: row.kind,
        endpoint: row.slug,
        receivedAt: row.received_at.toISOString(),
        title: row.title,
        url: row.url,
        actor: row.actor_label,
        payload: row.payload?.data ?? null,
        self: { name: bot.name, slug: bot.slug },
      });
      const payload: RunPayload = {
        workspaceId: event.workspaceId,
        botId: bot.id,
        teamId: event.teamId,
        channelId: event.channelId,
        trigger: 'webhook',
        askerActorId: null,
        replyRootId: null,
        runThreadId: null,
        prompt,
        text: prompt.slice(0, 40_000),
        webhook: { eventId: event.eventId },
      };
      await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:webhook:${event.eventId}` });
    }
  });
}
