import type { MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import { recordUse, type WebhookRow } from './hooks.ts';

/**
 * Posts Markdown into the webhook's channel as the webhook itself, through the channels plugin's own door (`messages` provider), so the message is an
 * ordinary message: search indexes it, notifications and unread counts follow it, retention keeps or removes it, and the channel's rules decide who reads it.
 *
 * The transaction is the system role's (a webhook has no session), and for the duration of the post the acting actor is the webhook's own: a system-kind
 * actor row made with the webhook (migration 0001), so the stored author is the webhook, never a person and never "the system". The permission to post comes
 * from the system role, which is why the webhook row itself (the channel it was made for, by a lead) is what limits it to one channel.
 */
export async function postAsWebhook(ctx: PluginContext, hook: WebhookRow, text: string): Promise<{ messageId: string }> {
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) throw Object.assign(new Error('the channels plugin is not loaded'), { status: 503 });
  const posted = await ctx.db.system(
    async (sys) => {
      await sys.query('SELECT app.webhooks_act_as($1::uuid)', [hook.id]);
      const asHook: PluginTx = { actor: { kind: 'system', id: hook.actor_id, workspaceId: hook.workspace_id }, query: (t, v) => sys.query(t, v) };
      const done = await messages.post(asHook, { channelId: hook.channel_id, body: text });
      await sys.query(
        `UPDATE app.webhooks SET last_used_at = now(), last_status = 'posted', posted_count = posted_count + 1 WHERE id = $1::uuid`,
        [hook.id],
      );
      return done;
    },
    { workspaceId: hook.workspace_id },
  );
  return { messageId: posted.id };
}

/** The status a failed post carries (the provider's errors have one), or undefined for an unexpected failure. */
export const statusOf = (err: unknown): number | undefined => (typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined);

export { recordUse };
