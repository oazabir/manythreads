import type { PluginTx } from '@manythreads/sdk';
import { BotServer, BotServerAgent, type BotServerAgentName, type BotServerStatus, type BridgeHello } from '@manythreads/shared';
import { z } from 'zod';

// The enrolled servers' rows and the runners made from them (PLAN P26-13, docs/plans/agents-anywhere.md §5.4). One mapper of `app.bot_servers`; nothing else converts rows.
// A key and a one-time code are only ever hashes here (`tunnel/keys.ts`): this file reads the hash columns to compare them and never returns them.

export interface ServerRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  name: string;
  label: string;
  status: BotServerStatus;
  enrol_code_hash: string | null;
  enrol_code_expires_at: Date | null;
  key_hash: string | null;
  pending_key_hash: string | null;
  host_name: string | null;
  host_system: string | null;
  host_arch: string | null;
  bridge_version: string | null;
  agents: unknown;
  allow_full_access: boolean;
  created_by: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Use as `SELECT ${SERVER_SELECT} WHERE ...`. */
export const SERVER_SELECT = `s.id, s.workspace_id, s.name, s.label, s.status, s.enrol_code_hash, s.enrol_code_expires_at, s.key_hash, s.pending_key_hash, s.host_name, s.host_system,
  s.host_arch, s.bridge_version, s.agents, s.allow_full_access, s.created_by, s.last_seen_at, s.created_at, s.updated_at
  FROM app.bot_servers s`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const Agents = z.array(BotServerAgent);

