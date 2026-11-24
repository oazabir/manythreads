import type { PluginContext } from '@manythreads/sdk';
import { GetAgentAuthResponse } from '@manythreads/shared';
import { setServerRunnerSignIn } from './servers.ts';
import { followTeams, storeTeamSignIn, teamSignIns } from './team-signins.ts';
import type { TunnelRegistry } from './tunnel/registry.ts';

/** A team state seen within this long is not asked again at a connect. */
export const FRESH_MS = 10 * 60_000;
/** How many teams' sign-ins are asked at once at a connect. */
export const PROBES_AT_ONCE = 3;

/** Runs `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Right after a server connects: ask its bridge (through the tunnel) whether Claude Code and Codex are signed in there, and let each runner say so. Hermes has no sign-in of its own
 * and is `ready` from the start. A bridge that does not answer leaves the runners as they are (they wait for a sign-in, which the Runners page shows). Never throws.
 *
 * A runner where each team signs in (P35-10b): each team that may sign in, or that has a stored state, is asked for its own sign-in (`&team=`), one after another, and the answer is
 * stored as the Runners page's reads store it (a plain read never clears a refused sign-in or a running plan limit); the runner is ready while one of its teams is signed in. Only teams
 * whose state is unknown or older than ten minutes are asked, three at a time.
 */
export async function refreshServerSignIns(ctx: PluginContext, registry: TunnelRegistry, server: { id: string; workspaceId: string; name: string }): Promise<void> {
  try {
    const runners = await ctx.db.system(
      (tx) =>
        tx.query<{ id: string; agent: string; sign_in_scope: string }>("SELECT id, agent, sign_in_scope FROM app.bot_runners WHERE server_id = $1::uuid AND agent IN ('claude-code', 'codex')", [server.id]),
      { workspaceId: server.workspaceId },
    );
    const fetchTo = registry.fetchFor(server.id, server.name);
    const stateOf = async (agent: string, team?: string): Promise<'signed_in' | 'signed_out' | 'not_needed' | null> => {
      const res = await fetchTo(`http://server.invalid/v1/auth/status?agent=${encodeURIComponent(agent)}${team !== undefined ? `&team=${encodeURIComponent(team)}` : ''}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (res === null) return null;
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const parsed = GetAgentAuthResponse.safeParse(await res.json().catch(() => null));
      return !parsed.success || parsed.data.auth.state === 'unknown' ? null : parsed.data.auth.state;
    };
    for (const r of runners.rows) {
      if (r.sign_in_scope === 'per_team') {
        const teams = await ctx.db.system((tx) => teamSignIns(tx, r), { workspaceId: server.workspaceId });
        // only what is not known or is old (a reconnect after a short drop asks nothing), three at a time: each answer starts the team's adapter on the server
        const cutoff = ctx.runtime.now().getTime() - FRESH_MS;
        const due = teams.filter((t) => (t.served || t.state !== null) && (t.checkedAt === null || t.checkedAt.getTime() < cutoff));
        await eachLimited(due, PROBES_AT_ONCE, async (team) => {
          const state = await stateOf(r.agent, team.slug);
          if (state !== 'signed_in' && state !== 'signed_out') return;
          await ctx.db.system((tx) => storeTeamSignIn(tx, r.id, team.teamId, state), { workspaceId: server.workspaceId });
        });
        await ctx.db.system((tx) => followTeams(tx, r.id), { workspaceId: server.workspaceId });
        continue;
      }
      const state = await stateOf(r.agent);
      if (state === null) continue;
      await ctx.db.system((tx) => setServerRunnerSignIn(tx, r.id, state !== 'signed_out'), { workspaceId: server.workspaceId });
    }
  } catch {
    // the page's own reads keep the state true
  }
}
