import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MIN_PASSWORD_LENGTH, withSystem, type Tx } from '@manythreads/kernel';
import type pg from 'pg';
import { MANAGED_ENV_KEYS, discardProfileDir, inspectProfile, prepareProfileDir, profileConfigText, writeProfileFiles } from './hermes-profile.ts';

/**
 * `admin init` and `admin brain-profile`: the two steps that make a new Docker Compose install usable (docs/deploy/compose.md).
 *
 *   init           makes the first administrator (the same call the browser's first-run page makes, so the same rules run), the first team, the Hermes
 *                  runner of this install (the workspace default), and the workspace Brain's profile for it. Safe to run again.
 *   brain-profile  only the last part: the Brain's profile files and its token, for an install that already has an administrator.
 *
 * Both talk to the running server over HTTP as the administrator, like the host script `tools/devbox/provision-host-bots.mjs --workspace-brain` does; the
 * profile files come from the code that script shares (hermes-profile.ts). Nothing here prints a password or a key: a password the command made up is
 * printed once, on purpose, and nothing else secret is.
 */

export interface InitEnv {
  /** Where the running server answers (the container's own name inside the compose network). */
  baseUrl: string;
  /** The Hermes gateway as the server reaches it (`http://hermes:8642`); empty = no runner, no Brain profile. */
  hermesUrl: string;
  /** The gateway's key; it is the runner's key and the `API_SERVER_KEY` of every profile. */
  hermesKey: string;
  /** The key the profiles use for the model gateway (a LiteLLM virtual key). */
  llmKey: string;
  /** The key Hindsight uses for fact extraction (limited to the alias `fast`); created with the one above when set. */
  hindsightLlmKey: string;
  /** The LiteLLM address and master key the server uses; with both set the virtual keys above are created. */
  litellmUrl: string;
  litellmMasterKey: string;
  /** The model gateway address as the Hermes container reaches it. */
  llmBaseUrl: string;
  /** The model name the profile asks for: an alias of the LLM page. */
  model: string;
  /** The MCP address as the Hermes container reaches it. */
  mcpUrl: string;
  /** Where the profile directories are written (the volume the Hermes container shares). */
  profilesDir: string;
}

export function initEnvFromEnv(env: NodeJS.ProcessEnv): InitEnv {
  const port = env['PORT'] ?? '3000';
  const internal = (env['MANYTHREADS_INTERNAL_URL'] ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  return {
    baseUrl: internal,
    hermesUrl: (env['MANYTHREADS_HERMES_URL'] ?? '').replace(/\/+$/, ''),
    hermesKey: env['MANYTHREADS_HERMES_API_KEY'] ?? '',
    llmKey: env['MANYTHREADS_HERMES_LLM_KEY'] ?? '',
    hindsightLlmKey: env['MANYTHREADS_HINDSIGHT_LLM_KEY'] ?? '',
    litellmUrl: (env['MANYTHREADS_LITELLM_URL'] ?? '').replace(/\/+$/, ''),
    litellmMasterKey: env['MANYTHREADS_LITELLM_MASTER_KEY'] ?? '',
    llmBaseUrl: (env['MANYTHREADS_HERMES_LLM_BASE_URL'] ?? `${(env['MANYTHREADS_LITELLM_URL'] ?? '').replace(/\/+$/, '')}/v1`).replace(/\/+$/, ''),
    model: env['MANYTHREADS_HERMES_MODEL'] ?? 'smart',
    mcpUrl: (env['MANYTHREADS_HERMES_MCP_URL'] ?? `${internal}/mcp`).replace(/\/+$/, ''),
    profilesDir: env['MANYTHREADS_HERMES_PROFILES_DIR'] ?? '/hermes-profiles',
  };
}

/** A parsed JSON answer of the server: each call reads the few fields it needs and checks them where it uses them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A small HTTP client that keeps the session and CSRF cookies of one sign-in. */
export class Http {
  private cookies = new Map<string, string>();
  private csrf: string | null = null;
  constructor(readonly base: string) {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size > 0 ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair = ''] = set.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (/^(?:__Host-)?manythreads_csrf$/.test(name) && value !== '') this.csrf = decodeURIComponent(value);
    }
    const text = await res.text();
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text.slice(0, 300) };
    }
    return { status: res.status, json };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errorText = (r: { status: number; json: Json }): string => `HTTP ${r.status}${typeof r.json?.error?.message === 'string' ? `: ${r.json.error.message.slice(0, 160)}` : ''}`;

