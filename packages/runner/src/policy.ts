import { parse as parseYaml } from 'yaml';
import type { RunnerConfig } from './config.ts';

// What the runner decides for its own machine (SPEC §7.4): the server renders the *agent's* profile — model, tools, the endpoints it talks
// to — and the runner decides the *host's* policy: where the agent's shell commands run, in which directory, with how much time. The server
// never decides a machine's sandbox, so the runner appends a `terminal:` section to the received `config.yaml` itself, and it refuses a
// `config.yaml` that tries to say anything about the host.

/** The only top-level sections of a rendered profile (docs/plugins/runtime-hermes.md): anything else is not the server's to say. */
const ALLOWED_SECTIONS = new Set(['model', 'providers', 'mcp_servers', 'agent', 'platform_toolsets']);

/** The keys each section may carry: exactly what `runtime-hermes/src/profile.ts` renders. A key it does not render (`api_key_env`, `base_url`, …) is refused. */
const MODEL_KEYS = new Set(['provider', 'default']);
const AGENT_KEYS = new Set(['reasoning_effort', 'disabled_toolsets']);
const PLATFORM_TOOLSET_KEYS = new Set(['cli']);
const PROVIDER_KEYS = new Set(['name', 'api', 'api_key', 'transport', 'default_model']);
const MCP_KEYS = new Set(['url', 'headers', 'timeout', 'connect_timeout']);

export type ConfigCheck = { ok: true } | { ok: false; reason: string };

const isMapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The first key of `value` that is not in `allowed`, as a refusal; null when there is none (or `value` is not a mapping, which the caller reports). */
function strayKey(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): ConfigCheck | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, reason: `${where} has a "${key}" key; the server renders only ${[...allowed].join(', ')}` };
  }
  return null;
}

/**
 * Whether a received `config.yaml` is a profile this runner will run. It must parse, carry only the sections the server renders and only
 * the keys it renders in them, and its MCP servers must be addresses (`url`), never a program to start: a stdio MCP server is a program the
 * host would execute, and no server gets to name one. Provider entries may not point at a credential or an address the host holds
 * (`api_key_env`, `base_url`, …): the only key a run uses is the token the server put in `api_key`.
 */
export function checkServerConfig(text: string): ConfigCheck {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { ok: false, reason: `config.yaml does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isMapping(doc)) return { ok: false, reason: 'config.yaml is not a mapping' };
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_SECTIONS.has(key)) return { ok: false, reason: `config.yaml has a "${key}" section; the runner decides that for its machine` };
  }
  const flat: [string, ReadonlySet<string>][] = [['model', MODEL_KEYS], ['agent', AGENT_KEYS], ['platform_toolsets', PLATFORM_TOOLSET_KEYS]];
  for (const [section, allowed] of flat) {
    const value = doc[section];
    if (value === undefined) continue;
    if (!isMapping(value)) return { ok: false, reason: `${section} is not a mapping` };
    const stray = strayKey(value, allowed, section);
    if (stray) return stray;
  }
  const providers = doc['providers'];
  if (providers !== undefined) {
    if (!isMapping(providers)) return { ok: false, reason: 'providers is not a mapping' };
    for (const [name, provider] of Object.entries(providers)) {
      if (!isMapping(provider)) return { ok: false, reason: `provider "${name}" is not a mapping` };
      const stray = strayKey(provider, PROVIDER_KEYS, `provider "${name}"`);
      if (stray) return stray;
    }
  }
  const mcp = doc['mcp_servers'];
  if (mcp !== undefined) {
    if (!isMapping(mcp)) return { ok: false, reason: 'mcp_servers is not a mapping' };
    for (const [name, entry] of Object.entries(mcp)) {
      if (!isMapping(entry)) return { ok: false, reason: `mcp server "${name}" is not a mapping` };
      for (const forbidden of ['command', 'args', 'env']) {
        if (forbidden in entry) return { ok: false, reason: `mcp server "${name}" names a program to start (${forbidden}); only addresses are accepted` };
      }
      if (typeof entry['url'] !== 'string') return { ok: false, reason: `mcp server "${name}" has no url` };
      const stray = strayKey(entry, MCP_KEYS, `mcp server "${name}"`);
      if (stray) return stray;
    }
  }
  return { ok: true };
}

const q = (value: string): string => JSON.stringify(value);

/**
 * The `terminal:` section this runner appends. `docker`: the agent's shell tool runs in a container started from the sandbox image, with
 * the process's working directory — the team's workspace — mounted at `/workspace`. Measured on Hermes 0.21.5 (docs/plugins/runners.md):
 * `cwd` must stay `"."` (the process directory). Naming `/workspace` there makes Hermes treat the path as already inside the container and
 * skip the mount, so commands run in an empty container directory and the file tools write somewhere the host cannot see. The container
 * carries a label naming the run, which is how the runner removes it afterwards (Hermes leaves it running).
 */
export function terminalSection(config: Pick<RunnerConfig, 'terminal' | 'sandboxImage'>, runId: string, budgetSeconds: number, uid: number | null): string {
  if (config.terminal === 'local') {
    return ['terminal:', '  backend: "local"', '  cwd: "."', '  timeout: 180', ''].join('\n');
  }
  const lines = [
    'terminal:',
    '  backend: "docker"',
    '  cwd: "."',
    '  timeout: 180',
    `  lifetime_seconds: ${Math.max(60, Math.ceil(budgetSeconds) + 60)}`,
    `  docker_image: ${q(config.sandboxImage)}`,
    '  docker_mount_cwd_to_workspace: true',
    // Files written in the workspace belong to the person who runs the runner, not to root.
    ...(uid !== null && uid !== 0 ? ['  docker_run_as_host_user: true'] : []),
    `  docker_extra_args: ["--label", ${q(`${RUN_LABEL}=${runId}`)}]`,
    '',
  ];
  return lines.join('\n');
}

/** The label every sandbox container of a run carries. */
export const RUN_LABEL = 'manythreads-runner-run';

/** The profile's files with the runner's policy appended to `config.yaml`. */
export function withRunnerPolicy(
  files: Record<string, string>,
  config: Pick<RunnerConfig, 'terminal' | 'sandboxImage'>,
  runId: string,
  budgetSeconds: number,
  uid: number | null,
): Record<string, string> {
  const base = files['config.yaml'] ?? '';
  return {
    ...files,
    'config.yaml': `${base.replace(/\n*$/, '\n')}# --- runner policy: appended by the runner, never by the server ---\n${terminalSection(config, runId, budgetSeconds, uid)}`,
  };
}
