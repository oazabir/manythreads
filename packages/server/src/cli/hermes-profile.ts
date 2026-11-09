// The files of one Hermes profile, written the same way by two callers: `tools/devbox/provision-host-bots.mjs` (the host gateway of the devbox)
// and `admin brain-profile` / `admin init` (the Hermes container of a Docker Compose install, docs/deploy/compose.md).
//
// This file holds only what is the same for both: how a profile directory is built and replaced, how its `.env` is merged, what its `config.yaml`
// says, and how a token already in a profile is checked. What differs (where the profile is, which model address it uses, how a token is minted)
// is a parameter. It imports nothing outside `node:`, so the script can load it with a file URL (Node strips the types) and the server's own
// TypeScript can import it normally.
//
//   * A profile directory is built as `.tmp-<profile>-<pid>` (a name the gateway does not serve) and renamed into place; for an existing
//     profile config.yaml is replaced first and .env last, each through a temp file and a rename.
//   * .env is merged: only API_SERVER_KEY, MANYTHREADS_MCP_TOKEN and LITELLM_API_KEY are touched, every other line stays.
//   * config.yaml is rewritten only when it carries the "Written by" header; a hand-edited one is left alone unless `force` (the old file is kept
//     as config.yaml.bak).
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The line that says a config.yaml is ours to rewrite. Profiles written before this module existed carry it, so it must not change. */
export const PROFILE_MARKER = 'Written by tools/devbox/provision-host-bots.mjs';
/** The only `.env` keys this code touches. */
export const MANAGED_ENV_KEYS = ['API_SERVER_KEY', 'MANYTHREADS_MCP_TOKEN', 'LITELLM_API_KEY'] as const;
export type ManagedEnv = Record<(typeof MANAGED_ENV_KEYS)[number], string>;

/** Read `KEY=value` lines of an env file; quotes around a value are dropped. Values are never printed. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

/** The existing .env with the three managed keys set; every other line stays as it was. */
export function mergeEnv(existing: string | null, values: ManagedEnv): string {
  const lines = existing === null ? [] : existing.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const key = m?.[1] as keyof ManagedEnv | undefined;
    if (key !== undefined && (MANAGED_ENV_KEYS as readonly string[]).includes(key) && !seen.has(key)) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });
  for (const k of MANAGED_ENV_KEYS) if (!seen.has(k)) out.push(`${k}=${values[k]}`);
  return `${out.join('\n')}\n`;
}

/** Replace a file through a temp file next to it and a rename, so a reader never sees half of it. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The front matter of a BOT.md (CRLF or LF): the text between the first two `---` lines, where it starts and ends, and its line ending. */
export function splitBotMd(md: string): { front: string; start: number; end: number; eol: string } {
  const m = /^---\r?\n([\s\S]*?\r?\n)---(\r?\n|$)/.exec(md);
  if (!m) throw new Error('BOT.md has no front matter');
  const front = m[1] as string;
  const start = m[0].indexOf('\n') + 1;
  return { front, start, end: start + front.length, eol: front.includes('\r\n') ? '\r\n' : '\n' };
}

/** The definition's `capabilities.runtime` list (what the bot's process may do: shell, files, git, browser, ...). */
export function runtimeGrants(md: string): string[] {
  const m = /^capabilities:\r?\n[\s\S]*?^ {2}runtime:[ \t]*\r?\n((?:[ \t]+-.*\r?\n)+)/m.exec(splitBotMd(md).front);
  return m ? [...(m[1] as string).matchAll(/^\s*-\s*([A-Za-z0-9_.-]+)\s*$/gm)].map((x) => x[1] as string) : [];
}
export const hasShell = (md: string): boolean => runtimeGrants(md).includes('shell');

export interface ProfileSettings {
  /** The platform's one MCP address, `<public url>/mcp`. */
  mcpUrl: string;
  /** The model gateway's OpenAI-style address, ending in `/v1`. */
  llmBaseUrl: string;
  /** The model name asked for (`default` on the devbox gateway, an alias such as `smart` on a LiteLLM proxy of this platform). */
  model?: string;
  /** The working directory of the bot's terminal. */
  cwd: string;
  /** Hermes toolsets from the platform's own mapping (`hermesToolsets` in runtime-hermes). */
  toolsets: { enabled: readonly string[]; disabled: readonly string[] };
  /** The first comment line, after the marker. */
  description?: string;
}

const quote = (list: readonly string[]): string => `[${list.map((t) => JSON.stringify(t)).join(', ')}]`;

