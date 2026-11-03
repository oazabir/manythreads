import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ApprovalsApprovalDecidedEvent, MEMORY_DIGEST_SEND_TOOL, nextCronRun, type MemoryShareSettledEvent } from '@manythreads/shared';
import { buildRunSafely, failBuilding, pushApproval, receivingDestinations } from './build.ts';
import type { ShareRow } from './rows.ts';
import { BUILD_QUEUE, TICK_QUEUE, runPayload } from './util.ts';

// The jobs and the one subscription that move a run along: the build job (one per run), the tick that starts scheduled runs and lets an unanswered approval lapse,
// and the subscriber that turns a decision on the digest's Approvals row into the run's state.

/** The build of one run, once: asking twice while the first waits returns the first. */
export async function enqueueBuild(ctx: PluginContext, tx: PluginTx, run: { id: string; workspace_id: string }): Promise<void> {
  await ctx.jobs.enqueue(tx, BUILD_QUEUE, { workspaceId: run.workspace_id, runId: run.id }, { dedupeKey: `build:${run.id}` });
}

const SCHEDULED_PER_TICK = 50;

/** Starts every scheduled share whose time has come, and moves each share's next time on. A share already being built is skipped this minute. */
async function startDueRuns(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const now = ctx.runtime.now();
  const due = await tx.query<ShareRow>(
    `SELECT * FROM app.memory_shares WHERE status = 'active' AND cron IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at, id LIMIT ${SCHEDULED_PER_TICK} FOR UPDATE SKIP LOCKED`,
    [now],
  );
  let started = 0;
  for (const share of due.rows) {
    const next = share.cron === null ? null : nextCronRun(share.cron, now);
    await tx.query('UPDATE app.memory_shares SET next_run_at = $2 WHERE id = $1', [share.id, next]);
    // an archived sending team, or no accepted destination that is still open, has nothing to send: skip this time (the next time is already set)
    const sender = (await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM app.teams WHERE id = $1', [share.team_id])).rows[0];
    if (!sender || sender.archived_at !== null) continue;
    if ((await receivingDestinations(tx, share.id)).length === 0) continue;
    const run = (
      await tx.query<{ id: string; workspace_id: string }>(
        `INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode)
         VALUES ($1, $2, $3, 'schedule', 'building', $4)
         ON CONFLICT DO NOTHING
         RETURNING id, workspace_id`,
        [share.workspace_id, share.team_id, share.id, share.mode],
      )
    ).rows[0];
    if (!run) continue;
    await enqueueBuild(ctx, tx, run);
    started += 1;
  }
  return started;
}

/** A build that has not finished after this long is given up on, so one stuck run cannot keep its share from ever running again (one `building` run per share). */
const BUILD_GIVE_UP_MINUTES = 15;

async function failStuckBuilds(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const stuck = await tx.query<{ id: string }>(
    `SELECT id FROM app.memory_share_runs WHERE state = 'building' AND created_at < now() - make_interval(mins => $1) ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    [BUILD_GIVE_UP_MINUTES],
  );
  for (const row of stuck.rows) {
    await failBuilding(ctx, tx, row.id, 'The digest was not finished in time. Run the share again.');
  }
  return stuck.rows.length;
}

/** A digest nobody answered within the approval's seven days is `expired`, and says so. */
async function expireUnanswered(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const rows = await tx.query<{ id: string; share_id: string; team_id: string; workspace_id: string; approval_id: string; slug: string }>(
    `UPDATE app.memory_share_runs r
        SET state = 'expired', state_reason = 'Nobody decided in time, so the digest was not approved. Run the share again for a fresh one.', settled_at = now(), updated_at = now()
       FROM app.approvals a, app.memory_shares s
      WHERE r.approval_id = a.id AND r.state = 'awaiting_approval' AND s.id = r.share_id
        AND (a.status = 'expired' OR (a.status = 'pending' AND a.expires_at <= now()))
      RETURNING r.id, r.share_id, r.team_id, r.workspace_id, r.approval_id, s.slug`,
  );
  for (const row of rows.rows) {
    await emitSettled(ctx, tx, row, 'expired', null);
  }
  return rows.rows.length;
}

async function emitSettled(
  ctx: PluginContext,
  tx: PluginTx,
  row: { id: string; share_id: string; team_id: string; workspace_id: string; approval_id: string; slug: string },
  outcome: MemoryShareSettledEvent['outcome'],
  decidedBy: string | null,
): Promise<void> {
  const event: MemoryShareSettledEvent = {
    type: 'memory.share.settled',
    schemaVersion: 1,
    workspaceId: row.workspace_id as MemoryShareSettledEvent['workspaceId'],
    teamId: row.team_id as MemoryShareSettledEvent['teamId'],
    shareId: row.share_id as MemoryShareSettledEvent['shareId'],
    slug: row.slug as MemoryShareSettledEvent['slug'],
    runId: row.id as MemoryShareSettledEvent['runId'],
    outcome,
    approvalId: row.approval_id as MemoryShareSettledEvent['approvalId'],
    decidedBy: decidedBy as MemoryShareSettledEvent['decidedBy'],
    at: ctx.runtime.now().toISOString(),
  };
  await ctx.audit.emit(tx, event);
}

export function registerJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    BUILD_QUEUE,
    async (payload, tx, job) => {
      const p = runPayload(payload);
      if (p) await buildRunSafely(ctx, tx, p.runId, job.log);
    },
    { concurrency: 2, serialKey: 'runId' },
  );
  ctx.jobs.register(
    TICK_QUEUE,
    async (_payload, tx, job) => {
      const stuck = await failStuckBuilds(ctx, tx);
      const started = await startDueRuns(ctx, tx);
      const expired = await expireUnanswered(ctx, tx);
      if (started > 0 || expired > 0 || stuck > 0) job.log.info(`memory-share: ${started} scheduled run(s) started, ${expired} digest(s) expired, ${stuck} unfinished build(s) given up`);
    },
    { cron: '* * * * *' },
  );
}

/** A decision on a digest's Approvals row sets the run `ready` or `denied` (app.memory_share_settle) and tells the audit trail. */
export function registerSettle(ctx: PluginContext): void {
  ctx.events.subscribe('approvals.approval.decided', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ApprovalsApprovalDecidedEvent.parse(raw);
    if (event.tool !== MEMORY_DIGEST_SEND_TOOL || event.source !== 'grant') return;
    const moved = await tx.query<{ o_run_id: string; o_share_id: string; o_team_id: string; o_workspace_id: string; o_outcome: string; o_decider: string | null }>(
      'SELECT * FROM app.memory_share_settle($1::uuid, $2)',
      [event.approvalId, event.decision],
    );
    for (const row of moved.rows) {
      const share = (await tx.query<{ slug: string }>('SELECT slug FROM app.memory_shares WHERE id = $1', [row.o_share_id])).rows[0];
      if (!share) continue;
      await emitSettled(
        ctx,
        tx,
        { id: row.o_run_id, share_id: row.o_share_id, team_id: row.o_team_id, workspace_id: row.o_workspace_id, approval_id: event.approvalId, slug: share.slug },
        row.o_outcome === 'ready' ? 'ready' : 'denied',
        row.o_decider,
      );
      await pushApproval(ctx, tx, event.approvalId);
    }
  });
}