export class InitError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Wait until the server answers `/readyz` with 200. */
async function waitReady(http: Http, say: (line: string) => void, seconds = 180): Promise<void> {
  const until = Date.now() + seconds * 1000;
  let last = 'no answer';
  while (Date.now() < until) {
    try {
      const r = await http.call('GET', '/readyz');
      if (r.status === 200) return;
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  say(`The server did not become ready within ${seconds} seconds (${last}).`);
  throw new InitError(`The server at ${http.base} is not ready. Check \`docker compose logs manythreads\`.`);
}

export interface FirstAdmin {
  email: string;
  name: string;
  workspace: string;
  password: string;
  /** True when this call made the workspace; false when it only signed in to one that existed. */
  created: boolean;
}

/**
 * The first administrator. While no workspace exists the browser's first-run page is the only way in (a link printed in the server's log); here the
 * command stores a fresh one-time link of its own and posts the same form, so the workspace, the owner and the password are made by the same code.
 * With a workspace already there it signs in with the given email and password.
 */
export async function signInOrBootstrap(pool: pg.Pool, http: Http, admin: Omit<FirstAdmin, 'created'>, now: () => Date): Promise<boolean> {
  const workspaces = await withSystem(async (tx: Tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.workspaces')).rows[0]?.n ?? 0, { pool });
  if (workspaces === 0) {
    const token = randomBytes(32).toString('base64url');
    await withSystem(
      async (tx: Tx) => {
        await tx.query('DELETE FROM app.bootstrap_tokens WHERE used_at IS NULL');
        await tx.query('INSERT INTO app.bootstrap_tokens (token_hash, created_at) VALUES ($1, $2)', [createHash('sha256').update(token).digest(), now()]);
      },
      { pool },
    );
    const r = await http.call('POST', `/api/bootstrap/${token}`, { workspaceName: admin.workspace, name: admin.name, email: admin.email, password: admin.password });
    if (r.status !== 200 && r.status !== 201) throw new InitError(`The first-run request was refused (${errorText(r)}).`);
    return true;
  }
  const r = await http.call('POST', '/api/auth/password/sign-in', { email: admin.email, password: admin.password });
  if (r.status !== 200) {
    throw new InitError(
      r.status === 401 || r.status === 400
        ? `A workspace already exists and ${admin.email} could not sign in with that password. Give the administrator's own email and pipe its password on standard input.`
        : `Sign-in failed (${errorText(r)}).`,
    );
  }
  return false;
}

/** The first team of the workspace (the Brain's conversation lives in a team). Returns its slug. */
export async function ensureTeam(http: Http, name: string): Promise<string> {
  const list = await http.call('GET', '/api/teams');
  const first = (list.json?.teams ?? [])[0] as { slug: string } | undefined;
  if (list.status === 200 && first) return first.slug;
  const made = await http.call('POST', '/api/teams', { name });
  const slug = made.json?.team?.slug as string | undefined;
  if (made.status >= 300 || !slug) throw new InitError(`The first team could not be made (${errorText(made)}).`);
  return slug;
}

export interface RunnerSpec {
  name: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  profileRule: string;
}

/** The Hermes runner of this install, open to every team and the workspace default. Returns its id and the profile rule it has. */
export async function ensureRunner(http: Http, spec: RunnerSpec): Promise<{ id: string; profileRule: string; made: boolean }> {
  const list = await http.call('GET', '/api/admin/bot-runners');
  if (list.status !== 200) throw new InitError(`The runner list could not be read (${errorText(list)}).`);
  const have = (list.json?.items ?? []).find((r: { name: string }) => r.name === spec.name) as { id: string; profileRule: string | null; baseUrl: string | null; isDefault: boolean } | undefined;
  let id: string;
  let made = false;
  let rule = spec.profileRule;
  if (have) {
    id = have.id;
    rule = have.profileRule ?? spec.profileRule;
    // A key that changed in the environment is written again; the address too.
    const patch = await http.call('PATCH', `/api/admin/bot-runners/${id}`, { baseUrl: spec.baseUrl, apiKey: spec.apiKey, profileRule: spec.profileRule });
    if (patch.status !== 200) throw new InitError(`The runner "${spec.name}" could not be updated (${errorText(patch)}).`);
    rule = spec.profileRule;
  } else {
    const created = await http.call('POST', '/api/admin/bot-runners', {
      name: spec.name,
      label: spec.label,
      kind: 'hermes_gateway',
      baseUrl: spec.baseUrl,
      apiKey: spec.apiKey,
      profileRule: spec.profileRule,
      teams: { all: true },
      enabled: true,
    });
    id = created.json?.runner?.id as string;
    if (created.status >= 300 || !id) throw new InitError(`The runner could not be made (${errorText(created)}).`);
    made = true;
  }
  const def = await http.call('PUT', '/api/admin/bot-runners/default', { runnerId: id });
  if (def.status >= 300) throw new InitError(`The runner could not be made the default (${errorText(def)}).`);
  return { id, profileRule: rule, made };
}

/**
 * Create the LiteLLM virtual keys of this install: the one the Hermes profiles use (the aliases a bot asks for) and the one Hindsight uses (the alias
 * `fast` only). Idempotent; a key travels in a header and a body only, and is never printed.
 */
export async function ensureLlmKey(env: InitEnv, say: (line: string) => void): Promise<void> {
  if (!env.litellmUrl || !env.litellmMasterKey) return;
  const headers = { authorization: `Bearer ${env.litellmMasterKey}`, 'content-type': 'application/json' };
  const wanted = [
    { key: env.llmKey, models: ['smart', 'fast', 'code'], what: 'the Hermes container', purpose: 'the Hermes container of this install' },
    { key: env.hindsightLlmKey, models: ['fast'], what: 'the memory engine', purpose: 'hindsight fact extraction' },
  ];
  for (const w of wanted) {
    if (!w.key) continue;
    const info = await fetch(`${env.litellmUrl}/key/info?key=${encodeURIComponent(w.key)}`, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (info?.status === 200) continue;
    const res = await fetch(`${env.litellmUrl}/key/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: w.key, models: w.models, metadata: { purpose: w.purpose } }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    const text = res ? await res.text().catch(() => '') : '';
    if (res?.status === 200) say(`The model key for ${w.what} was created in the model gateway.`);
    else if (!(res && (res.status === 400 || res.status === 409) && /already|duplicate/i.test(text))) {
      say(`The model key for ${w.what} could not be created (${res ? `HTTP ${res.status}` : 'no answer'}); it cannot reach a model until the key exists.`);
    }
  }
}

export interface BrainOptions {
  /** The slug of a team the token is minted through (any team will do; the Brain belongs to none). */
  team: string;
  runnerId: string;
  profileRule: string;
  /** Overrides the profile name the runner's rule would give. */
  profileName?: string;
  /** Wait this long for the Hermes container to answer the runner test (seconds). 0 = do not test. */
  testSeconds: number;
}

/** Wait for the workspace Brain to be in a team's roster (it is loaded by a job after the first team exists). */
async function waitForBrain(http: Http, team: string, seconds = 120): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const r = await http.call('GET', `/api/teams/${team}/bots`);
    if ((r.json?.bots ?? []).some((b: { slug: string; status?: string }) => b.slug === 'brain' && (b.status === undefined || b.status === 'active'))) return;
    await sleep(2000);
  }
  throw new InitError('The workspace Brain did not appear in the team within two minutes. Check `docker compose logs manythreads`.');
}

/**
 * Write the Brain's profile (config.yaml and .env) into the directory the Hermes container shares, mint its MCP token unless the profile holds one the
 * server still accepts, and (when asked) test the runner with that profile. Returns the profile name and a few words for the summary.
 */
export async function provisionBrainProfile(
  http: Http,
  env: InitEnv,
  opts: BrainOptions,
  say: (line: string) => void,
  toolsets: { enabled: readonly string[]; disabled: readonly string[] },
): Promise<{ profile: string; token: string; files: string; tested: boolean }> {
  const profile = opts.profileName ?? opts.profileRule.replace('{bot}', 'brain');
  await waitForBrain(http, opts.team);
  const view = await inspectProfile(env.profilesDir, profile, env.mcpUrl);
  const build = prepareProfileDir(env.profilesDir, profile, view);
  let tokenWord = view.state === 'kept-unverified' ? 'kept (not checked)' : view.state;
  let token = view.state === 'kept' || view.state === 'kept-unverified' ? view.token : '';
  let minted = false;
  try {
    if (!token) {
      const r = await http.call('POST', `/api/teams/${opts.team}/bots/brain/pairing-tokens`, {});
      token = r.status === 201 ? (r.json?.token ?? '') : '';
      if (!token) throw new InitError(`The Brain's token could not be made (${errorText(r)}).`);
      minted = true;
      tokenWord = view.state === 'stale' ? 'minted (old one refused)' : 'minted';
    }
    const config = profileConfigText({
      mcpUrl: env.mcpUrl,
      llmBaseUrl: env.llmBaseUrl,
      model: env.model,
      cwd: '/home/node',
      toolsets,
      description: 'the workspace Brain, served by the Hermes container of this Docker Compose install',
    });
    const values = { API_SERVER_KEY: env.hermesKey, MANYTHREADS_MCP_TOKEN: token, LITELLM_API_KEY: env.llmKey } as Record<(typeof MANAGED_ENV_KEYS)[number], string>;
    const files = writeProfileFiles({ profile, view, build, config, values });
    say(`Brain profile ${profile}: files ${files}, token ${tokenWord}.`);
    let tested = false;
    if (opts.testSeconds > 0) {
      const until = Date.now() + opts.testSeconds * 1000;
      let last = 'no answer';
      while (Date.now() < until) {
        const t = await http.call('POST', `/api/admin/bot-runners/${opts.runnerId}/test`, { profile });
        if (t.status === 200 && t.json?.ok) {
          tested = true;
          break;
        }
        last = t.status === 200 ? String(t.json?.error ?? 'not ok') : errorText(t);
        await sleep(t.status === 429 ? 15_000 : 4_000);
      }
      say(tested ? `The runner answers for ${profile}.` : `The runner did not answer for ${profile} in ${opts.testSeconds} seconds (${last}). Check \`docker compose logs hermes\`.`);
    }
    return { profile, token, files, tested };
  } catch (err) {
    discardProfileDir(build, view);
    if (minted) await http.call('DELETE', `/api/teams/${opts.team}/bots/brain/pairing-tokens`).catch(() => undefined);
    throw err;
  }
}

/**
 * The Hermes toolsets of the Brain's definition, from the platform's own mapping (loaded by file, like the devbox script does). The definition itself
 * travels with every run as `instructions`, so the profile holds no copy of it; only its `capabilities.runtime` grants matter here.
 */
export async function brainToolsets(env: NodeJS.ProcessEnv): Promise<{ enabled: string[]; disabled: string[] }> {
  const { readFileSync, existsSync } = await import('node:fs');
  const mod = (await import(new URL('../../../plugins/runtime-hermes/src/toolsets.ts', import.meta.url).href)) as {
    hermesToolsets: (grants: string[]) => { enabled: string[]; disabled: string[] };
  };
  const { runtimeGrants } = await import('./hermes-profile.ts');
  const templates = env['MANYTHREADS_TEMPLATES_DIR'] ?? new URL('../../../../templates/', import.meta.url).pathname;
  const file = join(templates, '_workspace', 'bots', 'brain', 'BOT.md');
  return mod.hermesToolsets(existsSync(file) ? runtimeGrants(readFileSync(file, 'utf8')) : []);
}

export interface InitArgs {
  email: string;
  name: string;
  workspace: string;
  team: string;
  profileName?: string;
  noRunnerTest: boolean;
}

export function parseInitArgs(rest: readonly string[]): InitArgs | string {
  const out: InitArgs = { email: '', name: '', workspace: '', team: '', noRunnerTest: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    const next = (): string => rest[++i] ?? '';
    if (a === '--email') out.email = next().trim().toLowerCase();
    else if (a === '--name') out.name = next().trim();
    else if (a === '--workspace') out.workspace = next().trim();
    else if (a === '--team') out.team = next().trim();
    else if (a === '--brain-profile') out.profileName = next().trim();
    else if (a === '--no-runner-test') out.noRunnerTest = true;
    else return `unknown option ${a}`;
  }
  if (!out.email.includes('@')) return '--email <address> is required';
  if (out.name === '') out.name = out.email.split('@')[0] ?? 'Administrator';
  if (out.workspace === '') out.workspace = 'My workspace';
  if (out.team === '') out.team = 'General';
  return out;
}

/** A password the command made up: 24 characters from an alphabet with no look-alikes. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export function checkPasswordLength(password: string): void {
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new InitError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 2);
}

export const profilePath = (env: InitEnv, profile: string): string => join(env.profilesDir, profile);

// ---- the two commands ---------------------------------------------------------------------------------------------------------------------------------

export const INIT_USAGE = [
  'usage: admin init --email <address> [--name <name>] [--workspace <name>] [--team <name>] [--brain-profile <name>] [--no-runner-test]',
  '          (the password is read from standard input; when none is given, one is made up and shown once)',
  '       admin brain-profile --email <address> [--brain-profile <name>]   (the administrator\'s password is read from standard input)',
].join('\n');

interface CommandIo {
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  pool?: () => pg.Pool;
  now?: () => Date;
}

async function readStdin(io: CommandIo): Promise<string> {
  if (io.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** `admin init` (brainOnly = false) and `admin brain-profile` (brainOnly = true). Returns the process exit code. */
export async function runInit(rest: readonly string[], io: CommandIo, brainOnly: boolean, makePool: () => pg.Pool): Promise<number> {
  const parsed = parseInitArgs(rest);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n${INIT_USAGE}`);
    return 2;
  }
  const env = initEnvFromEnv(io.env);
  const say = (line: string): void => io.out(line);
  const piped = await readStdin(io);
  let password = piped;
  let generated = false;
  if (password === '') {
    if (brainOnly) {
      io.err(`Pipe the administrator's password on standard input.\n${INIT_USAGE}`);
      return 2;
    }
    password = generatePassword();
    generated = true;
  }
  const pool = makePool();
  try {
    checkPasswordLength(password);
    const http = new Http(env.baseUrl);
    await waitReady(http, say);
    let created = false;
    if (brainOnly) {
      const r = await http.call('POST', '/api/auth/password/sign-in', { email: parsed.email, password });
      if (r.status !== 200) throw new InitError(`Sign-in failed (${errorText(r)}).`);
    } else {
      created = await signInOrBootstrap(pool, http, { email: parsed.email, name: parsed.name, workspace: parsed.workspace, password }, io.now ?? (() => new Date()));
      say(created ? `Workspace "${parsed.workspace}" made; ${parsed.email} is its owner.` : `The workspace exists already; signed in as ${parsed.email}.`);
      // Said the moment the administrator exists, not at the end: a later step (the team, the runner test) can fail, and a made-up password that was never shown would
      // lock the owner out of a workspace that was made (running the command again signs in with the password it is given, not a new one).
      if (created && generated) say(`Password (shown once, keep it): ${password}`);
    }
    const team = await ensureTeam(http, parsed.team);
    if (!brainOnly) say(`Team: ${team}.`);
    await ensureLlmKey(env, say);

    if (env.hermesUrl === '' || env.hermesKey === '') {
      if (brainOnly) throw new InitError('MANYTHREADS_HERMES_URL and MANYTHREADS_HERMES_API_KEY are not set in this container, so there is no Hermes to write a profile for.');
      say('No Hermes container is configured (MANYTHREADS_HERMES_URL is empty): no runner and no Brain profile were made.');
    } else {
      let runnerId: string;
      let rule = 'mt-{bot}';
      if (brainOnly) {
        const list = await http.call('GET', '/api/admin/bot-runners');
        const def = (list.json?.items ?? []).find((r: { isDefault: boolean }) => r.isDefault) as { id: string; kind: string; profileRule: string | null } | undefined;
        if (!def || def.kind !== 'hermes_gateway') throw new InitError('The default runner is not a Hermes gateway. Run `admin init` first.');
        runnerId = def.id;
        rule = def.profileRule ?? '{bot}';
      } else {
        const runner = await ensureRunner(http, { name: 'hermes', label: 'Hermes (this install)', baseUrl: env.hermesUrl, apiKey: env.hermesKey, profileRule: rule });
        runnerId = runner.id;
        rule = runner.profileRule;
        say(runner.made ? 'Runner "hermes" made and set as the workspace default.' : 'Runner "hermes" updated and set as the workspace default.');
      }
      const toolsets = await brainToolsets(io.env);
      const brain = await provisionBrainProfile(
        http,
        env,
        { team, runnerId, profileRule: rule, ...(parsed.profileName ? { profileName: parsed.profileName } : {}), testSeconds: parsed.noRunnerTest ? 0 : 240 },
        say,
        toolsets,
      );
      if (!parsed.noRunnerTest && !brain.tested) throw new InitError('The Hermes container did not answer for the Brain profile.');
    }
    if (!brainOnly) {
      say(`Sign in at the install's address with ${parsed.email}.`);
    }
    return 0;
  } catch (err) {
    if (err instanceof InitError) {
      io.err(err.message);
      return err.exitCode;
    }
    io.err(`admin failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
