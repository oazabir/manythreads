import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';

// Work package H (P16-10, decisions D19 to D21): the `webhook` trigger. The webhooks plugin verifies a work app's delivery and says so with `webhooks.provider_event.received` (ids and the
// kind only); this turns that into one bot run per (event, bot), the way `router-inbox.ts` does for mail: the bots of the endpoint's team that are active and list a `webhook` trigger for
// this endpoint (and, when they name one, this kind of event), latched by `app.webhooks_claim_run`. The run has no asker (the bot's own rights), the event's text travels fenced as outside
// data, and the post lands at the top of the endpoint's channel with the run's `meta.runId`. STUB: the subscription exists and returns at once, so the event is consumed and nothing runs
// until H fills it in.
export function registerWebhookRouter(ctx: PluginContext): void {
  ctx.events.subscribe('webhooks.provider_event.received', async (raw: PluginEvent, tx: PluginTx) => {
    void [raw, tx];
  });
}
