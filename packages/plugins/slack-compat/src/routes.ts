import { createHash, randomUUID } from 'node:crypto';
import type { PluginContext } from '@manythreads/sdk';
import { z } from 'zod';
import { json, route, unauthenticated } from './http.ts';

// SPIKE (P5-01, docs/spikes/slack-compat.md): the narrow inbound door a Hermes platform plugin delivers through.
// Slack names kept on the wire (`chat.postMessage`, `thread_ts`, `ts`) so the Hermes adapter stays a thin POST.
//
// Shape: `POST /api/slack-compat/chat.postMessage` is PUBLIC (no session): the pairing token in the body IS the
// credential — the route hashes it and calls `app.bots_pairing_resolve` (granted to manythreads_app, no caller check),
// exactly the door the P5-09 gateway will use. The route does NO channel reads: an anonymous transaction sees no rows
// through RLS, so it only validates the shape, resolves the token (401 for unknown/revoked, one answer for both) and
// enqueues `slack-compat.deliver`. The SYSTEM job handler validates everything (channel, team, thread root, bot actor)
// and lands the message, so a forged channel id or thread root dies in the job, never in a reply.

/** The request the Hermes adapter sends: token, channel id, optional thread root, text. */
export const ChatPostMessageRequest = z.strictObject({
  /** A pairing token minted for the bot (`POST /api/teams/:slug/bots/:botSlug/pairing-tokens`), shown once. */
  token: z.string().min(1).max(500),
  /** The channel id to post into. */
  channel: z.string().uuid(),
  /** The thread root's message id: set for a thread reply, absent for a channel message. */
  thread_ts: z.string().uuid().optional(),
  /** Markdown text, 1 to 40,000 characters like any message. */
  text: z.string().min(1).max(40_000),
});
export type ChatPostMessageRequest = z.infer<typeof ChatPostMessageRequest>;

/** The answer: `ts` is the delivery id — the message carrying `meta.deliveryId = ts` is this call's. */
export const ChatPostMessageResponse = z.strictObject({
  ok: z.literal(true),
  channel: z.string().uuid(),
  ts: z.string().uuid(),
});
export type ChatPostMessageResponse = z.infer<typeof ChatPostMessageResponse>;

export const DELIVER_QUEUE = 'slack-compat.deliver';

/** What the route hands the SYSTEM job: everything the handler needs, already resolved from the token. */
export const DeliverPayload = z.strictObject({
  workspaceId: z.string().uuid(),
  teamId: z.string().uuid(),
  channelId: z.string().uuid(),
  threadRootId: z.string().uuid().nullable(),
  botActorId: z.string().uuid(),
  text: z.string().min(1).max(40_000),
  deliveryId: z.string().uuid(),
});
export type DeliverPayload = z.infer<typeof DeliverPayload>;

interface PairedBotRow {
  bot_id: string;
  team_id: string;
  workspace_id: string;
  actor_id: string;
  slug: string;
  [key: string]: unknown;
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export function registerChatRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: 'POST',
    path: '/api/slack-compat/chat.postMessage',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: ChatPostMessageRequest, response: ChatPostMessageResponse },
    handler: route(async (req, tx) => {
      const body = ChatPostMessageRequest.parse(req.body);
      const resolved = await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [hashToken(body.token)]);
      const paired = resolved.rows[0];
      if (!paired) throw unauthenticated();
      const deliveryId = randomUUID();
      const payload: DeliverPayload = {
        workspaceId: paired.workspace_id,
        teamId: paired.team_id,
        channelId: body.channel,
        threadRootId: body.thread_ts ?? null,
        botActorId: paired.actor_id,
        text: body.text,
        deliveryId,
      };
      await ctx.jobs.enqueue(tx, DELIVER_QUEUE, payload);
      return json(ChatPostMessageResponse.parse({ ok: true, channel: body.channel, ts: deliveryId }));
    }),
  });
}
