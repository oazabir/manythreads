import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  DecideApprovalPathParams,
  DecideApprovalRequest,
  DecideApprovalResponse,
  GetApprovalArgsResponse,
  GetApprovalsSummaryResponse,
  ListApprovalsPathParams,
  ListApprovalsQuery,
  ListApprovalsResponse,
  ListThreadApprovalsPathParams,
  ListThreadApprovalsResponse,
  approveApprovalRoute,
  denyApprovalRoute,
  fullArgs,
  getApprovalArgsRoute,
  getApprovalsSummaryRoute,
  listApprovalsRoute,
  listThreadApprovalsRoute,
} from '@manythreads/shared';
import { conflict, forbidden, json, notFound, requireTeam, route } from './http.ts';
import { factsOf, pushChanged } from './notify.ts';
import { APPROVAL_SELECT, blockReasonsOf, toApproval, type ApprovalRow } from './rows.ts';
import { RESUME_QUEUE } from './resume.ts';

/** The approval of this team, as the caller sees it; 404 for one of another team (or one they cannot see), so an id reveals nothing. */
async function approvalOf(tx: PluginTx, teamId: string, approvalId: string) {
  const row = (await tx.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = $1::uuid AND a.team_id = $2::uuid`, [approvalId, teamId])).rows[0];
  if (!row) throw notFound('No such approval');
  return toApproval(row, (await blockReasonsOf(tx, [row.id])).get(row.id));
}

/** Rows to the shared shape, with the caller's may-I-decide answer for the whole list computed once. */
async function approvalsOf(tx: PluginTx, rows: readonly ApprovalRow[]) {
  const reasons = await blockReasonsOf(tx, rows.map((r) => r.id));
  return rows.map((r) => toApproval(r, reasons.get(r.id)));
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listApprovalsRoute,
    schema: { query: ListApprovalsQuery, response: ListApprovalsResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListApprovalsPathParams.parse(req.params);
      const q = ListApprovalsQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      // what waits is read oldest first (the one that has waited longest is on top); what was settled, newest first
      const rows = (
        await tx.query<ApprovalRow>(
          q.status === 'pending'
            ? `${APPROVAL_SELECT} WHERE a.team_id = $1::uuid AND a.status = 'pending' ORDER BY a.id ASC LIMIT $2`
            : `${APPROVAL_SELECT} WHERE a.team_id = $1::uuid AND a.status <> 'pending' ORDER BY a.decided_at DESC, a.id DESC LIMIT $2`,
          [team.id, q.limit],
        )
      ).rows;
      const waiting = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.approvals WHERE team_id = $1::uuid AND status = 'pending'", [team.id])).rows[0]?.n ?? 0;
      return json({ items: await approvalsOf(tx, rows), waiting });
    }),
  });

  ctx.http.route({
    ...getApprovalsSummaryRoute,
    schema: { response: GetApprovalsSummaryResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListApprovalsPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const row = (
        await tx.query<{ waiting: number; mine: number }>(
          `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE r.o_reason IS NULL)::int AS mine
             FROM app.approvals a
             JOIN app.approvals_block_reasons(ARRAY(SELECT p.id FROM app.approvals p WHERE p.team_id = $1::uuid AND p.status = 'pending')) r ON r.o_id = a.id`,
          [team.id],
        )
      ).rows[0];
      return json({ waiting: row?.waiting ?? 0, mine: row?.mine ?? 0 });
    }),
  });

  ctx.http.route({
    ...listThreadApprovalsRoute,
    schema: { response: ListThreadApprovalsResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ListThreadApprovalsPathParams.parse(req.params);
      // RLS limits this to the teams the caller reads; a thread of another team answers an empty list
      const rows = (await tx.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.thread_root_id = $1::uuid ORDER BY a.id ASC LIMIT 50`, [rootId])).rows;
      return json({ items: await approvalsOf(tx, rows) });
    }),
  });

  ctx.http.route({
    ...getApprovalArgsRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: GetApprovalArgsResponse },
    handler: route(async (req, tx) => {
      const { slug, approvalId } = DecideApprovalPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await approvalOf(tx, team.id, approvalId); // 404 for one of another team or one the caller cannot see
      // Only the people who may decide it (the database answers 42501 to everyone else, the requester included).
      const args = (await tx.query<{ args: Record<string, unknown> | null }>('SELECT app.approvals_full_args($1::uuid) AS args', [approvalId])).rows[0]?.args ?? null;
      return json({ args: args === null ? null : fullArgs(args) });
    }),
  });

  for (const [def, decision] of [[approveApprovalRoute, 'approved'], [denyApprovalRoute, 'denied']] as const) {
    ctx.http.route({
      ...def,
      rateLimit: { limit: 120, windowMs: 60_000 },
      schema: { body: DecideApprovalRequest, response: DecideApprovalResponse },
      handler: route(async (req, tx) => {
        const { slug, approvalId } = DecideApprovalPathParams.parse(req.params);
        const { note } = DecideApprovalRequest.parse(req.body ?? {});
        const team = await requireTeam(tx, slug);
        const before = await approvalOf(tx, team.id, approvalId);
        // The reasons come from the database's own check (the same function the decide door runs), so the answer and the rule cannot differ.
        if (before.blockReason === 'requester') throw forbidden('You asked for this, so someone else has to decide it');
        if (before.blockReason === 'not_approver') throw forbidden('You are not one of the people who can decide this');
        if (before.status !== 'pending') throw conflict('This approval was already decided');
        try {
          await tx.query('SELECT app.approvals_decide($1::uuid, $2, $3)', [approvalId, decision, note]);
        } catch (err) {
          if ((err as { code?: string }).code === '55000') throw conflict('This approval was already decided');
          throw err;
        }
        const facts = await factsOf(tx, approvalId);
        await ctx.audit.emit(
          tx,
          ApprovalsApprovalDecidedEvent.parse({
            type: 'approvals.approval.decided',
            schemaVersion: 1,
            workspaceId: facts.workspace_id,
            teamId: facts.team_id,
            approvalId,
            source: facts.source,
            tool: facts.tool,
            botId: facts.bot_id,
            requesterId: facts.requester_id,
            deciderId: tx.actor.id,
            decision,
          }),
        );
        // An approved tool call is re-run by the approvals plugin's own job; a handed-back one (the DLP hold) is taken back by the plugin that
        // asked, which listens to the event above. The job is queued in this transaction: committed with the decision, or not at all.
        if (decision === 'approved') {
          const kind = (await tx.query<{ resume_kind: string }>('SELECT resume_kind FROM app.approvals WHERE id = $1::uuid', [approvalId])).rows[0]?.resume_kind;
          if (kind === 'tool') await ctx.jobs.enqueue(tx, RESUME_QUEUE, { approvalId }, { dedupeKey: `approvals:${approvalId}` });
        }
        await pushChanged(ctx, tx, approvalId);
        return json({ approval: await approvalOf(tx, team.id, approvalId) });
      }),
    });
  }
}

