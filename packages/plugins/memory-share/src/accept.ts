import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { MemoryShareLinkedEvent, ShareLinkEnd, ShareLinkState } from '@manythreads/shared';
import { pushApproval } from './build.ts';
import { attempt } from './util.ts';

// The receiving team's consent (PLAN P8-24). Naming a team in a share's file opens a link in state `requested`; nothing is delivered until that team's leads accept. Accepting is an
// Approvals row filed to the DESTINATION team (source `grant`, tool `memory.share.accept`): the people who decide are its leads and the workspace's owners and admins, never the
// person who wrote the share. Deciding it moves the link; the team can later pause, resume or end the link (app.memory_share_link_act). Every state change is a definer function
// (migration 0002), because the people who change a link cannot read or write the sending team's tables.

export async function emitLinked(
  ctx: PluginContext,
  tx: PluginTx,
  link: { id: string; workspace_id: string; team_id: string; dest_team_id: string; share_id: string },
  from: ShareLinkState,
  to: ShareLinkState,
  endedReason: ShareLinkEnd | null,
  changedBy: string | null,
): Promise<void> {
  const event: MemoryShareLinkedEvent = {
    type: 'memory.share.linked',
    schemaVersion: 1,
    workspaceId: link.workspace_id as MemoryShareLinkedEvent['workspaceId'],
    teamId: link.team_id as MemoryShareLinkedEvent['teamId'],
    destTeamId: link.dest_team_id as MemoryShareLinkedEvent['destTeamId'],
    shareId: link.share_id as MemoryShareLinkedEvent['shareId'],
    linkId: link.id as MemoryShareLinkedEvent['linkId'],
    from,
    to,
    endedReason,
    changedBy: changedBy as MemoryShareLinkedEvent['changedBy'],
    at: ctx.runtime.now().toISOString(),
  };
  await ctx.audit.emit(tx, event);
}

/**
 * Files the "accept this share" row for a link that is waiting (`requested`), as `requester` (the person who wrote the share's file). One open row per link: asking again while
 * one is open changes nothing. Best effort: a failure is logged and the tick asks again, so a share file is never refused because its acceptance could not be asked for.
 */
export async function askToAccept(ctx: PluginContext, tx: PluginTx, linkId: string, requester: string | null, log?: { warn(message: string): void }): Promise<string | null> {
  if (requester === null) return null;
  const done = await attempt(tx, async () => (await tx.query<{ id: string }>('SELECT app.memory_share_request_accept($1::uuid, $2::uuid) AS id', [linkId, requester])).rows[0]?.id ?? null);
  if (!done.ok) {
    log?.warn(`memory-share: could not ask a team to accept link ${linkId}: ${done.error instanceof Error ? done.error.message.slice(0, 200) : 'unknown'}`);
    return null;
  }
  if (done.value) await pushApproval(ctx, tx, done.value);
  return done.value;
}

/**
 * The links the tick asks about: waiting (`requested`), of an active share, to a team that is not archived, and with no open request. "No open request" is no row at all, or a
 * row that is no longer pending (it expired unanswered). A row that was approved or denied is not here: the decision's own subscriber moves the link.
 */
export const MISSING_ACCEPT_SQL = `SELECT l.id, s.defined_by
       FROM app.memory_share_links l JOIN app.memory_shares s ON s.id = l.share_id AND s.team_id = l.team_id
       JOIN app.teams t ON t.id = l.dest_team_id
      WHERE l.state = 'requested' AND s.status = 'active' AND s.defined_by IS NOT NULL AND t.archived_at IS NULL
        AND (l.approval_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM app.approvals a WHERE a.id = l.approval_id AND (a.status IN ('approved', 'denied') OR (a.status = 'pending' AND a.expires_at > now()))))
      ORDER BY l.id LIMIT 50 FOR UPDATE OF l SKIP LOCKED`;

/** The tick's catch-up: a waiting link whose request was never filed (the person on record was missing when the file was read, or the filing failed), or whose request expired. */
export async function askMissing(ctx: PluginContext, tx: PluginTx, log?: { warn(message: string): void }): Promise<number> {
  const rows = await tx.query<{ id: string; defined_by: string }>(MISSING_ACCEPT_SQL);
  let asked = 0;
  for (const row of rows.rows) {
    if (await askToAccept(ctx, tx, row.id, row.defined_by, log)) asked += 1;
  }
  return asked;
}

interface MovedLink extends Record<string, unknown> {
  o_link_id: string;
  o_share_id: string;
  o_team_id: string;
  o_dest_team_id: string;
  o_workspace_id: string;
  o_to: ShareLinkState;
  o_ended: ShareLinkEnd | null;
  o_decider: string | null;
}

/** A decision on an accept row moves its link (accepted, or ended by the team) and says so. */
export async function settleAccept(ctx: PluginContext, tx: PluginTx, approvalId: string, decision: 'approved' | 'denied'): Promise<void> {
  const moved = await tx.query<MovedLink>('SELECT * FROM app.memory_share_settle_accept($1::uuid, $2)', [approvalId, decision]);
  for (const row of moved.rows) {
    await emitLinked(
      ctx,
      tx,
      { id: row.o_link_id, workspace_id: row.o_workspace_id, team_id: row.o_team_id, dest_team_id: row.o_dest_team_id, share_id: row.o_share_id },
      'requested',
      row.o_to,
      row.o_ended,
      row.o_decider,
    );
  }
  await pushApproval(ctx, tx, approvalId);
}
