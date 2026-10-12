import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { ApprovalChangedPush, approvalChangedPushType } from '@manythreads/shared';

/** The people of a team (bots are not people): who the Approvals badge and inbox live for. */
export async function teamPeople(tx: PluginTx, teamId: string): Promise<string[]> {
  const res = await tx.query<{ person_id: string }>(
    `SELECT DISTINCT a.ref_id AS person_id FROM app.team_members tm
       JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
      WHERE tm.team_id = $1`,
    [teamId],
  );
  return res.rows.map((r) => r.person_id);
}

/** A hint to the team's open tabs that an approval was raised or settled; the list is the truth, the push only says when to refetch. */
export async function pushChanged(ctx: PluginContext, tx: PluginTx, teamId: string, approvalId: string): Promise<void> {
  const people = await teamPeople(tx, teamId);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, approvalChangedPushType, ApprovalChangedPush.parse({ teamId, approvalId }));
}

/** The facts an event repeats about an approval; read through the app role's own column grants (never `resume`). */
export interface ApprovalFacts extends Record<string, unknown> {
  workspace_id: string;
  team_id: string;
  source: string;
  tool: string;
  bot_id: string | null;
  run_id: string | null;
  requester_id: string;
}

export async function factsOf(tx: PluginTx, approvalId: string): Promise<ApprovalFacts> {
  const row = (
    await tx.query<ApprovalFacts>(
      'SELECT workspace_id, team_id, source, tool, bot_id, run_id, requester_id FROM app.approvals WHERE id = $1',
      [approvalId],
    )
  ).rows[0];
  if (!row) throw new Error(`approval ${approvalId} is not visible to this transaction`);
  return row;
}
