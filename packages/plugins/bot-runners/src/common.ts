import { forbidden, invalid, notFound, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { assertAllowedUrl, OutboundBlockedError } from '@manythreads/sdk/hermes-outbound';
import type { BotRunner } from '@manythreads/shared';
import { placementsOf, RUNNER_SELECT, teamsOf, toBotRunner, type RunnerRow } from './rows.ts';

// What the admin routes and the adoption routes share.

/** Only a workspace owner or admin goes on; everyone else is told no, in words that say nothing about what exists. */
export async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace admin can do that');
}

/** Refuse, when an address is saved, one the outbound guard would refuse at use (the guard still runs at every request). */
export async function requireAllowedAddress(baseUrl: string): Promise<void> {
  try {
    await assertAllowedUrl(new URL(baseUrl));
  } catch (err) {
    if (err instanceof OutboundBlockedError) throw invalid('That address cannot be used: it is not allowed from this server.');
    throw invalid('That address could not be resolved.');
  }
}

export async function loadRunner(tx: PluginTx, id: string): Promise<RunnerRow> {
  const row = (await tx.query<RunnerRow>(`SELECT ${RUNNER_SELECT} WHERE r.id = $1::uuid`, [id])).rows[0];
  if (!row) throw notFound('No such runner');
  return row;
}

/** Runners as an admin sees them: the team lists from the caller's own transaction, the placements counted as the system (bots of every team). */
export async function presentRunners(ctx: PluginContext, tx: PluginTx, rows: readonly RunnerRow[]): Promise<BotRunner[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const teams = await teamsOf(tx, ids);
  const workspaceId = tx.actor.workspaceId;
  const counts = await ctx.db.system((sys) => placementsOf(sys, workspaceId, ids), { workspaceId });
  return rows.map((r) => toBotRunner(r, teams.get(r.id) ?? [], counts.get(r.id)?.count ?? 0));
}

export async function presentOne(ctx: PluginContext, tx: PluginTx, id: string): Promise<BotRunner> {
  const [one] = await presentRunners(ctx, tx, [await loadRunner(tx, id)]);
  if (!one) throw notFound('No such runner');
  return one;
}
