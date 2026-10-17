import type { PluginTx } from '@manythreads/sdk';
import { RUN_MEMO_COLUMNS, toMemoryRunMemo, type RunMemoRow } from '../rows.ts';
import { isUuid, metadataOf, renderApproval, tagOf } from '../render.ts';
import { forget, iso, skip, type Provenance, type Resolution, type VerdictRow } from './common.ts';

// Approval ------------------------------------------------------------------------------------------------------------------

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  source: string;
  status: string;
  outcome: string;
  outcome_detail: string;
  tool: string;
  summary: string;
  requester_id: string;
  requester_name: string;
  run_id: string | null;
  /** The approval was filed from a run (`run_id` was set at insert); `run_id` is NULL afterwards when that run was deleted. */
  had_run: boolean;
  channel_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  bot_slug: string | null;
  bot_name: string | null;
  decider_name: string | null;
  channel_kind: string | null;
  channel_private: boolean | null;
  channel_team_id: string | null;
  channel_name: string | null;
  team_slug: string;
}

export async function resolveApproval(tx: PluginTx, approvalId: string): Promise<Resolution> {
  if (!isUuid(approvalId)) return forget('gone');
  const a = (
    await tx.query<ApprovalRow>(
      `SELECT a.id, a.workspace_id, a.team_id, a.source, a.status, a.outcome, a.outcome_detail, a.tool, a.summary, a.requester_id, a.requester_name,
              a.run_id, a.had_run, a.channel_id, a.created_at, a.decided_at,
              b.slug AS bot_slug, coalesce(nullif(b.name, ''), b.slug) AS bot_name, d.decider_name,
              c.kind AS channel_kind, c.private AS channel_private, c.team_id AS channel_team_id, c.name AS channel_name, t.slug AS team_slug
         FROM app.approvals a
         JOIN app.teams t ON t.id = a.team_id
         LEFT JOIN app.bots b ON b.id = a.bot_id
         LEFT JOIN app.approval_decisions d ON d.approval_id = a.id
         LEFT JOIN app.channels c ON c.id = a.channel_id
        WHERE a.id = $1::uuid`,
      [approvalId],
    )
  ).rows[0];
  if (!a) return forget('gone');
  // An approval raised in a private channel, a DM or a bot conversation is made of that conversation (summary, preview, excerpt): never fed.
  if (a.channel_id !== null && !(a.channel_kind === 'channel' && a.channel_private === false && a.channel_team_id === a.team_id)) return forget('not_team_visible');
  if (a.status === 'pending') return skip('pending');

  const at: Provenance = {
    teamId: a.team_id,
    workspaceId: a.workspace_id,
    channelId: a.channel_id,
    runId: a.run_id,
    actorId: a.requester_id,
    scopes: [],
    link: `/t/${a.team_slug}/approvals`,
  };
  if (a.run_id !== null) {
    const run = (await tx.query<{ status: string; ended_at: Date | null }>('SELECT status, ended_at FROM app.bot_runs WHERE id = $1::uuid', [a.run_id])).rows[0];
    if (run && run.status === 'running') return { action: 'defer', at, reason: 'run_open' };
    const verdict = (await tx.query<VerdictRow>('SELECT retain_refusal, narrowest_scope, source_lines, source_scopes FROM app.run_retain_verdict($1::uuid)', [a.run_id])).rows[0];
    if (verdict) {
      at.scopes = verdict.source_scopes;
      if (verdict.retain_refusal !== null) return { action: 'withhold', at, reason: verdict.retain_refusal };
    }
  } else if (a.had_run) {
    // The run it was filed from is gone: retention pruned it (and left a memo that remembers this approval), or it was deleted some other way.
    // `approvals.run_id` is SET NULL by the foreign key, so "no run" is not "a run that read nothing narrower": the memo decides, and a run that
    // left no memo cannot be judged, which is a refusal (fail closed, like `inheritSources`).
    const memoRow = (await tx.query<RunMemoRow>(`SELECT ${RUN_MEMO_COLUMNS} FROM app.memory_run_memo WHERE approval_ids @> ARRAY[$1::uuid] LIMIT 1`, [approvalId])).rows[0];
    const memo = memoRow === undefined ? undefined : toMemoryRunMemo(memoRow);
    if (memo === undefined) return { action: 'withhold', at, reason: 'run_gone' };
    if (memo.retainRefusal !== null) return { action: 'withhold', at, reason: memo.retainRefusal };
  }
  const when = a.decided_at ?? a.created_at;
  const text = renderApproval({
    tool: a.tool,
    source: a.source,
    summary: a.summary,
    status: a.status,
    outcome: a.outcome,
    outcomeDetail: a.outcome_detail,
    requesterName: a.requester_name === '' ? 'someone' : a.requester_name,
    botName: a.bot_name,
    deciderName: a.decider_name,
    decidedAt: a.decided_at === null ? null : iso(a.decided_at),
    channelName: a.channel_kind === 'channel' ? a.channel_name : null,
  });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(when),
      tags: ['feed', 'kind:approval', tagOf('tool', a.tool), tagOf('status', a.status)],
      metadata: metadataOf({ feed_kind: 'approval', feed_id: a.id, actor: a.requester_id, actor_name: a.requester_name, occurred_at: iso(when), link: at.link, tool: a.tool, status: a.status }),
    },
  };
}
