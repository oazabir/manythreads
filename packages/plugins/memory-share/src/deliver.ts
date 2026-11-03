import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { MemoryDigestDeliveredEvent, ShareDestination } from '@manythreads/shared';
import { DELIVER_QUEUE, SHARING_OFF_REASON, attempt, sharingEnabled } from './util.ts';

// Delivery (PLAN P8-24): an approved digest (a run in `ready`) is handed, one destination at a time, to the teams that accepted the share. The hand-over itself is the
// definer function app.deliver_inbox_item, which checks the link, the share and the workspace switch again and writes the inbox item; this job decides which destinations to ask,
// tells the audit trail, and moves the run to `sent` once every destination that can have it does. A destination that cannot have it now (paused, ended, the switch off) leaves
// the run `ready` or ends it `empty`; nothing is ever sent around a refusal.

/** A run that has waited this long without being delivered (every destination paused it, or sharing stayed off) is given up on. */
const READY_GIVE_UP_DAYS = 14;

/** Delivery of one run, once: asking twice while the first waits returns the first. */
export async function enqueueDeliver(ctx: PluginContext, tx: PluginTx, run: { id: string; workspace_id: string }): Promise<void> {
  await ctx.jobs.enqueue(tx, DELIVER_QUEUE, { workspaceId: run.workspace_id, runId: run.id }, { dedupeKey: `deliver:${run.id}` });
}

interface RunForDelivery extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  share_id: string;
  state: string;
  destinations: ShareDestination[];
  slug: string;
}

interface DeliveredRow extends Record<string, unknown> {
  o_delivery_id: string;
  o_item_id: string | null;
  o_duplicate: boolean;
  o_team_id: string;
  o_dest_team_id: string;
  o_share_id: string;
  o_workspace_id: string;
  o_digest_sha: string;
  o_period: string;
  o_files: number;
  o_bytes: number;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The state SQLSTATE a refusal of the definer function carries: `55000` is "not now" (a link that is not accepted, a switch that is off), anything else is a fault to try again. */
const isRefusal = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === '55000';

export interface DeliveryOutcome {
  delivered: number;
  refused: number;
  failed: number;
}

/**
 * Hands the digest of one `ready` run to every destination it was approved for that still has an accepted link. Idempotent: a destination that already has this digest
 * answers `duplicate` and nothing is written again, so a job that runs twice, or the tick that asks again, changes nothing.
 */
export async function deliverRun(ctx: PluginContext, tx: PluginTx, runId: string, log?: { warn(message: string): void }): Promise<DeliveryOutcome> {
  const none: DeliveryOutcome = { delivered: 0, refused: 0, failed: 0 };
  const run = (
    await tx.query<RunForDelivery>(
      `SELECT r.id, r.workspace_id, r.team_id, r.share_id, r.state, r.destinations, s.slug
         FROM app.memory_share_runs r JOIN app.memory_shares s ON s.id = r.share_id AND s.team_id = r.team_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [runId],
    )
  ).rows[0];
  if (!run || run.state !== 'ready') return none;
  if (!(await sharingEnabled(tx, run.workspace_id))) {
    await tx.query(`UPDATE app.memory_share_runs SET state_reason = $2, updated_at = now() WHERE id = $1`, [run.id, SHARING_OFF_REASON]);
    return none;
  }
  // only the teams the approver was shown (the destinations recorded when the digest was built) can have it: a team that accepted since was not named in that decision
  const approved = (Array.isArray(run.destinations) ? run.destinations : []).map((d) => d.teamId);
  const outcome: DeliveryOutcome = { delivered: 0, refused: 0, failed: 0 };
  for (const destTeamId of approved) {
    const done = await attempt(tx, async () => (await tx.query<DeliveredRow>('SELECT * FROM app.deliver_inbox_item($1::uuid, $2::uuid)', [run.id, destTeamId])).rows[0]);
    if (!done.ok) {
      if (isRefusal(done.error)) outcome.refused += 1;
      else {
        outcome.failed += 1;
        log?.warn(`memory-share: delivering run ${run.id} to a team failed: ${done.error instanceof Error ? cut(done.error.message, 200) : 'unknown'}`);
      }
      continue;
    }
    const row = done.value;
    if (!row) {
      outcome.failed += 1;
      continue;
    }
    outcome.delivered += 1;
    // a replay (this digest is already in that team's inbox) is counted as delivered but announced once only, when it was first written
    if (row.o_duplicate) continue;
    const event: MemoryDigestDeliveredEvent = {
      type: 'memory.digest.delivered',
      schemaVersion: 1,
      workspaceId: row.o_workspace_id as MemoryDigestDeliveredEvent['workspaceId'],
      teamId: row.o_team_id as MemoryDigestDeliveredEvent['teamId'],
      destTeamId: row.o_dest_team_id as MemoryDigestDeliveredEvent['destTeamId'],
      shareId: row.o_share_id as MemoryDigestDeliveredEvent['shareId'],
      slug: run.slug as MemoryDigestDeliveredEvent['slug'],
      runId: run.id as MemoryDigestDeliveredEvent['runId'],
      deliveryId: row.o_delivery_id as MemoryDigestDeliveredEvent['deliveryId'],
      itemId: row.o_item_id as MemoryDigestDeliveredEvent['itemId'],
      files: row.o_files,
      bytes: row.o_bytes,
      at: ctx.runtime.now().toISOString(),
    };
    await ctx.audit.emit(tx, event);
  }

  if (outcome.failed > 0) {
    await tx.query(`UPDATE app.memory_share_runs SET state_reason = $2, updated_at = now() WHERE id = $1`, [
      run.id,
      'Delivery to one or more teams did not go through yet. It is tried again every minute.',
    ]);
  } else if (outcome.delivered > 0) {
    await tx.query(`UPDATE app.memory_share_runs SET state = 'sent', state_reason = $2, sent_at = now(), updated_at = now() WHERE id = $1`, [
      run.id,
      `Delivered to ${outcome.delivered} ${outcome.delivered === 1 ? 'team' : 'teams'}.`,
    ]);
  } else {
    await tx.query(`UPDATE app.memory_share_runs SET state = 'empty', state_reason = $2, updated_at = now() WHERE id = $1`, [
      run.id,
      'No team that was asked can receive this digest now: each has paused or ended the share. Run the share again after a team accepts.',
    ]);
  }
  return outcome;
}

/** Asks for delivery of every approved digest that has not gone yet (a retry for a failed hand-over, and the catch-up after Memory sharing is switched back on), and gives up on one that waited too long. */
export async function deliverReady(ctx: PluginContext, tx: PluginTx): Promise<number> {
  await tx.query(
    `UPDATE app.memory_share_runs SET state = 'expired', state_reason = 'This digest was approved but could not be delivered within two weeks. Run the share again for a fresh one.', updated_at = now()
      WHERE state = 'ready' AND coalesce(settled_at, updated_at) < now() - make_interval(days => $1)`,
    [READY_GIVE_UP_DAYS],
  );
  const ready = await tx.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM app.memory_share_runs WHERE state = 'ready' ORDER BY id LIMIT 50`);
  for (const run of ready.rows) await enqueueDeliver(ctx, tx, run);
  return ready.rows.length;
}
