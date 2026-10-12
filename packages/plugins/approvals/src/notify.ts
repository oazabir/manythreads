import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { ApprovalChangedPush, approvalChangedPushType } from '@manythreads/shared';

/**
 * A hint to the open tabs of the people who can see this approval that it was raised, settled or finished; the list is the truth, the push only
 * says when to refetch. The audience is the people of the team who can read the conversation it came from (`app.approvals_audience`): a push
 * about an approval raised in a private channel or a DM goes to that conversation's people, not to the team.
 */
export async function pushChanged(ctx: PluginContext, tx: PluginTx, approvalId: string): Promise<void> {
  // the audience is computed by a definer function: a bot filing a private-channel approval cannot read the row or the channel's members itself
  const row = (await tx.query<{ o_team_id: string; o_people: string[] }>('SELECT o_team_id, o_people FROM app.approvals_audience($1::uuid)', [approvalId])).rows[0];
  if (!row || row.o_people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, row.o_people, approvalChangedPushType, ApprovalChangedPush.parse({ teamId: row.o_team_id, approvalId }));
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
