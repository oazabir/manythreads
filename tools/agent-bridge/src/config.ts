import { readFileSync } from 'node:fs';

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

export type AgentKind = 'claude-code' | 'codex';

export interface ProfileConfig {
  agent: AgentKind;
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
  /** Where the CLIs are found. Default: `claude` and `codex` on PATH. */
  bin: { claude: string; codex: string };
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
    if (p['agent'] !== 'claude-code' && p['agent'] !== 'codex') throw new Error(`config: profile "${name}": agent must be "claude-code" or "codex"`);
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
    const notes = p['instructions'];
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 20_000)) throw new Error(`config: profile "${name}": instructions must be text of at most 20000 characters`);
    profiles[name] = {
      agent: p['agent'],
      workdir: p['workdir'],
      ...(typeof p['model'] === 'string' && p['model'] !== '' ? { model: p['model'] } : {}),
      ...(aliases !== undefined ? { modelAliases: aliases as Record<string, string> } : {}),
      ...(extra !== undefined ? { extraAllowedTools: extra as string[] } : {}),
      ...(envMap !== undefined ? { env: envMap as Record<string, string> } : {}),
      ...(pass !== undefined ? { passEnv: pass as string[] } : {}),
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
