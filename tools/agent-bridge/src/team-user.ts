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
/**
 * The team's Codex home (`CODEX_HOME`), inside the team's home and the team user's alone (0700): its `installation_id`, sessions, state and, while a Codex run lasts, its copy of the
 * machine's sign-in (P31-01). Codex's own default would be the same folder (`$HOME/.codex`).
 */
export const teamCodexHome = (root: string, team: string): string => posix.join(teamHome(root, team), '.codex');
/** Hermes' home of one bot, inside the team's home. */
export const teamHermesHome = (root: string, team: string, bot: string): string => posix.join(teamHome(root, team), 'hermes', bot);
/**
 * The folder of a team's OWN sign-ins on a runner where each team signs in (P35-10b, docs/plans/per-team-sign-in.md sections 4 and 7): `<home>/.signin`, made by the helper as the team
 * user with mode 0700 and no setgid bit (a team home may be 2750 for the publisher, so a folder made there would otherwise take the publisher's group). Nothing is copied in or out of it.
 */
export const teamSigninRoot = (root: string, team: string): string => posix.join(teamHome(root, team), '.signin');
/** The team's own Claude (`CLAUDE_CONFIG_DIR`) or Codex (`CODEX_HOME`) sign-in folder. */
export const teamSigninDir = (root: string, team: string, agent: 'claude' | 'codex'): string => posix.join(teamSigninRoot(root, team), agent);

/**
 * What the helper starts as the team's user. `claude`, `codex` and `hermes` are the adapters (the helper's own table says which program); `sync` is the repository sync; `clean-kube`
 * empties the team's kube folder; `clean-codex` removes the team's copy of the Codex sign-in (at bridge start and after a sign-out). The `clean-*` kinds start no program.
 *
 * The sign-in kinds of a team's own sign-in (P35-10b): `claude-login` and `claude-logout` start Claude's own terminal sign-in or sign-out under a terminal the HELPER makes (`script`, as
 * the team user), so the header line is read from the pipe before any terminal exists and never shows on one; `codex-key` signs Codex in with an API key that comes on the pipe after
 * the header (never in the environment); `codex-logout` is Codex's own sign-out; `clean-signin` removes one of the team's own sign-in folders. The programs are fixed by the helper's
 * table and the kind: the bridge chooses no argument. Codex's device-code sign-in needs no terminal: it goes through the adapter (`codex`), as a run does. `signin-facts` reads the team's
 * own sign-in file as the team user and prints only its dates (never a token), so the bridge can hold one renewing run of that team at a time.
 */
export const KINDS = ['claude', 'codex', 'hermes', 'sync', 'clean-kube', 'clean-codex', 'claude-login', 'claude-logout', 'codex-key', 'codex-logout', 'clean-signin', 'signin-facts'] as const;
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
  /**
   * `per_team`: this run is of a runner where each team signs in (P35-10b), so its Claude or Codex home must be the team's own `.signin/<agent>` and the machine's shared folders are refused.
   * Absent: one sign-in for all teams, and a team's own folder is refused for a run. The bridge chooses it; a leftover `.signin` folder never decides it.
   */
  signIn?: 'per_team' | undefined;
  /**
   * The run's own short name (P31-04): on a server where the helper starts each run in a systemd scope of its own, the scope is `mt-run-<team user>-<runTag>.scope` in
   * `mtruns.slice`, so the bridge knows where the run's memory and its out-of-memory count are. Lower case letters and digits, 8 to 32. Absent: the helper picks one.
   */
  runTag?: string | undefined;
}

/** A run's tag as the header may carry it: lower case letters and digits, 8 to 32 (it becomes part of a systemd unit name). */
export const RUN_TAG = /^[a-z0-9]{8,32}$/;
export const isRunTag = (v: unknown): v is string => typeof v === 'string' && RUN_TAG.test(v);

/** The slice every run's scope sits in (P31-04): its own `MemoryMax` (a share of the machine) keeps all runs together from taking the live site's memory. */
export const RUNS_SLICE = 'mtruns.slice';
/** The systemd unit of one run's scope: `mt-run-<team user>-<tag>.scope`. Built from the slug and the tag only, both checked here. */
export function runScopeUnit(team: string, tag: string): string {
  if (!isRunTag(tag)) throw new Error('not a run tag');
  return `mt-run-${teamUserName(team)}-${tag}.scope`;
}
/** The cgroup v2 folder of a run's scope, where the bridge reads `memory.events` (its `oom_kill`) and `memory.max`. */
export const runScopeCgroupDir = (team: string, tag: string): string => posix.join('/sys/fs/cgroup', RUNS_SLICE, runScopeUnit(team, tag));

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

/** The kinds that act only on the team's own sign-in folder (never on a shared one). */
const OWN_KINDS: readonly Kind[] = ['claude-login', 'claude-logout', 'codex-key', 'codex-logout', 'clean-signin', 'signin-facts'];
/** The kinds that may name a Codex home at all. */
const CODEX_HOME_KINDS: readonly Kind[] = ['codex', 'codex-key', 'codex-logout', 'clean-signin', 'signin-facts'];

