import { json, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { BotWeek, Delivery, DeliveriesQuery, DeliveriesResponse, deliveriesRoute } from '@manythreads/shared';

/*
 * P35-05: the delivery dashboard. Everything is read as the caller (row-level security decides what they see): the team's threads where a bot ran in the
 * window, each with its runs, cards, pull requests, approvals and the people's replies after the request (the nudges), and per bot the week's runs. Spend is
 * the model gateway's (`app.llm_spend`, readable by workspace admins only): for anyone else it is null, never 0.
 */

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

interface DeliveryRow extends Record<string, unknown> {
  root_id: string;
  channel_id: string;
  channel_name: string;
  body: string;
  started_at: Date;
  runs: number;
  failed_runs: number;
  run_seconds: number;
  bots: string[];
  cards: number;
  done_cards: number;
  last_done: Date | null;
  prs: Array<{ number: number; url: string | null; state: string }> | null;
  approvals: number;
  nudges: number;
  spend: string | null;
}

export async function readDeliveries(tx: PluginTx, teamId: string, days: number): Promise<{ deliveries: Delivery[]; bots: BotWeek[] }> {
  const canSpend = (await tx.query<{ ok: boolean }>(`SELECT app.workspace_role() IN ('owner', 'admin') AS ok`)).rows[0]?.ok === true;
  const rows = (
    await tx.query<DeliveryRow>(
      `WITH roots AS (
         SELECT DISTINCT coalesce(r.reply_root_id, r.thread_id) AS root_id
           FROM app.bot_runs r
          WHERE r.team_id = $1::uuid AND r.started_at > now() - make_interval(days => $2::int) AND NOT r.rehearsal
            AND coalesce(r.reply_root_id, r.thread_id) IS NOT NULL
       )
       SELECT m.id AS root_id, m.channel_id, c.name AS channel_name, left(m.body, 200) AS body, m.created_at AS started_at,
              (SELECT count(*)::int FROM app.bot_runs r WHERE coalesce(r.reply_root_id, r.thread_id) = m.id) AS runs,
              (SELECT count(*)::int FROM app.bot_runs r WHERE coalesce(r.reply_root_id, r.thread_id) = m.id AND r.status = 'failed') AS failed_runs,
              (SELECT coalesce(sum(extract(epoch FROM (coalesce(r.ended_at, now()) - r.started_at))), 0)::float FROM app.bot_runs r WHERE coalesce(r.reply_root_id, r.thread_id) = m.id) AS run_seconds,
              (SELECT coalesce(array_agg(DISTINCT b.slug ORDER BY b.slug), '{}') FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE coalesce(r.reply_root_id, r.thread_id) = m.id) AS bots,
              (SELECT count(*)::int FROM app.tasks t WHERE t.thread_root_id = m.id) AS cards,
              (SELECT count(*)::int FROM app.tasks t WHERE t.thread_root_id = m.id AND t.state = 'done') AS done_cards,
              (SELECT max(t.completed_at) FROM app.tasks t WHERE t.thread_root_id = m.id) AS last_done,
              (SELECT jsonb_agg(jsonb_build_object('number', t.pull_request_number, 'url', t.pull_request_url, 'state', t.pull_request_state) ORDER BY t.pull_request_number)
                 FROM app.tasks t WHERE t.thread_root_id = m.id AND t.pull_request_number IS NOT NULL) AS prs,
              (SELECT count(*)::int FROM app.approvals a WHERE a.thread_root_id = m.id) AS approvals,
              -- a person's actor row is visible only to that person: the kind is read through the tasks plugin's door
              (SELECT count(*)::int FROM app.messages x
                WHERE x.thread_root_id = m.id AND x.deleted_at IS NULL AND (SELECT k.o_kind FROM app.tasks_actor_of(x.author_id) k) = 'person') AS nudges,
              CASE WHEN $3::boolean THEN (SELECT coalesce(sum(s.cost_usd), 0)::text FROM app.llm_spend s
                WHERE s.run_id IN (SELECT r.id FROM app.bot_runs r WHERE coalesce(r.reply_root_id, r.thread_id) = m.id)) END AS spend
         FROM roots JOIN app.messages m ON m.id = roots.root_id JOIN app.channels c ON c.id = m.channel_id
        WHERE m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 100`,
      [teamId, days, canSpend],
    )
  ).rows;
  const deliveries = rows.map((r) => {
    const finished = r.cards > 0 && r.done_cards === r.cards ? iso(r.last_done) : null;
    return Delivery.parse({
      rootId: r.root_id,
      channelId: r.channel_id,
      channelName: r.channel_name.replace(/^#/, ''),
      title: (r.body.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^[*#\s]+|\*+$/g, '').slice(0, 120),
      startedAt: iso(r.started_at),
      finishedAt: finished,
      minutes: finished ? Math.round((Date.parse(finished) - new Date(r.started_at).getTime()) / 60_000) : null,
      runs: r.runs,
      failedRuns: r.failed_runs,
      runMinutes: Math.round(num(r.run_seconds) / 6) / 10,
      bots: r.bots,
      cards: r.cards,
      doneCards: r.done_cards,
      pullRequests: r.prs ?? [],
      approvals: r.approvals,
      nudges: r.nudges,
      spendUsd: r.spend === null ? null : Math.round(Number(r.spend) * 100) / 100,
    });
  });
  const bots = (
    await tx.query<{ slug: string; name: string; runner: string | null; runs: number; failed_runs: number; avg_seconds: number; spend: string | null }>(
      `SELECT b.slug, b.name, b.placement ->> 'runs_on' AS runner, count(r.id)::int AS runs, count(r.id) FILTER (WHERE r.status = 'failed')::int AS failed_runs,
              coalesce(avg(extract(epoch FROM (coalesce(r.ended_at, now()) - r.started_at))), 0)::float AS avg_seconds,
              CASE WHEN $3::boolean THEN (SELECT coalesce(sum(s.cost_usd), 0)::text FROM app.llm_spend s WHERE s.bot_id = b.id AND s.occurred_at > now() - make_interval(days => $2::int)) END AS spend
         FROM app.bots b JOIN app.bot_runs r ON r.bot_id = b.id AND r.started_at > now() - make_interval(days => $2::int) AND NOT r.rehearsal
        WHERE b.team_id = $1::uuid
        GROUP BY b.id, b.slug, b.name, b.placement
        ORDER BY count(r.id) DESC`,
      [teamId, days, canSpend],
    )
  ).rows.map((b) =>
    BotWeek.parse({
      slug: b.slug,
      name: b.name,
      runner: b.runner,
      runs: b.runs,
      failedRuns: b.failed_runs,
      avgMinutes: Math.round(num(b.avg_seconds) / 6) / 10,
      spendUsd: b.spend === null ? null : Math.round(Number(b.spend) * 100) / 100,
    }),
  );
  return { deliveries, bots };
}

export function registerDeliveryRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...deliveriesRoute,
    schema: { response: DeliveriesResponse },
    readOnly: true,
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const { days } = DeliveriesQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const read = await readDeliveries(tx, team.id, days);
      return json(DeliveriesResponse.parse({ days, ...read }));
    }),
  });
}
