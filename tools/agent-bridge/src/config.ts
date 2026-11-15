import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// The bridge's config file: which agent CLI serves which profile.
//
//   {
//     "profiles": {
//       "default": { "agent": "claude-code", "workdir": "/home/me/work" },
//       "reviewer": { "agent": "codex", "workdir": "/home/me/review", "model": "gpt-5" }
//     },
//     "maxConcurrentRuns": 4
//   }
//
// A profile is the name a manythreads bot puts in its URL (`/p/<profile>/v1`). A profile that is not listed uses `default`.

export type AgentKind = 'claude-code' | 'codex' | 'hermes-acp' | 'opencode';
const AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'hermes-acp', 'opencode'];

/** How a profile's agent is driven: `cli` (the tool's own stream-json / exec mode) or `acp` (the Agent Client Protocol over an adapter process, P25-03). */
export type DriverKind = 'cli' | 'acp';

/** The adapter process of an `acp` profile. Versions are pinned by what the operator installs; the bridge never runs `npx`. */
export interface AcpConfig {
  /** The adapter's program. Default by agent: `claude-agent-acp`, `codex-acp`, `hermes`, `opencode`. */
  command?: string | undefined;
  /** Its arguments. Default by agent: none, none, `acp`, `acp`. */
  args?: string[] | undefined;
  /**
   * Hermes only: what the operator's Hermes home lets its agent do (its `platform_toolsets.acp`), as the bot grant groups `files`, `shell`, `web`, `browser`, `vision`.
   * Hermes cannot be held to a bot's grants by the bridge (its toolsets come from its home, not from the session), so a run is refused when the bot's grants are narrower
   * than this. Default: all five (Hermes' own default coding toolset).
   */
  gives?: string[] | undefined;
}

export const HERMES_GROUPS = ['files', 'shell', 'web', 'browser', 'vision'] as const;

export interface ProfileConfig {
  agent: AgentKind;
  /** `cli` (default) starts the tool's own CLI; `acp` starts its ACP adapter. `hermes-acp` and `opencode` only exist as `acp`. */
  driver: DriverKind;
  acp?: AcpConfig | undefined;
  /** The folder the agent works in. Created when missing. */
  workdir: string;
  /** The model passed to the CLI when the bot does not pick one the bridge knows. */
  model?: string | undefined;
  /** Names a bot may ask for (`model.alias` in the run) mapped to the CLI's own model names. An alias that is not listed is ignored. */
  modelAliases?: Record<string, string> | undefined;
  /** Claude Code only: more tools to pre-approve for every run of this profile, e.g. `Bash(git status)`. They are also made available. */
  extraAllowedTools?: string[] | undefined;
  /** Variables set in the child's environment for this profile, e.g. `{ "KUBECONFIG": "/home/bridge/.kube/deployer" }`. */
  env?: Record<string, string> | undefined;
  /**
   * A folder that holds this profile's own sign-in (Claude Code: becomes `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME`), so signing in or out from the Runners page changes this profile and
   * nobody else on the machine. Without it (or the same variable in `env`) the profile uses the machine's shared sign-in: the one in the service user's home folder. An absolute path.
   */
  authHome?: string | undefined;
  /**
   * Codex only: may this profile's Codex run commands without asking (codex-acp's full-access mode, the `codex --yolo` behaviour)? Two keys, one on each side
   * (docs/plans/agents-anywhere.md §4): this profile's, written by whoever installs the bridge (the pod's controller, the server's installer flag; the site cannot widen a
   * machine's sandbox), and the run's own `manythreads.fullAccess`, the admin's switch on the site.
   *   false / absent  never.
   *   "allowed"       only when the run says `fullAccess: true` (an enrolled server: both keys needed).
   *   true            on, unless the run says `fullAccess: false` (an agent pod: the controller already wrote the admin's switch here, and the run can only narrow it).
   */
  fullAccess?: boolean | 'allowed' | undefined;
  /** Names of the bridge's own environment variables handed on to the child (beyond the built-in allowlist). */
  passEnv?: string[] | undefined;
  /**
   * What this machine is like, appended after the bot's BOT.md in every run: where the repositories are, what is installed, what the bot must
   * not touch. The bot's definition says who it is; this says where it runs (as a Hermes profile's own SOUL.md would).
   */
  instructions?: string | undefined;
}

