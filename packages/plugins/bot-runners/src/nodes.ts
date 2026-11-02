import { conflict, invalid, json, route, type ClusterNode, type PluginContext, type PluginTx, type PodPlacement, type RunnerNodesProvider } from '@manythreads/sdk';
import {
  BotRunnerPathParams,
  ListRunnerNodesQuery,
  ListRunnerNodesResponse,
  SetRunnerNodeRequest,
  SetRunnerNodeResponse,
  listRunnerNodesRoute,
  setRunnerNodeRoute,
  type RunnerNode,
  type RunnerPlacement,
} from '@manythreads/shared';
import { loadRunner, presentOne, requireWorkspaceAdmin } from './common.ts';
import { podNodesByTeam } from './resolve.ts';

// Choosing the machine a pod runner stands on (PLAN P19-08, docs/plugins/bot-runners.md). Two admin routes:
//   GET /api/admin/bot-runners/nodes        the machines the operator allows, and (with ?runnerId) where that runner's pods stand
//   PUT /api/admin/bot-runners/:id/node     a machine's name, or null to let the cluster choose
// The machines come from the `runner.nodes` provider (hermes-pods reads the Kubernetes API; a test supplies a double). The operator's allowlist is the Helm value
// `botRunners.allowedNodes`, passed as MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES (a comma-separated list; empty or absent means every machine).

const READ_LIMIT = { limit: 120, windowMs: 60_000 };
const WRITE_LIMIT = { limit: 60, windowMs: 60_000 };

export const ALLOWED_NODES_ENV = 'MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES';

/** The machines the operator allows, or null for all of them. Read on each request so a changed value needs no restart of anything but the pod. */
export function allowedNodeNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | null {
  const names = (env[ALLOWED_NODES_ENV] ?? '')
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter((n) => n !== '');
  return names.length === 0 ? null : new Set(names);
}

const NO_CLUSTER = 'This install has no cluster to list machines from, so no machine can be chosen here.';
const NO_ANSWER = 'The cluster did not answer, so the machines could not be listed. Try again in a moment.';

type Listing = { ok: true; all: ClusterNode[]; allowed: ClusterNode[] } | { ok: false; note: string };

async function listing(ctx: PluginContext): Promise<{ provider: RunnerNodesProvider | null; nodes: Listing }> {
  const provider = ctx.providers.get<RunnerNodesProvider>('runner.nodes') ?? null;
  if (provider === null) return { provider, nodes: { ok: false, note: NO_CLUSTER } };
  try {
    const all = await provider.listNodes();
    const allow = allowedNodeNames();
    return { provider, nodes: { ok: true, all, allowed: allow === null ? all : all.filter((n) => allow.has(n.name)) } };
  } catch {
    // Nothing the cluster said is passed on: it can echo addresses.
    return { provider, nodes: { ok: false, note: NO_ANSWER } };
  }
}