/** The profile's config.yaml. With the devbox settings the text is byte for byte what `provision-host-bots.mjs` always wrote. */
export function profileConfigText(s: ProfileSettings): string {
  const model = s.model ?? 'default';
  const description = s.description ?? "a bot served by this host's own Hermes gateway (api_server)";
  return `# manythreads mode A: ${description}. ${PROFILE_MARKER}.
model:
  default: ${JSON.stringify(model)}
  provider: "custom:litellm"
  base_url: ${JSON.stringify(s.llmBaseUrl)}
providers:
  litellm:
    base_url: ${s.llmBaseUrl}
    key_env: LITELLM_API_KEY
    default_model: ${model}
    models:
      ${model}: {context_length: 262144}
mcp_servers:
  manythreads:
    url: "${s.mcpUrl}"
    headers:
      Authorization: "Bearer \${MANYTHREADS_MCP_TOKEN}"
    timeout: 120
    connect_timeout: 30
platform_toolsets:
  api_server: ${quote(s.toolsets.enabled)}
agent:
  disabled_toolsets: ${quote(s.toolsets.disabled)}
tools:
  tool_search:
    enabled: "off"
terminal:
  backend: "local"
  cwd: "${s.cwd}"
  timeout: 600
`;
}

/** Does the MCP server accept this token? `initialize` works with no run open; HTTP 401 is a revoked or wrong token. The token travels in a header only. */
export async function probeToken(mcpUrl: string, token: string): Promise<'ok' | 'unauthorized' | 'unknown'> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'provision-host-bots', version: '1' } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.text().catch(() => '');
    if (res.status === 401) return 'unauthorized';
    return res.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type TokenState = 'none' | 'kept' | 'kept-unverified' | 'stale';
export interface ProfileView {
  dir: string;
  exists: boolean;
  token: string;
  state: TokenState;
}

/** What the profile and its token look like now, without changing anything. */
export async function inspectProfile(profilesRoot: string, profile: string, mcpUrl: string): Promise<ProfileView> {
  const dir = join(profilesRoot, profile);
  const exists = existsSync(dir);
  const token = exists ? (readEnvFile(join(dir, '.env'))['MANYTHREADS_MCP_TOKEN'] ?? '') : '';
  let state: TokenState = 'none';
  if (token) {
    const cfg = existsSync(join(dir, 'config.yaml')) ? readFileSync(join(dir, 'config.yaml'), 'utf8') : '';
    const url = /^\s*url:\s*"?([^"\s]+)"?/m.exec(cfg)?.[1];
    if (url && url !== mcpUrl) state = 'stale';
    else {
      const p = await probeToken(mcpUrl, token);
      state = p === 'ok' ? 'kept' : p === 'unknown' ? 'kept-unverified' : 'stale';
    }
  }
  return { dir, exists, token, state };
}

/**
 * Get the place to write ready, BEFORE a token is minted (a token is shown once): an existing profile must be writable; a new one is built in a
 * temp directory next to it. Returns the directory the files go to.
 */
export function prepareProfileDir(profilesRoot: string, profile: string, view: ProfileView): string {
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
  const build = view.exists ? view.dir : join(profilesRoot, `.tmp-${profile}-${process.pid}`);
  if (view.exists) {
    accessSync(view.dir, constants.W_OK);
    const envFile = join(view.dir, '.env');
    if (existsSync(envFile)) accessSync(envFile, constants.W_OK);
  } else {
    rmSync(build, { recursive: true, force: true });
    mkdirSync(build, { mode: 0o700 });
  }
  return build;
}

/** A write that failed: a half-built new directory goes away; an existing profile is left as it is. */
export function discardProfileDir(build: string, view: ProfileView): void {
  if (!view.exists) rmSync(build, { recursive: true, force: true });
}

/**
 * Write the files. A new profile is built in `build` and renamed into place. For an existing one, config.yaml is replaced when it is ours (or
 * missing), or when it was hand-edited and `force` is set (the old file is kept as .bak); .env is replaced last, because the token only lands once
 * the config is in place. Returns the words for the summary line.
 */
export function writeProfileFiles(input: { profile: string; view: ProfileView; build: string; config: string; values: ManagedEnv; force?: boolean }): string {
  const { view, build, config, values } = input;
  if (!view.exists) {
    writeAtomic(join(build, 'config.yaml'), config);
    writeAtomic(join(build, '.env'), mergeEnv(null, values));
    renameSync(build, view.dir);
    return 'created';
  }
  const cfgFile = join(view.dir, 'config.yaml');
  const cfgNow = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
  let word = 'unchanged';
  if (cfgNow === null || (cfgNow.includes(PROFILE_MARKER) && cfgNow !== config)) {
    writeAtomic(cfgFile, config);
    word = 'config updated';
  } else if (cfgNow !== config && !cfgNow.includes(PROFILE_MARKER)) {
    if (input.force === true) {
      copyFileSync(cfgFile, `${cfgFile}.bak`);
      chmodSync(`${cfgFile}.bak`, 0o600);
      writeAtomic(cfgFile, config);
      word = 'config replaced (.bak kept)';
    } else word = 'config hand-edited, kept';
  }
  const envFile = join(view.dir, '.env');
  const envNow = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
  const envWanted = mergeEnv(envNow, values);
  if (envNow !== envWanted) {
    writeAtomic(envFile, envWanted);
    word = word === 'unchanged' ? 'env updated' : `${word}, env updated`;
  }
  return word;
}