/** `connected` is what this process knows (the registry holds the socket); everything else is what the row says. */
export function toBotServer(r: ServerRow, connected: boolean, now: number = Date.now()): BotServer {
  const agents = Agents.safeParse(r.agents);
  const codeLive = r.enrol_code_hash !== null && r.enrol_code_expires_at !== null && r.enrol_code_expires_at.getTime() > now;
  return BotServer.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    label: r.label,
    status: connected ? 'connected' : r.key_hash === null ? 'waiting' : 'offline',
    host: r.host_name === null ? null : { hostname: r.host_name, system: r.host_system ?? '', arch: r.host_arch ?? '' },
    bridgeVersion: r.bridge_version,
    agents: agents.success ? agents.data : [],
    allowFullAccess: r.allow_full_access,
    enrolled: r.key_hash !== null,
    codeExpiresAt: codeLive ? iso(r.enrol_code_expires_at) : null,
    lastSeenAt: iso(r.last_seen_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}

/** What each agent a server can have is called in a runner's name, in its label, and in the bridge's profile. */
export const SERVER_AGENTS: Readonly<Record<BotServerAgentName, { suffix: 'claude' | 'codex' | 'hermes'; title: string }>> = {
  'claude-code': { suffix: 'claude', title: 'Claude Code' },
  codex: { suffix: 'codex', title: 'Codex' },
  'hermes-acp': { suffix: 'hermes', title: 'Hermes' },
};

/** `devbox-claude`: the runner of one agent on one server. The server's name leaves room for the longest suffix (BotServerName allows 31 characters). */
export const runnerNameOf = (serverName: string, agent: BotServerAgentName): string => `${serverName}-${SERVER_AGENTS[agent].suffix}`;
/** Every runner name a server of that name may ever own: a new server is refused when one of them is taken by something else. */
export const allRunnerNamesOf = (serverName: string): string[] => (Object.keys(SERVER_AGENTS) as BotServerAgentName[]).map((a) => runnerNameOf(serverName, a));

/** The fixed profile rule of a server runner: the bridge answers `<agent>--<team>--<bot>` from a template (§5.4). `{team}` is filled in by runtime-hermes. */
export const serverProfileRule = (agent: BotServerAgentName): string => `${SERVER_AGENTS[agent].suffix}--{team}--{bot}`;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const NOT_CONNECTED = 'The server is not connected.';
export const SIGN_IN_NEEDED = 'Sign this agent in on the server (the Sign-in button on its page).';
export const AGENT_GONE = 'The server no longer has this agent.';

/**
 * Makes or updates one runner per agent the server reported, and marks the ones it no longer reports. A runner's name never changes. A name that already belongs to
 * a runner of another kind is left alone (the create route refuses such a server name up front). Runs on a system transaction; returns the runners' ids by agent.
 */
export async function syncServerRunners(tx: PluginTx, server: Pick<ServerRow, 'id' | 'workspace_id' | 'name' | 'label'>, agents: readonly BotServerAgent[], connected: boolean): Promise<Map<BotServerAgentName, string>> {
  const out = new Map<BotServerAgentName, string>();
  for (const found of agents) {
    const meta = SERVER_AGENTS[found.agent];
    // an agent with a sign-in of its own waits for it until the bridge says it is signed in (`markRunnerSignedIn`); Hermes has none of its own
    const status = !connected ? 'not_set_up' : found.agent === 'hermes-acp' ? 'ready' : 'waiting_for_sign_in';
    const detail = !connected ? NOT_CONNECTED : status === 'waiting_for_sign_in' ? SIGN_IN_NEEDED : null;
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, agent, server_id, enabled, profile_rule, status, status_detail, last_checked_at)
         VALUES ($1::uuid, $2, $3, 'server_agent', $4, $5::uuid, true, $6, $7, $8, now())
         ON CONFLICT (workspace_id, name) DO UPDATE
            SET agent = EXCLUDED.agent, updated_at = now(),
                -- a runner an admin switched to a state of its own (paused) keeps it; every other state follows the connection
                status = CASE WHEN app.bot_runners.status IN ('ready', 'waiting_for_sign_in', 'not_set_up') OR NOT $9::boolean THEN EXCLUDED.status ELSE app.bot_runners.status END,
                status_detail = CASE WHEN app.bot_runners.status IN ('ready', 'waiting_for_sign_in', 'not_set_up') OR NOT $9::boolean THEN EXCLUDED.status_detail ELSE app.bot_runners.status_detail END,
                last_checked_at = now()
          WHERE app.bot_runners.server_id = EXCLUDED.server_id
          RETURNING id`,
        [server.workspace_id, runnerNameOf(server.name, found.agent), clip(`${server.label} · ${meta.title}`, 80), found.agent, server.id, serverProfileRule(found.agent), status, detail, connected],
      )
    ).rows[0];
    if (row) out.set(found.agent, row.id);
  }
  const keep = [...out.values()];
  await tx.query(
    `UPDATE app.bot_runners SET status = 'not_set_up', status_detail = $3, last_checked_at = now(), updated_at = now()
      WHERE server_id = $1::uuid AND workspace_id = $2::uuid AND NOT (id = ANY($4::uuid[])) AND (status, status_detail) IS DISTINCT FROM ('not_set_up', $3)`,
    [server.id, server.workspace_id, AGENT_GONE, keep],
  );
  return out;
}

/** The server's connection ended: its runners cannot serve a run until it is back. */
export async function markServerRunnersOffline(tx: PluginTx, serverId: string): Promise<void> {
  await tx.query(
    `UPDATE app.bot_runners SET status = 'not_set_up', status_detail = $2, last_checked_at = now(), updated_at = now()
      WHERE server_id = $1::uuid AND status IN ('ready', 'waiting_for_sign_in')`,
    [serverId, NOT_CONNECTED],
  );
}

/** The bridge said whether an agent is signed in on the server: the runner follows. Only runners in the states a connection decides are touched. */
export async function setServerRunnerSignIn(tx: PluginTx, runnerId: string, signedIn: boolean): Promise<void> {
  await tx.query(
    `UPDATE app.bot_runners
        SET status = $2, status_detail = $3, last_checked_at = now(), updated_at = now()
      WHERE id = $1::uuid AND kind = 'server_agent' AND status IN ('ready', 'waiting_for_sign_in') AND (status, status_detail) IS DISTINCT FROM ($2, $3)`,
    [runnerId, signedIn ? 'ready' : 'waiting_for_sign_in', signedIn ? null : SIGN_IN_NEEDED],
  );
}

/** What the bridge said about itself, as columns. */
export function helloColumns(hello: BridgeHello): { host_name: string; host_system: string; host_arch: string; bridge_version: string; agents: string; allow_full_access: boolean } {
  return {
    host_name: hello.host.hostname,
    host_system: hello.host.system,
    host_arch: hello.host.arch,
    bridge_version: hello.bridgeVersion,
    agents: JSON.stringify(hello.agents),
    allow_full_access: hello.allowFullAccess,
  };
}

/** The server of a runner, for a run or a sign-in call. Null when the runner is not one of a server. */
export async function serverOfRunner(tx: PluginTx, runnerId: string): Promise<ServerRow | null> {
  return (await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} JOIN app.bot_runners r ON r.server_id = s.id WHERE r.id = $1::uuid`, [runnerId])).rows[0] ?? null;
}
