import { HttpError, forbidden, json, notFound, route } from '@manythreads/sdk';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ActiveChannelRunsResponse,
  CHANNEL_RUN_HEADS_MAX,
  CHANNEL_RUN_RECENT_MINUTES,
  CHANNEL_WATCH_MAX_PER_PERSON,
  ChannelRunsPathParams,
  ChannelUnwatchResponse,
  ChannelWatchPathParams,
  ChannelWatchResponse,
  ListThreadRunsResponse,
  ListThreadsParams,
  RunActivityPathParams,
  RunActivityQuery,
  RunActivityItem,
  RunActivityResponse,
  RunHead,
  THREAD_WATCH_MAX_PER_PERSON,
  THREAD_WATCH_TTL_SECONDS,
  ThreadRunsPathParams,
  ThreadUnwatchResponse,
  ThreadWatchPathParams,
  ThreadWatchResponse,
  activeChannelRunsRoute,
  activeThreadRunsRoute,
  threadsRunningRoute,
  ThreadsRunningResponse,
  ThreadBatchQuery,
  THREAD_BATCH_MAX,
  idList,
  listThreadRunsRoute,
  runActivityRoute,
  unwatchChannelRoute,
  unwatchThreadRoute,
  watchChannelRoute,
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
    // who stopped it matters only while a stop is going on or done (a run that ended on its own has nobody to name)
    stoppedBy: row.state === 'stopping' || row.state === 'stopped' ? row.stopped_by_name : null,
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
          items: lines.slice(0, limit).flatMap((l) => {
            // one stored line that no longer parses (an old shape, a bad write) is left out; it must not turn the whole read into a 500
            const item = RunActivityItem.safeParse({ seq: l.seq, at: l.at.toISOString(), payload: l.payload });
            return item.success ? [item.data] : [];
          }),
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

  // GET /api/channels/:channelId/active-runs: the runs going in the threads of a channel (a page that was just opened missed their `run.started`). The table's policy decides
  // what the caller sees (a conversation run is its asker's alone). `runs` holds only runs that are going (a client turns every row into a "working" chip), the newest
  // CHANNEL_RUN_HEADS_MAX of them with their folded state; `recent` holds the heads of runs that ended lately, so a reload still shows the line they leave. A run that was lost
  // (no end, no sign of life) is closed by the sweep.
  ctx.http.route({
    ...activeChannelRunsRoute,
    readOnly: true,
    schema: { response: ActiveChannelRunsResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelRunsPathParams.parse(req.params);
      const rows = (
        await tx.query<ViewRow>(
          `SELECT ${VIEW_COLUMNS} FROM app.run_view
            WHERE channel_id = $1::uuid AND ended_at IS NULL AND thread_root_id IS NOT NULL AND NOT conversation
            ORDER BY started_at DESC, run_id DESC LIMIT 100`,
          [channelId],
        )
      ).rows;
      const recent = (
        await tx.query<ViewRow>(
          `SELECT ${VIEW_COLUMNS} FROM app.run_view
            WHERE channel_id = $1::uuid AND ended_at IS NOT NULL AND ended_at > now() - make_interval(mins => $2::int) AND thread_root_id IS NOT NULL AND NOT conversation
            ORDER BY ended_at DESC, run_id DESC LIMIT $3`,
          [channelId, CHANNEL_RUN_RECENT_MINUTES, CHANNEL_RUN_HEADS_MAX],
        )
      ).rows;
      const headed = rows.slice(0, CHANNEL_RUN_HEADS_MAX);
      const can = await stoppable(tx, headed.map((r) => r.run_id));
      const headIds = new Set(headed.map((r) => r.run_id));
      return json(
        ActiveChannelRunsResponse.parse({
          runs: rows.map((r) => ({
            runId: r.run_id,
            channelId: r.channel_id,
            threadRootId: r.thread_root_id,
            botId: r.bot_id,
            botActorId: r.bot_actor_id,
            botName: r.bot_name,
            startedAt: r.started_at.toISOString(),
            ...(headIds.has(r.run_id) ? { head: runHeadOf(r, can.has(r.run_id)) } : {}),
          })),
          recent: recent.map((r) => runHeadOf(r, false)),
        }),
      );
    }),
  });

  // GET /api/thread-batch/runs?roots=a,b (P29): the runs going in the threads the Threads view lists, in one read for the page (the rows' own policy decides what the caller sees; a
  // conversation with a bot is not a thread). The newest CHANNEL_RUN_HEADS_MAX carry their folded state.
  ctx.http.route({
    ...activeThreadRunsRoute,
    readOnly: true,
    schema: { query: ThreadBatchQuery, response: ActiveChannelRunsResponse },
    handler: route(async (req, tx) => {
      const roots = idList(ThreadBatchQuery.parse(req.query).roots, THREAD_BATCH_MAX);
      const rows = (
        await tx.query<ViewRow>(
          `SELECT ${VIEW_COLUMNS} FROM app.run_view
            WHERE thread_root_id = ANY ($1::uuid[]) AND ended_at IS NULL AND NOT conversation
            ORDER BY started_at DESC, run_id DESC LIMIT 100`,
          [roots],
        )
      ).rows;
      const headed = rows.slice(0, CHANNEL_RUN_HEADS_MAX);
      const can = await stoppable(tx, headed.map((r) => r.run_id));
      const headIds = new Set(headed.map((r) => r.run_id));
      return json(
        ActiveChannelRunsResponse.parse({
          runs: rows.map((r) => ({
            runId: r.run_id,
            channelId: r.channel_id,
            threadRootId: r.thread_root_id,
            botId: r.bot_id,
            botActorId: r.bot_actor_id,
            botName: r.bot_name,
            startedAt: r.started_at.toISOString(),
            ...(headIds.has(r.run_id) ? { head: runHeadOf(r, can.has(r.run_id)) } : {}),
          })),
        }),
      );
    }),
  });

  // GET /api/teams/:slug/threads/running (P29): in how many threads of the team a run is going, for the sidebar's "tasks in progress". The rows' policy limits it to channels the caller reads.
  ctx.http.route({
    ...threadsRunningRoute,
    readOnly: true,
    schema: { response: ThreadsRunningResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListThreadsParams.parse(req.params);
      const n = (
        await tx.query<{ n: number }>(
          `SELECT count(DISTINCT v.thread_root_id)::int AS n
             FROM app.run_view v JOIN app.channels c ON c.id = v.channel_id JOIN app.teams t ON t.id = c.team_id
            WHERE t.slug = $1 AND v.ended_at IS NULL AND v.thread_root_id IS NOT NULL AND NOT v.conversation`,
          [slug],
        )
      ).rows[0]?.n;
      return json(ThreadsRunningResponse.parse({ threads: n ?? 0 }));
    }),
  });

  // PUT /api/channels/:channelId/watch/:leaseId: "this page has this channel open" (P29: one lease for the whole channel, so the folded state of its runs reaches the page without a
  // lease per thread). Renewed every 20 s, held 60 s; a person only, in a channel they can read; not a conversation with a bot.
  ctx.http.route({
    ...watchChannelRoute,
    rateLimit: { limit: 240, windowMs: 60_000 },
    schema: { response: ChannelWatchResponse },
    handler: route(async (req, tx) => {
      const { channelId, leaseId } = ChannelWatchPathParams.parse(req.params);
      // a channel the caller cannot read is a 404, as everywhere (read through the channels policy)
      const channel = (await tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
      if (channel === undefined) throw notFound('No such channel');
      if (channel.kind === 'bot_conversation') throw notFound('No such channel');
      const person = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      if (person === null) throw forbidden('Only a person can watch a channel');
      // lapsed leases go first, so they never count against the cap; a new lease (not a renewal) above the cap is refused before the table's own trigger would
      await tx.query('DELETE FROM app.channel_watchers WHERE person_id = $1::uuid AND expires_at < now()', [person]);
      const mine = (
        await tx.query<{ held: boolean | null; n: string }>(
          'SELECT bool_or(channel_id = $1::uuid AND lease_id = $2::uuid) AS held, count(*)::text AS n FROM app.channel_watchers WHERE person_id = $3::uuid AND expires_at > now()',
          [channelId, leaseId, person],
        )
      ).rows[0];
      if (mine?.held !== true && Number(mine?.n ?? 0) >= CHANNEL_WATCH_MAX_PER_PERSON) {
        throw new HttpError(429, 'rate_limited', 'Too many channels are open at once. Close one and try again.', { 'retry-after': '20' });
      }
      const lease = await tx.query<{ expires_at: Date }>(
        `INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now() + make_interval(secs => $4))
         ON CONFLICT (channel_id, person_id, lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
         RETURNING expires_at`,
        [channelId, person, leaseId, THREAD_WATCH_TTL_SECONDS],
      );
      return json(ChannelWatchResponse.parse({ expiresAt: lease.rows[0]!.expires_at.toISOString() }));
    }),
  });

  // DELETE /api/channels/:channelId/watch/:leaseId: the page left the channel (only its own lease ends)
  ctx.http.route({
    ...unwatchChannelRoute,
    rateLimit: { limit: 240, windowMs: 60_000 },
    schema: { response: ChannelUnwatchResponse },
    handler: route(async (req, tx) => {
      const { channelId, leaseId } = ChannelWatchPathParams.parse(req.params);
      await tx.query('DELETE FROM app.channel_watchers WHERE channel_id = $1::uuid AND lease_id = $2::uuid AND person_id = app.person_id()', [channelId, leaseId]);
      return json(ChannelUnwatchResponse.parse({ ok: true }));
    }),
  });

  // PUT /api/threads/:rootId/watch/:leaseId: "this panel has this thread open" (a lease per open panel of each tab, renewed every 20 s, held 60 s)
  ctx.http.route({
    ...watchThreadRoute,
    rateLimit: { limit: 240, windowMs: 60_000 },
    schema: { response: ThreadWatchResponse },
    handler: route(async (req, tx) => {
      const { rootId, leaseId } = ThreadWatchPathParams.parse(req.params);
      // the root is read through the messages policy: a thread the caller cannot read is a 404, as everywhere
      const root = (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.messages WHERE id = $1::uuid AND thread_root_id IS NULL AND deleted_at IS NULL', [rootId])).rows[0];
      if (root === undefined) throw notFound('No such thread');
      const person = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      if (person === null) throw forbidden('Only a person can watch a thread');
      // a person's own lapsed leases go first, so they never count against the cap; then a new lease (not a renewal) is refused above the cap, before the table's own trigger would
      await tx.query('DELETE FROM app.thread_watchers WHERE person_id = $1::uuid AND expires_at < now()', [person]);
      const mine = (
        await tx.query<{ held: boolean; n: string }>(
          'SELECT bool_or(root_id = $1::uuid AND lease_id = $2::uuid) AS held, count(*)::text AS n FROM app.thread_watchers WHERE person_id = $3::uuid',
          [rootId, leaseId, person],
        )
      ).rows[0];
      if (mine?.held !== true && Number(mine?.n ?? 0) >= THREAD_WATCH_MAX_PER_PERSON) {
        throw new HttpError(429, 'rate_limited', 'Too many threads are open at once. Close one and try again.', { 'retry-after': '20' });
      }
      const lease = await tx.query<{ expires_at: Date }>(
        `INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + make_interval(secs => $5))
         ON CONFLICT (root_id, person_id, lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, channel_id = EXCLUDED.channel_id
         RETURNING expires_at`,
        [rootId, person, leaseId, root.channel_id, THREAD_WATCH_TTL_SECONDS],
      );
      return json(ThreadWatchResponse.parse({ expiresAt: lease.rows[0]!.expires_at.toISOString() }));
    }),
  });

  // DELETE /api/threads/:rootId/watch/:leaseId: this panel closed (only its own lease ends)
  ctx.http.route({
    ...unwatchThreadRoute,
    rateLimit: { limit: 240, windowMs: 60_000 },
    schema: { response: ThreadUnwatchResponse },
    handler: route(async (req, tx) => {
      const { rootId, leaseId } = ThreadWatchPathParams.parse(req.params);
      await tx.query('DELETE FROM app.thread_watchers WHERE root_id = $1::uuid AND lease_id = $2::uuid AND person_id = app.person_id()', [rootId, leaseId]);
      return json(ThreadUnwatchResponse.parse({ ok: true }));
    }),
  });
}
