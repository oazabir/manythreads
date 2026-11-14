import type { AgentKind, ProfileConfig } from '../config.ts';
import type { DriverJob } from '../drivers/types.ts';
import { claudeToolFlags, MCP_SERVER_NAME } from '../drivers/claude-code.ts';

// What differs between the adapters (docs/spikes/acp-measured.md): the program, how each is held to the bot's grants, the mode it must be put in, and the
// ids of the permission options it offers. The ids are the adapter's own: the bridge answers with the id of the option whose KIND it wants, never with the
// kind's word (the fake agent accepts a wrong id as "allow"; a real adapter does not).

export type Flavor = 'claude' | 'codex' | 'hermes' | 'opencode';

export const flavorOf = (agent: AgentKind): Flavor => (agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : agent === 'hermes-acp' ? 'hermes' : 'opencode');

/** The adapter's program and arguments: the profile's `acp` block, else the usual names (pinned versions are installed by the operator, never fetched here). */
export function adapterCommand(profile: ProfileConfig): { command: string; args: string[] } {
  const defaults: Record<AgentKind, { command: string; args: string[] }> = {
    'claude-code': { command: 'claude-agent-acp', args: [] },
    codex: { command: 'codex-acp', args: [] },
    'hermes-acp': { command: 'hermes', args: ['acp'] },
    opencode: { command: 'opencode', args: ['acp'] },
  };
  const d = defaults[profile.agent];
  return { command: profile.acp?.command ?? d.command, args: profile.acp?.args ?? d.args };
}

/** Run the bridge's own `claude`/`codex` under the adapter (one version, one sign-in store per tool) when `bin` names a path. */
export function adapterEnv(job: DriverJob, mode: string | null): NodeJS.ProcessEnv {
  const env = job.baseEnv();
  const { bin } = job.config;
  if (job.profile.agent === 'claude-code' && bin.claude.includes('/') && env['CLAUDE_CODE_EXECUTABLE'] === undefined) env['CLAUDE_CODE_EXECUTABLE'] = bin.claude;
  if (job.profile.agent === 'codex') {
    if (bin.codex.includes('/') && env['CODEX_PATH'] === undefined) env['CODEX_PATH'] = bin.codex;
    // The start mode is the grant (measured): the adapter's own start mode `agent` ("Auto review") adds a review step to every command.
    if (mode !== null) env['INITIAL_AGENT_MODE'] = mode;
  }
  return env;
}

/** The mode each adapter must be put in, or null to leave it. Claude starts in `auto`, which decides permissions itself: it must be `default`. Codex follows the grants. */
export function desiredMode(job: DriverJob): string | null {
  switch (flavorOf(job.profile.agent)) {
    case 'claude':
      return 'default';
    case 'codex': {
      const tools = job.request.manythreads.tools;
      return tools.includes('files') || tools.includes('shell') ? 'workspace-write' : 'read-only';
    }
    default:
      return null;
  }
}

/** Claude's helper and plan tools: a plan and helpers need `Agent`, `TaskCreate`, `TaskUpdate` and `TaskList` to exist (`TodoWrite` does not in an SDK session). */
const CLAUDE_EXTRA_TOOLS = ['Agent', 'TaskCreate', 'TaskUpdate', 'TaskList'] as const;

/**
 * The `_meta` sent with `session/new`, `resume` and `load`. Claude: the CLI driver's grants as the adapter's `options`; `settingSources: []` and `restricted` keep the
 * operator's own settings, memory and hooks out, and `strict-mcp-config` keeps the signed-in account's claude.ai connectors out (measured: without it Gmail, Drive and
 * others were in the session). The proof is the tools the agent lists, not this object.
 */
export function sessionMeta(job: DriverJob): Record<string, unknown> | undefined {
  if (flavorOf(job.profile.agent) !== 'claude') return undefined;
  const { tools, allowed } = claudeToolFlags(job.request.manythreads.tools, job.profile.extraAllowedTools);
  for (const t of CLAUDE_EXTRA_TOOLS) {
    if (!tools.includes(t)) tools.push(t);
    if (!allowed.includes(t)) allowed.push(t);
  }
  return {
    claudeCode: {
      options: {
        settingSources: [],
        tools,
        allowedTools: allowed,
        extraArgs: { restricted: null, 'strict-mcp-config': null },
        allowDangerouslySkipPermissions: false,
      },
    },
  };
}

/** The run's own MCP endpoint as ACP takes it: an HTTP server with the bearer header. The token travels in this message (on the adapter's stdin) and nowhere else. */
export function mcpServers(job: DriverJob): Array<Record<string, unknown>> {
  const mcp = job.request.manythreads.mcp;
  if (mcp === null) return [];
  return [{ type: 'http', name: MCP_SERVER_NAME, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }];
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The model and effort of the run as `session/set_config_option` values (the model is a config option in stable v1). */
export function wantedOptions(job: DriverJob): Array<{ configId: string; value: string }> {
  const mt = job.request.manythreads;
  const alias = mt.model.alias;
  const mapped = alias !== null && job.profile.modelAliases && Object.hasOwn(job.profile.modelAliases, alias) ? job.profile.modelAliases[alias] : undefined;
  const model = mapped ?? job.profile.model;
  const out: Array<{ configId: string; value: string }> = [];
  if (model !== undefined && flavorOf(job.profile.agent) !== 'hermes') out.push({ configId: 'model', value: model });
  if (mt.model.effort !== null && EFFORTS.has(mt.model.effort)) {
    const flavor = flavorOf(job.profile.agent);
    if (flavor === 'codex') out.push({ configId: 'reasoning_effort', value: mt.model.effort });
    else if (flavor === 'claude') out.push({ configId: 'effort', value: mt.model.effort });
  }
  return out;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

/** The option of a wanted kind. `once` is the one "Yes" (`allow_once`), `deny` the one "No" (`reject_once`); never a standing "always". */
export function optionFor(options: readonly PermissionOption[], want: 'once' | 'deny'): PermissionOption | null {
  return options.find((o) => o.kind === (want === 'once' ? 'allow_once' : 'reject_once')) ?? null;
}

/**
 * Codex asks before every call of an MCP tool, in every mode (measured), and `CODEX_CONFIG` does not stop it. The platform's own tools are what the bot's grants
 * already cover (the platform checks every call), so those are answered with "for this session". Matched to the step by id, never by the request's own words:
 * the request has no title and no server name.
 */
export function sessionOption(options: readonly PermissionOption[]): PermissionOption | null {
  return options.find((o) => o.optionId === 'allow_session') ?? options.find((o) => o.kind === 'allow_once') ?? null;
}