/** The teams whose pods belong to a runner: null for every team (a runner open to all), else the listed ones. */
async function teamIdsOf(tx: PluginTx, runner: { id: string; all_teams: boolean }): Promise<string[] | null> {
  if (runner.all_teams) return null;
  return (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bot_runner_teams WHERE runner_id = $1::uuid', [runner.id])).rows.map((r) => r.team_id);
}

async function placementsOf(provider: RunnerNodesProvider | null, teamIds: string[] | null): Promise<PodPlacement[]> {
  if (provider === null) return [];
  try {
    return await provider.podPlacements({ teamIds });
  } catch {
    return [];
  }
}

/** Marks "any machine chosen" when asking which teams a runner would govern. */
const ANY_NODE = '*';

/**
 * The teams whose pod this runner decides the machine of: it is enabled, the team may use it, and no other pod runner outranks it (the default runner's machine wins,
 * then the first name), and it has a machine of its own: `node` is the one it has or is about to have (`ANY_NODE` to ask as if it had one).
 */
async function governedTeams(tx: PluginTx, runner: { id: string; workspace_id: string; all_teams: boolean }, node: string): Promise<string[]> {
  const scope = await teamIdsOf(tx, runner);
  if (scope !== null && scope.length === 0) return [];
  const byTeam = await podNodesByTeam(tx, runner.workspace_id, scope, { runnerId: runner.id, node });
  return [...byTeam].filter(([, pick]) => pick.runnerId === runner.id).map(([team]) => team);
}

/**
 * Where a pod runner's pods stand, from the chosen machine, the cluster's machines and the pods themselves. A move wins over a wait, a wait over a run. A pod
 * that waits on a chosen machine that is not Ready (or not in the cluster) says so; the pod's own words come from its Pending condition, never from a message.
 */
export function placementOf(chosen: string | null, cluster: readonly ClusterNode[] | null, pods: readonly PodPlacement[]): RunnerPlacement {
  const moving = pods.find((p) => p.moving);
  if (moving) return { state: 'moving', node: chosen, reason: null };
  // The machine for a pod changed without the admin's move: nothing is stopped or deleted until it is confirmed.
  if (pods.some((p) => p.moveHeld)) return { state: 'waiting', node: chosen, reason: 'move_not_confirmed' };
  const pending = pods.find((p) => p.phase === 'pending');
  if (pending) {
    const there = chosen === null ? undefined : cluster?.find((n) => n.name === chosen);
    const notReady = chosen !== null && cluster !== null && (there === undefined || !there.ready);
    return { state: 'waiting', node: chosen ?? pending.node, reason: notReady ? 'node_not_ready' : pending.pendingReason === 'unschedulable' ? 'not_placed' : 'starting' };
  }
  const running = pods.find((p) => p.phase === 'running');
  if (running) return { state: 'running', node: running.node ?? chosen, reason: null };
  return { state: 'idle', node: chosen, reason: null };
}

export function registerNodeRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listRunnerNodesRoute.method,
    path: listRunnerNodesRoute.path,
    rateLimit: READ_LIMIT,
    schema: { query: ListRunnerNodesQuery, response: ListRunnerNodesResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { runnerId } = ListRunnerNodesQuery.parse(req.query ?? {});
      const runner = runnerId === undefined ? null : await loadRunner(tx, runnerId);
      if (runner !== null && runner.kind !== 'hermes_pod') throw invalid('A machine can be chosen for a pod runner only.');
      const { provider, nodes } = await listing(ctx);
      if (!nodes.ok) return json(ListRunnerNodesResponse.parse({ available: false, nodes: [], singleNode: false, placement: null, note: nodes.note }));
      // only the pods of the teams this runner decides the machine of (another runner may outrank it for the others)
      const pods = runner === null ? [] : await placementsOf(provider, await governedTeams(tx, runner, ANY_NODE));
      const out: RunnerNode[] = nodes.allowed.map((n) => {
        const here = pods.filter((p) => p.volumeNode === n.name).length;
        return { ...n, hasWorkVolume: here > 0, workVolumes: here };
      });
      const placement = runner === null ? null : placementOf(runner.node, nodes.all, pods);
      return json(ListRunnerNodesResponse.parse({ available: true, nodes: out, singleNode: out.length === 1, placement, note: null }));
    }),
  });

  ctx.http.route({
    method: setRunnerNodeRoute.method,
    path: setRunnerNodeRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: SetRunnerNodeRequest, response: SetRunnerNodeResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      const body = SetRunnerNodeRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      // Locked: two admins changing the machine of one runner take turns, and the second sees what the first did.
      const current = await loadRunner(tx, id, true);
      if (current.kind !== 'hermes_pod') throw invalid('A machine can be chosen for a pod runner only.');
      const changed = body.node !== current.node;
      let recreates = false;
      let moveTeams: string[] = [];
      let provider: RunnerNodesProvider | null = null;
      if (body.node !== null) {
        const found = await listing(ctx);
        provider = found.provider;
        if (!found.nodes.ok) throw conflict(found.nodes.note);
        // The allowlist is judged on the cluster's own list, so a name the operator did not allow and a name that is no machine get the same answer.
        const chosen = found.nodes.allowed.find((n) => n.name === body.node);
        if (!chosen) throw invalid('That machine is not one this install may use. Pick one from the list.');
        if (!chosen.ready) throw conflict('That machine is not Ready, so a pod could not start on it. Pick a machine that is Ready.');
        // Only the teams whose pod this runner decides the machine of (it is enabled, they may use it, and no other pod runner outranks it) are moved by this change.
        const governed = await governedTeams(tx, current, body.node);
        if (governed.length > 0) {
          let pods: PodPlacement[];
          try {
            pods = await provider!.podPlacements({ teamIds: governed });
          } catch {
            throw conflict(NO_ANSWER);
          }
          // The work volume is recreated empty for a team whose pod keeps its volumes on a different machine.
          moveTeams = pods.filter((p) => p.volumeNode !== null && p.volumeNode !== body.node).map((p) => p.teamId);
          recreates = moveTeams.length > 0;
        }
      }
      // Nothing to change and no move waiting for the admin's word: nothing is written, nothing is said.
      if (!changed && !recreates) return json(SetRunnerNodeResponse.parse({ runner: await presentOne(ctx, tx, id), recreatesWorkVolume: false }));
      if (changed) await tx.query('UPDATE app.bot_runners SET node = $2, updated_at = now() WHERE id = $1::uuid', [id, body.node]);
      if (recreates && provider !== null && body.node !== null) {
        // The admin's confirmation, written where the controller reads it: the controller deletes volumes only for a move marked this way. A failure here fails the request
        // and rolls the change back, so a move is never half confirmed.
        try {
          await provider.confirmMove({ teamIds: moveTeams, node: body.node });
        } catch {
          throw conflict('The cluster did not take the move. Nothing was changed; try again in a moment.');
        }
      } else if (body.node === null) {
        // The machine is cleared: any waiting confirmation is taken off (best effort; it runs out by itself).
        const lister = ctx.providers.get<RunnerNodesProvider>('runner.nodes');
        await lister?.confirmMove({ teamIds: await teamIdsOf(tx, current), node: null }).catch(() => 0);
      }
      await ctx.audit.emit(tx, {
        type: 'bot_runner.node.changed',
        workspaceId: current.workspace_id,
        runnerId: id,
        name: current.name,
        wasPinned: current.node !== null,
        isPinned: body.node !== null,
        recreatesWorkVolume: recreates,
        actorId: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      });
      return json(SetRunnerNodeResponse.parse({ runner: await presentOne(ctx, tx, id), recreatesWorkVolume: recreates }));
    }),
  });
}