export interface BridgeConfig {
  profiles: Record<string, ProfileConfig>;
  /** Runs at once, over all profiles. A start beyond it is answered with 429. */
  maxConcurrentRuns: number;
  /** Seconds between asking a process group to stop (SIGTERM) and killing it (SIGKILL). */
  killGraceSeconds: number;
  /** Seconds added to a run's budget before the bridge kills it. */
  budgetGraceSeconds: number;
  /** How long a finished run stays answerable. */
  keepFinishedSeconds: number;
  /** Used when a run states no budget. */
  defaultBudgetSeconds: number;
  /** Where the CLIs are found. Default: `claude` and `codex` on PATH. An ACP adapter for Claude or Codex is pointed at these (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`) when they are paths. */
  bin: { claude: string; codex: string };
  /** Seconds an ACP run is given to end after `session/cancel` before its process group is stopped. */
  cancelGraceSeconds: number;
  /** Seconds an ACP run waits for a person to answer a permission request before it is refused ("silence is not consent"). */
  approvalWaitSeconds: number;
  /** Claude Code: write the run token into the 0600 mcp file instead of expanding `${MANYTHREADS_RUN_TOKEN}` from the child's environment. */
  mcpTokenInFile: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['AGENT_BRIDGE_API_KEY', 'MANYTHREADS_RUN_TOKEN']);

const positive = (v: unknown, fallback: number, what: string): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`config: ${what} must be a positive number`);
  return v;
};

