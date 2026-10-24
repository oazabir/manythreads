import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MANAGED_CONNECTION_NAME } from '@manythreads/shared';

// When a team's managed profile set may have changed — a bot was loaded or removed, or its LLM key changed — say so once: the in-process listeners
// of the `hermes.profiles` provider are called and a `hermes.profiles.changed` event is written, for a controller in another process. Teams
// without a managed gateway are skipped (no pod, nobody listening). The event says only WHICH team; the controller then asks for the profiles.

async function teamHasManagedGateway(tx: PluginTx, teamId: string): Promise<boolean> {
  const res = await tx.query('SELECT 1 FROM app.hermes_connections WHERE team_id = $1::uuid AND name = $2', [teamId, MANAGED_CONNECTION_NAME]);
  return res.rows.length > 0;
}

export function registerProfileChanges(ctx: PluginContext, notify: (teamId: string) => void): void {
  const announce = async (tx: PluginTx, workspaceId: string, teamId: string): Promise<void> => {
    if (!(await teamHasManagedGateway(tx, teamId))) return;
    await ctx.audit.emit(tx, { type: 'hermes.profiles.changed', workspaceId, teamId, at: ctx.runtime.now().toISOString() });
    notify(teamId);
  };
  for (const type of ['bots.bot.loaded', 'bots.bot.removed']) {
    ctx.events.subscribe(type, async (event: PluginEvent, tx: PluginTx) => {
      const { workspaceId, teamId } = event as PluginEvent & { workspaceId: string; teamId?: string };
      if (typeof teamId === 'string') await announce(tx, workspaceId, teamId);
    });
  }
  ctx.events.subscribe('llm.key.changed', async (event: PluginEvent, tx: PluginTx) => {
    const { workspaceId, botId } = event as PluginEvent & { workspaceId: string; botId?: string };
    if (typeof botId !== 'string') return;
    const team = await tx.query<{ team_id: string }>('SELECT team_id FROM app.bots WHERE id = $1::uuid', [botId]);
    const teamId = team.rows[0]?.team_id;
    if (teamId) await announce(tx, workspaceId, teamId);
  });
}
