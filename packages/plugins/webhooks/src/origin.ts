import { route, type PluginContext } from '@manythreads/sdk';
import { GetRunOriginResponse, getRunOriginRoute } from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package H (P16-10, decision D21): "what started this run" for the card under a bot's post. Answers only for a run started by a work app's event and only to someone who can read
// the run's channel (`app.webhooks_run_origin`); anything else is a 404. Ids, the app's name, the kind and the event's title. STUB: 501 until H fills it in.
export function registerRunOrigin(ctx: PluginContext): void {
  ctx.http.route({
    ...getRunOriginRoute,
    schema: { response: GetRunOriginResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
