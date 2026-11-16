import { createHash } from 'node:crypto';
import { posix } from 'node:path';

// One Unix user per team on an enrolled server (PLAN P26-22, docs/plans/agents-anywhere.md section 9b). Shared by the two sides of the one door between them:
//
//   the bridge (user `manythreads-bridge`)  --sudo-->  the helper (root, `team-helper.ts`)  --setpriv-->  the team's own process (`mt-team-<team>`)
//
// This file holds what both sides must agree on and must check the same way: the slug, the user's name, the folders, the header the bridge sends (the run's environment and the files the
// run needs, on the helper's standard input, never in an argument), and the environment allowlist. It has no side effect, so the unit tests run it as it is.

/** A team or bot slug as it may become a folder name and a user name: lower case, digits, single dashes; no dot, no slash, no `--`; at most 63 characters. */
export const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}$/;

export const isSlug = (v: unknown): v is string => typeof v === 'string' && SLUG.test(v);

/** The first part of every team user's name. The sudoers rule and the uninstall name this prefix. */
export const TEAM_USER_PREFIX = 'mt-team-';
/** The group of the agents' sign-in folders: every team user is in it, and so is the bridge's user. */
export const AGENTS_GROUP = 'mt-agents';
/** A Linux user name is at most 32 characters; the longest slug that fits whole after the prefix. */
const MAX_NAME = 32;

/**
 * The user a team's runs use: `mt-team-<slug>`. A slug too long to fit in 32 characters is cut and given eight characters of its own hash, so two long slugs that start alike still get
 * two users. The name is made from the slug only: a team keeps its user for as long as the slug lives.
 */
export function teamUserName(team: string): string {
  if (!isSlug(team)) throw new Error('not a team slug');
  if (TEAM_USER_PREFIX.length + team.length <= MAX_NAME) return `${TEAM_USER_PREFIX}${team}`;
  const keep = MAX_NAME - TEAM_USER_PREFIX.length - 9;
  const hash = createHash('sha256').update(team).digest('hex').slice(0, 8);
  return `${TEAM_USER_PREFIX}${team.slice(0, keep).replace(/-+$/, '')}-${hash}`;
}

/** Whether a name is one the helper makes (what `getent passwd` is searched for at start-up and in the uninstall). */
export const isTeamUserName = (name: string): boolean => /^mt-team-[a-z0-9][a-z0-9-]{0,23}$/.test(name);

/** The team's home: its work folder, `<root>/work/<team>`. The folders under it are the same as before teams had users: `<bot>`, `repos`; the helper adds `kube`, `hermes`, `tmp`, `.sync`. */
export const teamHome = (root: string, team: string): string => posix.join(root, 'work', team);

/** The per-run kubeconfig of one bot, inside the team's home (deleted when the run ends). */
export const teamKubeconfigFile = (root: string, team: string, bot: string, run: string): string => posix.join(teamHome(root, team), 'kube', bot, run, 'config');
/** Hermes' home of one bot, inside the team's home. */
export const teamHermesHome = (root: string, team: string, bot: string): string => posix.join(teamHome(root, team), 'hermes', bot);

/** What the helper starts as the team's user. `claude`, `codex` and `hermes` are the adapters (the helper's own table says which program); `sync` is the repository sync; `clean-kube` empties the team's kube folder. */
export const KINDS = ['claude', 'codex', 'hermes', 'sync', 'clean-kube'] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** The two commands the sudoers rule allows, as they are written after the helper's path. Nothing else. */
export const HELPER_COMMANDS = ['ensure-user', 'run'] as const;

/** The arguments after `sudo -n --`: the helper's path, the command and its words. */
export function helperArgv(helper: string, command: 'ensure-user', team: string): string[];
export function helperArgv(helper: string, command: 'run', team: string, kind: Kind): string[];
export function helperArgv(helper: string, command: 'ensure-user' | 'run', team: string, kind?: Kind): string[] {
  if (!isSlug(team)) throw new Error('not a team slug');
  if (command === 'ensure-user') return [helper, 'ensure-user', team];
  if (kind === undefined || !isKind(kind)) throw new Error('not a kind of run');
  return [helper, 'run', team, kind];
}