export function parseConfig(raw: unknown): BridgeConfig {
  if (!isRecord(raw)) throw new Error('config: the file must hold a JSON object');
  const profilesRaw = raw['profiles'];
  if (!isRecord(profilesRaw) || Object.keys(profilesRaw).length === 0) throw new Error('config: "profiles" must list at least one profile');
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, p] of Object.entries(profilesRaw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`config: profile name "${name}" is not valid (letters, digits, . _ -)`);
    if (!isRecord(p)) throw new Error(`config: profile "${name}" must be an object`);
    const agent = AGENT_KINDS.find((k) => k === p['agent']);
    if (agent === undefined) throw new Error(`config: profile "${name}": agent must be one of ${AGENT_KINDS.map((k) => `"${k}"`).join(', ')}`);
    const onlyAcp = agent === 'hermes-acp' || agent === 'opencode';
    const driverRaw = p['driver'];
    if (driverRaw !== undefined && driverRaw !== 'cli' && driverRaw !== 'acp') throw new Error(`config: profile "${name}": driver must be "cli" or "acp"`);
    const driver: DriverKind = driverRaw ?? (onlyAcp ? 'acp' : 'cli');
    if (onlyAcp && driver !== 'acp') throw new Error(`config: profile "${name}": agent "${agent}" is only driven through ACP`);
    const acpRaw = p['acp'];
    let acp: AcpConfig | undefined;
    if (acpRaw !== undefined) {
      if (!isRecord(acpRaw)) throw new Error(`config: profile "${name}": acp must be an object`);
      const cmd = acpRaw['command'];
      const argv = acpRaw['args'];
      if (cmd !== undefined && (typeof cmd !== 'string' || cmd === '')) throw new Error(`config: profile "${name}": acp.command must be a program name or path`);
      if (argv !== undefined && (!Array.isArray(argv) || argv.some((x) => typeof x !== 'string'))) throw new Error(`config: profile "${name}": acp.args must be a list of strings`);
      const gives = acpRaw['gives'];
      if (gives !== undefined && (!Array.isArray(gives) || gives.some((x) => !(HERMES_GROUPS as readonly unknown[]).includes(x)))) {
        throw new Error(`config: profile "${name}": acp.gives must be a list of ${HERMES_GROUPS.join(', ')}`);
      }
      acp = { command: cmd as string | undefined, args: argv as string[] | undefined, ...(gives !== undefined ? { gives: gives as string[] } : {}) };
    }
    if (typeof p['workdir'] !== 'string' || p['workdir'] === '') throw new Error(`config: profile "${name}": workdir is required`);
    const aliases = p['modelAliases'];
    if (aliases !== undefined && (!isRecord(aliases) || Object.values(aliases).some((x) => typeof x !== 'string'))) {
      throw new Error(`config: profile "${name}": modelAliases must map names to strings`);
    }
    const extra = p['extraAllowedTools'];
    if (extra !== undefined && (!Array.isArray(extra) || extra.some((x) => typeof x !== 'string' || x === ''))) {
      throw new Error(`config: profile "${name}": extraAllowedTools must be a list of strings`);
    }
    const envMap = p['env'];
    if (envMap !== undefined && (!isRecord(envMap) || Object.entries(envMap).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== 'string' || RESERVED_ENV.has(k)))) {
      throw new Error(`config: profile "${name}": env must map variable names to strings (not ${[...RESERVED_ENV].join(' or ')})`);
    }
    const pass = p['passEnv'];
    if (pass !== undefined && (!Array.isArray(pass) || pass.some((x) => typeof x !== 'string' || !ENV_NAME.test(x) || RESERVED_ENV.has(x)))) {
      throw new Error(`config: profile "${name}": passEnv must be a list of variable names (not ${[...RESERVED_ENV].join(' or ')})`);
    }
    const authHome = p['authHome'];
    if (authHome !== undefined && (typeof authHome !== 'string' || !isAbsolute(authHome) || [...authHome].some((c) => c.charCodeAt(0) < 32))) {
      throw new Error(`config: profile "${name}": authHome must be an absolute folder path`);
    }
    if (authHome !== undefined && agent !== 'claude-code' && agent !== 'codex') throw new Error(`config: profile "${name}": authHome is only for claude-code and codex profiles`);
    const fullAccess = p['fullAccess'];
    if (fullAccess !== undefined && fullAccess !== true && fullAccess !== false && fullAccess !== 'allowed') throw new Error(`config: profile "${name}": fullAccess must be true, false or "allowed"`);
    if (fullAccess !== undefined && fullAccess !== false && agent !== 'codex') throw new Error(`config: profile "${name}": fullAccess is only for codex profiles`);
    const notes = p['instructions'];
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 20_000)) throw new Error(`config: profile "${name}": instructions must be text of at most 20000 characters`);
    profiles[name] = {
      agent,
      driver,
      ...(acp !== undefined ? { acp } : {}),
      workdir: p['workdir'],
      ...(typeof p['model'] === 'string' && p['model'] !== '' ? { model: p['model'] } : {}),
      ...(aliases !== undefined ? { modelAliases: aliases as Record<string, string> } : {}),
      ...(extra !== undefined ? { extraAllowedTools: extra as string[] } : {}),
      ...(envMap !== undefined ? { env: envMap as Record<string, string> } : {}),
      ...(pass !== undefined ? { passEnv: pass as string[] } : {}),
      ...(typeof authHome === 'string' ? { authHome } : {}),
      ...(fullAccess === true || fullAccess === 'allowed' ? { fullAccess } : {}),
      ...(typeof notes === 'string' && notes.trim() !== '' ? { instructions: notes } : {}),
    };
  }
  const binRaw = isRecord(raw['bin']) ? raw['bin'] : {};
  return {
    profiles,
    maxConcurrentRuns: Math.floor(positive(raw['maxConcurrentRuns'], 4, 'maxConcurrentRuns')),
    killGraceSeconds: positive(raw['killGraceSeconds'], 5, 'killGraceSeconds'),
    budgetGraceSeconds: positive(raw['budgetGraceSeconds'], 10, 'budgetGraceSeconds'),
    keepFinishedSeconds: positive(raw['keepFinishedSeconds'], 3600, 'keepFinishedSeconds'),
    defaultBudgetSeconds: positive(raw['defaultBudgetSeconds'], 600, 'defaultBudgetSeconds'),
    bin: {
      claude: typeof binRaw['claude'] === 'string' ? binRaw['claude'] : 'claude',
      codex: typeof binRaw['codex'] === 'string' ? binRaw['codex'] : 'codex',
    },
    cancelGraceSeconds: positive(raw['cancelGraceSeconds'], 10, 'cancelGraceSeconds'),
    approvalWaitSeconds: positive(raw['approvalWaitSeconds'], 35 * 60, 'approvalWaitSeconds'),
    mcpTokenInFile: raw['mcpTokenInFile'] === true,
  };
}

export function loadConfig(path: string): BridgeConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`config: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`config: ${path} is not valid JSON`);
  }
  return parseConfig(json);
}

/** The profile a request uses: the one named, else `default`; null when neither exists. */
export function profileFor(config: BridgeConfig, name: string): { name: string; profile: ProfileConfig } | null {
  const own = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
  if (own) return { name, profile: own };
  const fallback = config.profiles['default'];
  return fallback ? { name, profile: fallback } : null;
}
