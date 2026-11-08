import { json, notFound, route, type PluginContext } from '@manythreads/sdk';
import { GetRunOriginResponse, RunOriginPathParams, getRunOriginRoute } from '@manythreads/shared';

// Work package H (P16-10, decision D21): "what started this run" for the card under a bot's post. Answers only for a run started by a work app's event and only to someone who can read
// the run's channel (`app.webhooks_run_origin` checks `visible_channel_ids('read')`); anything else, including a run that no event started, is the same 404. Ids, the app's name, the
// kind and the event's title, link and actor: never the stored payload.
export function registerRunOrigin(ctx: PluginContext): void {
  ctx.http.route({
    ...getRunOriginRoute,
    schema: { response: GetRunOriginResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { runId } = RunOriginPathParams.parse(req.params);
      const row = (
        await tx.query<{ provider: string; endpoint_name: string; kind: string; title: string | null; url: string | null; actor_label: string | null; received_at: Date; delivery_key: string }>(
          'SELECT provider, endpoint_name, kind, title, url, actor_label, received_at, delivery_key FROM app.webhooks_run_origin($1::uuid)',
          [runId],
        )
      ).rows[0];
      if (!row) throw notFound('Nothing started this run');
      return json(
        GetRunOriginResponse.parse({
          origin: {
            provider: row.provider,
            endpointName: row.endpoint_name,
            kind: row.kind,
            title: row.title,
            url: row.url,
            actorLabel: row.actor_label,
            receivedAt: row.received_at.toISOString(),
            verified: true,
            deliveryKey: row.delivery_key,
          },
        }),
      );
    }),
  });
}
