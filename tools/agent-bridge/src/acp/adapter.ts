import { HERMES_GROUPS, type AgentKind, type ProfileConfig } from '../config.ts';
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
  // `mt-publish` presents the run's own token to the publisher. The adapters otherwise start without it (the platform's tools get it in the session's MCP header), so only a bot whose profile
  // says it may publish gets it here: the token opens this run only (P26-19: a Committer on an agent pod found "no run token").
  const token = job.request.manythreads.mcp?.token ?? null;
  if (job.profile.publish === true && token !== null) env['MANYTHREADS_RUN_TOKEN'] = token;
  return env;
}

/** codex-acp's start mode with no sandbox and no command questions (the `codex --yolo` equivalent; the name is the adapter's and the version is pinned). */
export const CODEX_FULL_ACCESS_MODE = 'agent-full-access';

/**
 * Whether this run's Codex runs with full access: the profile allows it (`fullAccess`) and the run does not take it back (P26-06). `true` follows the run unless it says no; `"allowed"`
 * (an enrolled server) needs the run to say yes, so the machine's key and the site's key are both turned.
 */
export function fullAccessOn(job: Pick<DriverJob, 'profile' | 'request'>): boolean {
  if (job.profile.agent !== 'codex') return false;
  const asked = job.request.manythreads.fullAccess;
  if (job.profile.fullAccess === true) return asked !== false;
  if (job.profile.fullAccess === 'allowed') return asked === true;
  return false;
}

/** The mode each adapter must be put in, or null to leave it. Claude starts in `auto`, which decides permissions itself: it must be `default`. Codex follows the grants; a bot with no file or shell grant stays read-only even on a full-access runner. */
export function desiredMode(job: DriverJob): string | null {
  switch (flavorOf(job.profile.agent)) {
    case 'claude':
      return 'default';
    case 'codex': {
      const tools = job.request.manythreads.tools;
      if (!(tools.includes('files') || tools.includes('shell'))) return 'read-only';
      return fullAccessOn(job) ? CODEX_FULL_ACCESS_MODE : 'workspace-write';
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

export interface WantedOption {
  configId: string;
  value: string;
  /** Set by the profile (its model, or an alias mapped by it): the run fails when the adapter cannot take it. The bot's own effort is only asked for. */
  pinned: boolean;
}

/** The model and effort of the run as `session/set_config_option` values (the model is a config option in stable v1). */
export function wantedOptions(job: DriverJob): WantedOption[] {
  const mt = job.request.manythreads;
  const alias = mt.model.alias;
  const mapped = alias !== null && job.profile.modelAliases && Object.hasOwn(job.profile.modelAliases, alias) ? job.profile.modelAliases[alias] : undefined;
  const model = mapped ?? job.profile.model;
  const flavor = flavorOf(job.profile.agent);
  const out: WantedOption[] = [];
  // Hermes has no model option (its model is the home's setting): a model the profile pins cannot be set, and the run says so.
  if (model !== undefined) out.push({ configId: 'model', value: model, pinned: true });
  if (mt.model.effort !== null && EFFORTS.has(mt.model.effort)) {
    if (flavor === 'codex') out.push({ configId: 'reasoning_effort', value: mt.model.effort, pinned: false });
    else if (flavor === 'claude') out.push({ configId: 'effort', value: mt.model.effort, pinned: false });
  }
  return out;
}

const GROUP_WORDS: Record<string, string> = { files: 'read and change files', shell: 'run commands', web: 'use the web', browser: 'use a browser', vision: 'look at images' };

/**
 * Hermes takes its toolsets from its home (`platform_toolsets.acp`), not from the session, so the bridge cannot narrow them per run (checked in Hermes' source: a session
 * has no toolset parameter, and a copy of the home does not run). A run is therefore allowed only when the bot may use everything the profile's Hermes can do
 * (`acp.gives`, default all of Hermes' coding tools). Returns the plain-words refusal, or null.
 */
export function hermesGrantProblem(job: DriverJob): string | null {
  const gives = job.profile.acp?.gives ?? [...HERMES_GROUPS];
  const tools = job.request.manythreads.tools.map((t) => (t === 'web-search' ? 'web' : t));
  const missing = gives.filter((g) => !tools.includes(g));
  if (missing.length === 0) return null;
  return `This Hermes profile lets its agent ${missing.map((g) => GROUP_WORDS[g] ?? g).join(', ')}, which this bot is not allowed to do, and Hermes cannot be limited to less per run. Give the bot those tools, or narrow the Hermes profile (acp.gives).`;
}

/** OpenCode has not been measured: how it would be held to the bot's grants is not known, so no run starts on it. */
export const OPENCODE_REFUSAL = 'OpenCode cannot run yet: it has not been checked that its tools can be limited to what the bot may do.';

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