// ---- what the bridge sends on the helper's standard input (first line), and what the helper accepts ---------------------------------------------------------------------------

export interface LaunchFile {
  /** Absolute, inside the team's home. */
  path: string;
  text: string;
  /** Octal, three or four digits: `0600`. */
  mode: string;
}

export interface LaunchHeader {
  v: 1;
  /** The folder the program starts in; made (as the team's user) when it is missing. Inside the team's home. */
  cwd: string;
  /** The run's environment: only the names of ENV_ALLOW (and for `sync`, SYNC_ENV) are taken. */
  env: Record<string, string>;
  /** Files written as the team's user before the program starts (a kubeconfig, Hermes' config, the sync list). */
  files: LaunchFile[];
  /** Paths removed as the team's user when the program ends, whatever way it ended. */
  removeAtEnd: string[];
}

export const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 16;
const MAX_ENV = 64;
const MAX_VALUE = 64 * 1024;

/**
 * The environment names a team's program may be given. Everything else the bridge's own environment holds (and anything a profile's `env` adds that is not here) is dropped: the helper is
 * the door, and it opens for this list only. The home, the user's names, the shell and the temporary folder are the helper's own, never taken from the header.
 */
export const ENV_ALLOW = /^(PATH|LANG|LC_[A-Z_]+|TERM|TZ|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|DISABLE_AUTOUPDATER|NODE_ENV|CLAUDE_CONFIG_DIR|CLAUDE_CODE_EXECUTABLE|CODEX_HOME|CODEX_PATH|INITIAL_AGENT_MODE|HERMES_HOME|KUBECONFIG|PLAYWRIGHT_BROWSERS_PATH|MT_PUBLISH_SOCKET|MANYTHREADS_RUN_TOKEN|MANYTHREADS_LLM_URL|MANYTHREADS_LLM_MODEL)$/;
/** What only the repository sync is given (it runs the pod's `repo-sync.sh`, which reads these). */
export const SYNC_ENV = /^(PATH|LANG|LC_[A-Z_]+|REPO_SYNC_LIST|REPO_SYNC_FALLBACK|REPO_SYNC_WORK|REPO_SYNC_SCRATCH|REPO_SYNC_INTERVAL)$/;
/** The names the helper sets itself, whatever the header says. */
export const FORCED_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An absolute, normalised path with no NUL, no `..` and no trailing slash: what a path in a header must look like before it is compared with a folder. */
export function plainPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 1 && p.length <= 1024 && posix.isAbsolute(p) && !p.includes('\0') && posix.normalize(p) === p && !p.endsWith('/') && !p.split('/').includes('..');
}

/** Whether `p` is strictly inside `folder` (never the folder itself, never a sibling that merely starts with the same letters). */
export const isInside = (folder: string, p: string): boolean => p.startsWith(`${folder}/`) && p.length > folder.length + 1;

export interface HeaderContext {
  /** `<dataRoot>`: where the sign-in folders (`auth/claude`, `auth/codex`) and the shared `work` folder are. */
  root: string;
  team: string;
  kind: Kind;
}

export type HeaderResult = { ok: true; header: LaunchHeader; dropped: string[] } | { ok: false; error: string };

/**
 * The header as the helper takes it, or the plain sentence why not. Nothing in it is trusted: every path must lie in the team's home, the sign-in variables must name the machine's own
 * sign-in folders, an environment name outside the allowlist is dropped (and listed in `dropped`, by name only: a value may be a token).
 */