/** Whether `p` is the team's `.signin` folder or anything inside it: no file is written there and nothing there is removed at the end of a run (only `clean-signin` removes it). */
export const touchesSignin = (root: string, team: string, p: string): boolean => {
  const signin = teamSigninRoot(root, team);
  return p === signin || isInside(signin, p);
};

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
  // where the variables that name a folder may point (P31-01, P35-10b): Claude's shared sign-in folder of this machine, or the team's own `.signin/claude`; Codex's home only for a Codex
  // kind, and only the team's own (its copy-in home, or its own `.signin/codex`). The machine's Codex sign-in is the bridge user's and no team reads it. Which of the two the header says
  // (`signIn`) decides which folder a run may name; the sign-in kinds name the team's own folder only.
  const signIn = raw['signIn'];
  if (signIn !== undefined && signIn !== 'per_team') return { ok: false, error: 'signIn must be per_team or left out' };
  const perTeam = signIn === 'per_team';
  const own = OWN_KINDS.includes(ctx.kind);
  const claudeDir = `${ctx.root}/auth/claude`;
  const ownClaude = teamSigninDir(ctx.root, ctx.team, 'claude');
  const ownCodex = teamSigninDir(ctx.root, ctx.team, 'codex');
  const claude = env['CLAUDE_CONFIG_DIR'];
  const codex = env['CODEX_HOME'];
  if (claude !== undefined) {
    if (claude !== claudeDir && claude !== ownClaude) return { ok: false, error: `CLAUDE_CONFIG_DIR must be ${claudeDir} or ${ownClaude}` };
    if (claude === claudeDir && (perTeam || own)) return { ok: false, error: `this team signs in to Claude on its own: CLAUDE_CONFIG_DIR must be ${ownClaude}` };
    if (claude === ownClaude && !own && !(ctx.kind === 'claude' && perTeam)) return { ok: false, error: `this team has one Claude sign-in shared by all teams: CLAUDE_CONFIG_DIR must be ${claudeDir}` };
  }
  if (codex !== undefined) {
    const codexHome = teamCodexHome(ctx.root, ctx.team);
    if (!CODEX_HOME_KINDS.includes(ctx.kind)) return { ok: false, error: 'CODEX_HOME is only for a Codex run' };
    if (codex !== codexHome && codex !== ownCodex) return { ok: false, error: `CODEX_HOME must be ${codexHome} or ${ownCodex}` };
    if (codex === codexHome && (perTeam || ctx.kind !== 'codex')) return { ok: false, error: `CODEX_HOME must be ${ownCodex}` };
    if (codex === ownCodex && !own && !perTeam) return { ok: false, error: `this team has one Codex sign-in shared by all teams: CODEX_HOME must be ${codexHome}` };
  }
  // the sign-in kinds act on the team's own folder and on nothing else (any folder variable they carry is the team's own: checked above)
  if ((ctx.kind === 'claude-login' || ctx.kind === 'claude-logout') && claude !== ownClaude) return { ok: false, error: `${ctx.kind} needs CLAUDE_CONFIG_DIR ${ownClaude}` };
  if ((ctx.kind === 'codex-key' || ctx.kind === 'codex-logout') && codex !== ownCodex) return { ok: false, error: `${ctx.kind} needs CODEX_HOME ${ownCodex}` };
  if ((ctx.kind === 'clean-signin' || ctx.kind === 'signin-facts') && (claude === undefined) === (codex === undefined)) return { ok: false, error: `${ctx.kind} names exactly one of the team's own sign-in folders` };
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
    if (touchesSignin(ctx.root, ctx.team, f['path'])) return { ok: false, error: 'no file is written into the team\'s own sign-in folder' };
    files.push({ path: f['path'], text: f['text'], mode: f['mode'] });
  }
  const removeRaw = raw['removeAtEnd'] ?? [];
  if (!Array.isArray(removeRaw) || removeRaw.length > MAX_FILES || removeRaw.some((p) => !plainPath(p) || !isInside(home, p))) return { ok: false, error: 'removeAtEnd must be a short list of paths inside the team\'s home' };
  if (removeRaw.some((p) => touchesSignin(ctx.root, ctx.team, p as string))) return { ok: false, error: 'the team\'s own sign-in folder is not removed at the end of a run' };
  const runTag = raw['runTag'];
  if (runTag !== undefined && !isRunTag(runTag)) return { ok: false, error: 'runTag must be 8 to 32 lower case letters and digits' };
  return { ok: true, header: { v: 1, cwd, env, files, removeAtEnd: removeRaw as string[], ...(perTeam ? { signIn: 'per_team' as const } : {}), ...(runTag !== undefined ? { runTag } : {}) }, dropped };
}

/** The header the bridge writes as the first line of the helper's standard input. The names the helper would drop are dropped here already, so the helper's list of `dropped` is empty in a healthy run. */
export function buildHeader(input: { cwd: string; env: NodeJS.ProcessEnv; files?: LaunchFile[]; removeAtEnd?: string[]; kind: Kind; signIn?: 'per_team' | undefined; runTag?: string | undefined }): string {
  const allow = input.kind === 'sync' ? SYNC_ENV : ENV_ALLOW;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (v !== undefined && allow.test(k)) env[k] = v;
  const header: LaunchHeader = { v: 1, cwd: input.cwd, env, files: input.files ?? [], removeAtEnd: input.removeAtEnd ?? [], ...(input.signIn !== undefined ? { signIn: input.signIn } : {}), ...(input.runTag !== undefined ? { runTag: input.runTag } : {}) };
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
