import { forbidden, json, notFound, route } from '@manythreads/sdk';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ListThreadRunsResponse,
  RunActivityPathParams,
  RunActivityQuery,
  RunActivityResponse,
  RunHead,
  THREAD_WATCH_TTL_SECONDS,
  ThreadRunsPathParams,
  ThreadUnwatchResponse,
  ThreadWatchPathParams,
  ThreadWatchResponse,
  listThreadRunsRoute,
  runActivityRoute,
  unwatchThreadRoute,
  watchThreadRoute,
  type RunCounts,
  type RunHelper,
  type RunNow,
  type RunPlanEntry,
  type RunViewState,
} from '@manythreads/shared';
import { summarizePlan } from './run-activity.ts';

// What a run did, read back (P25-06), and the lease of an open thread (P25-07). The rows are the run job's (run-recorder.ts); a request reads them as the caller, so the
// rule is the table's: whoever can read the run's channel (a conversation run: its asker alone). Nothing here writes a run.

type ViewRow = {
  run_id: string;
  channel_id: string;
  thread_root_id: string | null;
  bot_id: string;
  bot_actor_id: string | null;
  bot_name: string;
  asker_id: string | null;
  conversation: boolean;
  state: RunViewState;
  now_step: RunNow | null;
  counts: Partial<RunCounts>;
  helpers: RunHelper[];
  plan: RunPlanEntry[];
  plan_version: number;
  last_seq: number;
  stop_reason: string | null;
  cost: { amount: number; currency: string } | null;
  started_at: Date;
  ended_at: Date | null;
  stopped_by_name: string | null;
};

const VIEW_COLUMNS = `run_id, channel_id, thread_root_id, bot_id, bot_actor_id, bot_name, asker_id, conversation, state, now_step, counts, helpers, plan, plan_version, last_seq,
  stop_reason, cost, started_at, ended_at, stopped_by_name`;

const ZERO_COUNTS: RunCounts = { steps: 0, failed: 0, commands: 0, filesChanged: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 };
const ENDED: readonly RunViewState[] = ['done', 'failed', 'stopped'];

export function runHeadOf(row: ViewRow, canStop: boolean): RunHead {
  return RunHead.parse({
    state: row.state,
    now: row.now_step,
    counts: { ...ZERO_COUNTS, ...row.counts },
    plan: summarizePlan(row.plan),
    planVersion: row.plan_version,
    helpers: row.helpers.slice(-5),
    seq: row.last_seq,
    stoppedBy: row.stopped_by_name,
    runId: row.run_id,
    botId: row.bot_id,
    botActorId: row.bot_actor_id,
    botName: row.bot_name,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    askerActorId: row.asker_id,
    conversation: row.conversation,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
    stopReason: row.stop_reason,
    cost: row.cost,
    canStop: canStop && !ENDED.includes(row.state),
  });
}

/** Which of these runs the caller may stop, in one statement (`app.run_may_stop` reads the caller from the transaction). */
async function stoppable(tx: PluginTx, runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const r = await tx.query<{ run_id: string; ok: boolean }>('SELECT id AS run_id, app.run_may_stop(id) AS ok FROM unnest($1::uuid[]) AS id', [runIds]);
  return new Set(r.rows.filter((x) => x.ok).map((x) => x.run_id));
}

export function registerActivityRoutes(ctx: PluginContext): void {
  // GET /api/runs/:runId/activity?after=&limit=
  ctx.http.route({
    ...runActivityRoute,
    schema: { query: RunActivityQuery, response: RunActivityResponse },
    handler: route(async (req, tx) => {
      const { runId } = RunActivityPathParams.parse(req.params);
      const { after, limit } = RunActivityQuery.parse(req.query ?? {});
      // a run the caller cannot read, one that has no record and one that does not exist are one 404
      const view = (await tx.query<ViewRow>(`SELECT ${VIEW_COLUMNS} FROM app.run_view WHERE run_id = $1::uuid`, [runId])).rows[0];
      if (view === undefined) throw notFound('No such run');
      const lines = (
        await tx.query<{ seq: number; at: Date; payload: unknown }>('SELECT seq, at, payload FROM app.run_activity WHERE run_id = $1::uuid AND seq > $2 ORDER BY seq LIMIT $3', [runId, after, limit + 1])
      ).rows;
      const can = await stoppable(tx, [runId]);
      return json(
        RunActivityResponse.parse({
          run: runHeadOf(view, can.has(runId)),
          plan: view.plan,
          items: lines.slice(0, limit).map((l) => ({ seq: l.seq, at: l.at.toISOString(), payload: l.payload })),
          hasMore: lines.length > limit,
        }),
      );
    }),
  });

  // GET /api/threads/:rootId/runs
  ctx.http.route({
    ...listThreadRunsRoute,
    schema: { response: ListThreadRunsResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadRunsPathParams.parse(req.params);
      const rows = (
        await tx.query<ViewRow>(`SELECT ${VIEW_COLUMNS} FROM app.run_view WHERE thread_root_id = $1::uuid ORDER BY started_at DESC, run_id DESC LIMIT 100`, [rootId])
      ).rows.reverse();
      const can = await stoppable(tx, rows.map((r) => r.run_id));
      return json(ListThreadRunsResponse.parse({ runs: rows.map((r) => runHeadOf(r, can.has(r.run_id))) }));
    }),
  });

  // PUT /api/threads/:rootId/watch: "I have this thread open" (renewed every 30 s, held 60 s)
  ctx.http.route({
    ...watchThreadRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ThreadWatchResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadWatchPathParams.parse(req.params);
      // the root is read through the messages policy: a thread the caller cannot read is a 404, as everywhere
      const root = (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.messages WHERE id = $1::uuid AND thread_root_id IS NULL AND deleted_at IS NULL', [rootId])).rows[0];
      if (root === undefined) throw notFound('No such thread');
      const person = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      if (person === null) throw forbidden('Only a person can watch a thread');
      const lease = await tx.query<{ expires_at: Date }>(
        `INSERT INTO app.thread_watchers (root_id, person_id, channel_id, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now() + make_interval(secs => $4))
         ON CONFLICT (root_id, person_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, channel_id = EXCLUDED.channel_id
         RETURNING expires_at`,
        [rootId, person, root.channel_id, THREAD_WATCH_TTL_SECONDS],
      );
      return json(ThreadWatchResponse.parse({ expiresAt: lease.rows[0]!.expires_at.toISOString() }));
    }),
  });

  // DELETE /api/threads/:rootId/watch: the panel closed
  ctx.http.route({
    ...unwatchThreadRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ThreadUnwatchResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadWatchPathParams.parse(req.params);
      await tx.query('DELETE FROM app.thread_watchers WHERE root_id = $1::uuid AND person_id = app.person_id()', [rootId]);
      return json(ThreadUnwatchResponse.parse({ ok: true }));
    }),
  });
}
