import type { PluginContext } from '@manythreads/sdk';
import { GetAgentAuthResponse } from '@manythreads/shared';
import { setServerRunnerSignIn } from './servers.ts';
import type { TunnelRegistry } from './tunnel/registry.ts';

/**
 * Right after a server connects: ask its bridge (through the tunnel) whether Claude Code and Codex are signed in there, and let each runner say so. Hermes has no sign-in of its own
 * and is `ready` from the start. A bridge that does not answer leaves the runners as they are (they wait for a sign-in, which the Runners page shows). Never throws.
 */
export async function refreshServerSignIns(ctx: PluginContext, registry: TunnelRegistry, server: { id: string; workspaceId: string; name: string }): Promise<void> {
  try {
    const runners = await ctx.db.system((tx) => tx.query<{ id: string; agent: string }>("SELECT id, agent FROM app.bot_runners WHERE server_id = $1::uuid AND agent IN ('claude-code', 'codex')", [server.id]), {
      workspaceId: server.workspaceId,
    });
    const fetchTo = registry.fetchFor(server.id, server.name);
    for (const r of runners.rows) {
      const res = await fetchTo(`http://server.invalid/v1/auth/status?agent=${encodeURIComponent(r.agent)}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (res === null) continue;
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const parsed = GetAgentAuthResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success || parsed.data.auth.state === 'unknown') continue;
      await ctx.db.system((tx) => setServerRunnerSignIn(tx, r.id, parsed.data.auth.state !== 'signed_out'), { workspaceId: server.workspaceId });
    }
  } catch {
    // the page's own reads keep the state true
  }
}