export function parseHeader(line: string, ctx: HeaderContext): HeaderResult {
  if (Buffer.byteLength(line) > MAX_HEADER_BYTES) return { ok: false, error: 'the header is too long' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: 'the first line is not JSON' };
  }
  if (!isRecord(raw) || raw['v'] !== 1) return { ok: false, error: 'the header has the wrong version' };
  const home = teamHome(ctx.root, ctx.team);
  const cwd = raw['cwd'];
  if (!plainPath(cwd) || !(cwd === home || isInside(home, cwd))) return { ok: false, error: 'the working folder is not inside the team\'s home' };
  const envRaw = raw['env'];
  if (!isRecord(envRaw) || Object.keys(envRaw).length > MAX_ENV) return { ok: false, error: 'the environment is not a small object' };
  const allow = ctx.kind === 'sync' ? SYNC_ENV : ENV_ALLOW;
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(envRaw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > MAX_VALUE || v.includes('\0')) return { ok: false, error: `the environment value ${k.slice(0, 40)} is not plain text` };
    if (!allow.test(k) || (FORCED_ENV as readonly string[]).includes(k)) dropped.push(k);
    else env[k] = v;
  }
  // where the variables that name a folder may point: the sign-in folders of this machine, and the team's own home
  const sign = { CLAUDE_CONFIG_DIR: `${ctx.root}/auth/claude`, CODEX_HOME: `${ctx.root}/auth/codex` } as const;
  for (const [k, want] of Object.entries(sign)) if (env[k] !== undefined && env[k] !== want) return { ok: false, error: `${k} must be ${want}` };
  for (const k of ['KUBECONFIG', 'HERMES_HOME', 'REPO_SYNC_LIST', 'REPO_SYNC_FALLBACK', 'REPO_SYNC_SCRATCH']) {
    const v = env[k];
    if (v !== undefined && !(plainPath(v) && isInside(home, v))) return { ok: false, error: `${k} must be inside the team's home` };
  }
  if (env['REPO_SYNC_WORK'] !== undefined && env['REPO_SYNC_WORK'] !== `${ctx.root}/work`) return { ok: false, error: `REPO_SYNC_WORK must be ${ctx.root}/work` };
  const interval = env['REPO_SYNC_INTERVAL'];
  if (interval !== undefined && !/^[0-9]{1,4}$/.test(interval)) return { ok: false, error: 'REPO_SYNC_INTERVAL must be a number of seconds' };
  const filesRaw = raw['files'] ?? [];
  if (!Array.isArray(filesRaw) || filesRaw.length > MAX_FILES) return { ok: false, error: 'files must be a short list' };
  const files: LaunchFile[] = [];
  for (const f of filesRaw) {
    if (!isRecord(f) || !plainPath(f['path']) || !isInside(home, f['path']) || typeof f['text'] !== 'string' || typeof f['mode'] !== 'string' || !/^0[0-7]{3}$/.test(f['mode'])) return { ok: false, error: 'a file entry is not a path inside the team\'s home, text and an octal mode' };
    files.push({ path: f['path'], text: f['text'], mode: f['mode'] });
  }
  const removeRaw = raw['removeAtEnd'] ?? [];
  if (!Array.isArray(removeRaw) || removeRaw.length > MAX_FILES || removeRaw.some((p) => !plainPath(p) || !isInside(home, p))) return { ok: false, error: 'removeAtEnd must be a short list of paths inside the team\'s home' };
  return { ok: true, header: { v: 1, cwd, env, files, removeAtEnd: removeRaw as string[] }, dropped };
}

/** The header the bridge writes as the first line of the helper's standard input. The names the helper would drop are dropped here already, so the helper's list of `dropped` is empty in a healthy run. */
export function buildHeader(input: { cwd: string; env: NodeJS.ProcessEnv; files?: LaunchFile[]; removeAtEnd?: string[]; kind: Kind }): string {
  const allow = input.kind === 'sync' ? SYNC_ENV : ENV_ALLOW;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (v !== undefined && allow.test(k)) env[k] = v;
  const header: LaunchHeader = { v: 1, cwd: input.cwd, env, files: input.files ?? [], removeAtEnd: input.removeAtEnd ?? [] };
  return JSON.stringify(header);
}

/** What the helper adds to the program's environment: the team user's own names. `PATH` falls back to a plain one when the header has none. */
export function launchEnv(header: LaunchHeader, user: string, home: string, shell: string): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    ...header.env,
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: shell,
    TMPDIR: posix.join(home, 'tmp'),
  };
}
