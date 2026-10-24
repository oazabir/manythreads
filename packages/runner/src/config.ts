import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The runner's configuration (SPEC §7.4, PLAN P6-06): flags and environment variables, flags first. Everything has a default that works on
// a developer's machine except the two things only the operator knows: where the server is and where the token file is.

export interface RunnerConfig {
  /** `https://host` (or `http://localhost:3000`): the server's public address. The connection is `wss://host/api/runners/connect`. */
  server: string;
  /** A file holding the runner token (one line). The token is never taken from a flag, which a process list shows. */
  tokenFile: string;
  /** The runner's name, if the operator wants it checked: the server knows the name from the token and the connection ends if they differ. */
  name: string | null;
  /** The Hermes binary. */
  hermesBin: string;
  /** Hermes' own home (`HERMES_HOME`, default `~/.hermes`). A run's profile lives at `<hermesHome>/profiles/<home>`. */
  hermesHome: string;
  /** Where each team's persistent workspace lives: `<workspaceRoot>/<team slug>/`. */
  workspaceRoot: string;
  /** How many jobs may run at once. */
  maxJobs: number;
  /** `docker`: the agent's shell commands run in a container (the default). `local`: on this machine, unsandboxed (an explicit opt-in). */
  terminal: 'docker' | 'local';
  /** The image the shell commands run in. */
  sandboxImage: string;
  /** Capabilities to advertise on top of the detected ones. */
  extraCapabilities: string[];
}

export class ConfigError extends Error {}

const FLAGS = new Set([
  'server', 'token-file', 'name', 'hermes-bin', 'hermes-home', 'workspace-root', 'max-jobs', 'terminal', 'sandbox-image', 'capabilities',
]);

/** `--key value` and `--key=value`; an unknown flag is an error (a typo must not silently run with defaults). */
export function parseFlags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') continue; // `pnpm start -- --server …` passes the separator on
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!FLAGS.has(key)) throw new ConfigError(`unknown flag --${key}`);
    let value: string;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new ConfigError(`--${key} needs a value`);
      value = next;
      i += 1;
    }
    out.set(key, value);
  }
  return out;
}

/** Build the configuration from flags and environment. Pure apart from reading nothing: the token file is read by `readToken`. */
export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): RunnerConfig {
  const flags = parseFlags(argv);
  const pick = (flag: string, variable: string): string | undefined => {
    const value = flags.get(flag) ?? env[variable];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const server = pick('server', 'MANYTHREADS_RUNNER_SERVER');
  if (!server) throw new ConfigError('the server address is required: --server https://threads.example (or MANYTHREADS_RUNNER_SERVER)');
  if (!/^https?:\/\/[^/\s]+/.test(server)) throw new ConfigError(`--server must start with http:// or https:// (got "${server}")`);
  const tokenFile = pick('token-file', 'MANYTHREADS_RUNNER_TOKEN_FILE');
  if (!tokenFile) throw new ConfigError('the token file is required: --token-file /etc/manythreads/runner.token (or MANYTHREADS_RUNNER_TOKEN_FILE)');
  const maxJobs = Number(pick('max-jobs', 'MANYTHREADS_RUNNER_MAX_JOBS') ?? '2');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 64) throw new ConfigError('--max-jobs must be a whole number from 1 to 64');
  const terminal = pick('terminal', 'MANYTHREADS_RUNNER_TERMINAL') ?? 'docker';
  if (terminal !== 'docker' && terminal !== 'local') throw new ConfigError('--terminal must be "docker" or "local"');
  const hermesHome = resolve(pick('hermes-home', 'HERMES_HOME') ?? join(homedir(), '.hermes'));
  return {
    server: server.replace(/\/+$/, ''),
    tokenFile: resolve(tokenFile),
    name: pick('name', 'MANYTHREADS_RUNNER_NAME') ?? null,
    hermesBin: pick('hermes-bin', 'MANYTHREADS_HERMES_BIN') ?? 'hermes',
    hermesHome,
    workspaceRoot: resolve(pick('workspace-root', 'MANYTHREADS_RUNNER_WORKSPACE_ROOT') ?? join(homedir(), 'manythreads-workspaces')),
    maxJobs,
    terminal,
    sandboxImage: pick('sandbox-image', 'MANYTHREADS_RUNNER_SANDBOX_IMAGE') ?? 'manythreads/runner-sandbox:1',
    extraCapabilities: (pick('capabilities', 'MANYTHREADS_RUNNER_CAPABILITIES') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c !== ''),
  };
}

/** The WebSocket address of the server's connect route. */
export function connectUrl(server: string): string {
  return `${server.replace(/^http/, 'ws')}/api/runners/connect`;
}

/** Where a run's profile home is written: Hermes only boots from `<hermes home>/profiles/<name>`. */
export const profilesDir = (config: Pick<RunnerConfig, 'hermesHome'>): string => join(config.hermesHome, 'profiles');

/** Read the token. A file other users can read is refused: the token is the runner's whole identity. */
export function readToken(path: string): string {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new ConfigError(`the token file ${path} cannot be read`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new ConfigError(`the token file ${path} is readable by other users; run: chmod 600 ${path}`);
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!/^mtr_[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ConfigError(`the token file ${path} does not hold a runner token (mtr_…)`);
  return token;
}
