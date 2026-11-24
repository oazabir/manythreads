import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeConfig, SigninAgentKey } from './config.ts';
import { profileFor, serverSigninScope, serverSigninUnreadable } from './config.ts';
import { AuthRefused, AuthService, cleanSecret, type AuthServiceOptions, type AuthTarget, type TeamOfTarget } from './acp/auth.ts';
import { parseRepoList, writeRepoList } from './repos.ts';
import { parseRunRequest } from './request.ts';
import { flavorOf } from './acp/adapter.ts';
import { cleanTeamCodex, cleanTeamSignin, hasTeamUsers, teamsOnMachine } from './server-team.ts';
import { ownSigninTeams, saveSigninScope } from './signin-scope.ts';
import { isSlug, teamSigninDir } from './team-user.ts';
import { IdempotencyConflict, RunManager, TooManyRuns, UnknownProfile, type Run } from './runs.ts';
import { SessionStore } from './sessions.ts';
import { SigninGate } from './signin.ts';

// The HTTP face: the subset of the Hermes gateway run API that the manythreads server uses.
//
//   GET  /health
//   POST /p/<profile>/v1/runs               { input, session_id?, instructions?, manythreads? }  -> 202 { run_id, status }
//   GET  /p/<profile>/v1/runs/<id>          -> { run_id, status, output, usage, error }
//   GET  /p/<profile>/v1/runs/<id>/events   server-sent events, resumable with ?last_seq= or Last-Event-ID
//   POST /p/<profile>/v1/runs/<id>/stop
//   POST /p/<profile>/v1/runs/<id>/approval { choice: "once" | "session" | "deny", request_id? }   answers an `approval.request` frame (ACP runs); 404 when nothing waits
//   POST /p/<profile>/v1/runs/<id>/steer    { input }                                         a person's note for the agent (ACP runs); 409 when the agent cannot take one
//   GET  /v1/auth/status?agent=claude-code|codex           the agent's sign-in: state, the ways to sign in, a sign-in under way (also /p/<profile>/v1/auth/status)
//   POST /v1/auth/login          { methodId }                -> { attempt }   starts a sign-in; the attempt says what the person must do (open a page, enter or paste a code, give a key)
//   POST /v1/auth/login/answer   { attemptId, code? | apiKey? }  the pasted code or the key; never stored or logged
//   POST /v1/auth/login/cancel   { attemptId? }
//   POST /v1/auth/logout                                     -> { auth }   signs the agent out (the adapter's own logout, or its program's `auth logout`)
//        (every /v1/auth route takes `?team=<slug>` on an enrolled server where each team signs in: that team's own sign-in, done as the team user; P35-10b)
//   POST /v1/signin/scope?agent=claude-code|codex  { scope: "shared" | "per_team", teams: [slug] }  -> { scope, signedOut }   who signs this server's agent in: the old sign-ins are
//        signed out for real first (to per team: the one shared sign-in; to shared: each listed team's own), then each team's own folder is removed as the team user, then the choice is kept
//   PUT  /internal/repos                    { repos: [{ team, bot, project, branch, origin }] }  -> { ok, count }   (only with `reposFile`, a pod's repo list; see repos.ts)
//
// Every request carries `Authorization: Bearer <key>`.

export interface BridgeOptions {
  /**
   * After the Codex sign-in was removed here (P31-01b): what removes each team's copy of it. The default asks the root helper (`clean-codex`) for every team
   * that has a user on this server; tests pass their own.
   */
  afterCodexSignOut?: () => Promise<void>;
  config: BridgeConfig;
  apiKey: string;
  stateDir: string;
  /** Default 127.0.0.1:8650; port 0 picks a free one. */
  host?: string;
  port?: number;
  /** Listen on this Unix socket instead of a TCP port (an enrolled server: the tunnel hands the site's requests to it; the bridge opens no port). Mode 0600. */
  socketPath?: string;
  log?: (line: string) => void;
  tmpRoot?: string;
  /** Seconds-level knobs, mostly for tests. Defaults: 10 s for the request headers, 30 s for a request body, 30 failed sign-ins a minute per address. */
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  authFailLimit?: number;
  /** The folder that holds the Claude sign-in file (`CLAUDE_CONFIG_DIR`). Given, the bridge keeps one process renewing it and answers `POST /v1/signin/check`. */
  claudeConfigDir?: string;
  /** The folder that holds the Codex sign-in file (`CODEX_HOME`, with `auth.json`). Given, the bridge keeps one process renewing it too (P19-13). */
  codexHome?: string;
  /** The file the pod's repo-sync step reads (`PUT /internal/repos` rewrites it). Not given: that route answers 404. */
  reposFile?: string;
  /** An enrolled server (server mode): the site's address, so each run's profile can ask it who the run is (server-run.ts). */
  siteUrl?: string;
  /** Test hook: replaces the drivers by agent name. */
  drivers?: import('./runs.ts').RunManagerOptions['drivers'];
  /** Test hook: the `fetch` the per-run questions to the site go through. */
  siteFetch?: typeof fetch;
  /** Test hook: the sign-in service's waits (P25-09). */
  auth?: Partial<Omit<AuthServiceOptions, 'config' | 'log'>>;
  /** Where the bridge keeps who signs its agents in (an enrolled server: `<state>/signin-scope.json`). Absent: the choice lives in memory only (tests). */
  signinScopeFile?: string;
  /** Test hooks for a scope switch: the teams with a user on this machine, and the removal of one team's own sign-in folder (default: the passwd file and the helper's `clean-signin`). */
  teamsHere?: () => string[];
  cleanSignin?: (team: string, agent: SigninAgentKey) => Promise<boolean>;
  /** Test hook: what a team's own sign-in file says about its dates (the run gate's `signin-facts`). */
  teamFacts?: import('./runs.ts').RunManagerOptions['teamFacts'];
}

/** The plain sentences of a team's own sign-in on a server (P35-10b). */
export const SCOPE_WORDS = {
  oneUser: 'This server runs every team as one user, so a team cannot have a sign-in of its own here. Install the bridge again with team users to choose this.',
  oneSignIn: 'This server has one sign-in for all teams, so no team is chosen here.',
  teamNeeded: 'Each team signs in on its own on this server. Choose the team to sign in.',
  notChecked: (who: string) => `${who} could not be checked, so nothing was changed. Try again in a moment.`,
  notOut: (who: string) => `${who} could not be signed out, so nothing was changed. Try again in a moment.`,
  notSaved: 'The choice could not be written on this server, so it was not changed. Check the bridge\'s state folder, then try again.',
  agentMissing: (tool: string) => `This server does not run ${tool}. Install it with the bridge installer's --update, or remove this runner.`,
  stopped: 'Who signs in to this agent changed, so this run stopped. Run it again once its sign-in is ready.',
} as const;

export interface Bridge {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const KEEPALIVE_MS = 15_000;

class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function keyMatches(presented: string | undefined, key: string): boolean {
  const m = /^Bearer (.+)$/.exec(presented ?? '');
  // Both sides are hashed first so the comparison takes the same time whatever the lengths.
  const ok = timingSafeEqual(digest(m?.[1] ?? ''), digest(key));
  return ok && m !== null;
}

async function readBody(req: IncomingMessage, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeout()), timeoutMs);
  });
  const read = (async (): Promise<void> => {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(buf);
    }
  })();
  read.catch(() => undefined); // when the timeout wins, the late outcome of the read is ignored
  try {
    await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, message: string, code: string, headers: Record<string, string> = {}): void =>
  send(res, status, { error: { message, code } }, headers);

/** The request body as a JSON object, or null after the answer (413, 408, 400) has been sent. */
async function readJsonObject(req: IncomingMessage, res: ServerResponse, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, timeoutMs);
  } catch (err) {
    if (err instanceof BodyTooLarge) fail(res, 413, 'the request body is over 1 MB', 'too_large', { connection: 'close' });
    else if (err instanceof BodyTimeout) fail(res, 408, 'the request body took too long', 'request_timeout', { connection: 'close' });
    else throw err;
    return null;
  }
  let body: unknown;
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    fail(res, 400, 'the body is not JSON', 'bad_request');
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(res, 400, 'the body must be a JSON object', 'bad_request');
    return null;
  }
  return body as Record<string, unknown>;
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  if (options.apiKey.length < 16) throw new Error('the API key must be at least 16 characters');
  const log = options.log ?? ((line: string) => console.log(line));
  const sessions = new SessionStore(options.stateDir);
  const gate = options.claudeConfigDir !== undefined && options.claudeConfigDir !== '' ? new SigninGate(options.claudeConfigDir) : undefined;
  const codexGate = options.codexHome !== undefined && options.codexHome !== '' ? new SigninGate(options.codexHome, Date.now, 'codex') : undefined;
  const manager = new RunManager({
    config: options.config,
    sessions,
    log,
    ...(options.tmpRoot !== undefined ? { tmpRoot: options.tmpRoot } : {}),
    ...(gate ? { gate } : {}),
    ...(codexGate ? { codexGate } : {}),
    ...(options.drivers ? { drivers: options.drivers } : {}),
    ...(options.teamFacts ? { teamFacts: options.teamFacts } : {}),
    ...(options.siteUrl !== undefined ? { serverRun: { siteUrl: options.siteUrl, ...(options.siteFetch ? { fetch: options.siteFetch } : {}) } } : {}),
  });

  const authService = new AuthService({
    config: options.config,
    log,
    // a team's own sign-in that changed: its runs no longer remember an old refusal
    onSignedChange: (target: AuthTarget) => {
      const server = options.config.server;
      if (target.team === undefined || server === undefined || (target.profile.agent !== 'claude-code' && target.profile.agent !== 'codex')) return;
      manager.forgetTeamGate(target.profile.agent, teamSigninDir(server.root, target.team.slug, target.profile.agent === 'codex' ? 'codex' : 'claude'));
    },
    ...(options.auth ?? {}),
  });
  // what a run of a team that signs in on its own asks first (runs.ts)
  manager.setTeamSignin(async (agent, team) => {
    const server = options.config.server;
    if (!hasTeamUsers(server)) return 'unknown';
    const target = authService.resolve(undefined, agent === 'codex' ? 'codex' : 'claude-code', { slug: team, server });
    return target === null ? 'unknown' : authService.knownState(target);
  });
  const agentKeyOf = (agent: string): SigninAgentKey | null => (agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : null);

  /** Today's sign-out of the one shared sign-in: the adapter's, then (Codex) every live run stops and every team's copy of it goes (P31-01b). */
  async function signOutShared(chosen: AuthTarget): Promise<Awaited<ReturnType<AuthService['logout']>>> {
    const auth = await authService.logout(chosen);
    // the Codex sign-in is gone: no run goes on with its copy, and no team keeps one (P31-01b). Claude has one folder per profile and no copies.
    if (flavorOf(chosen.profile.agent) === 'codex') {
      const stopped = manager.stopAgent('codex', 'The Codex sign-in was removed, so this run stopped. Sign in again on the Runners page.');
      if (stopped > 0) log(`codex sign-out: ${stopped} live run(s) stopped`);
      const server = options.config.server;
      const clean = options.afterCodexSignOut ?? (hasTeamUsers(server) && server.agents.codex !== undefined ? () => cleanTeamCodex(server, log) : undefined);
      await clean?.().catch((err: unknown) => log(`codex sign-out: the teams' copies could not all be removed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return auth;
  }

  const scopeBusy = new Set<SigninAgentKey>();
  const teamsWithUser = (): string[] => {
    const server = options.config.server;
    try {
      return options.teamsHere?.() ?? (server === undefined ? [] : teamsOnMachine(server.root, readFileSync('/etc/passwd', 'utf8')));
    } catch {
      return [];
    }
  };
  /**
   * Who signs one agent of this server in (P35-10b). Signed out for real first, so no copy a full-access team may hold stays valid: to per team, the one shared sign-in (today's
   * sign-out); to shared, the own sign-in of every listed team and every team this bridge ever signed in on its own, each as the team user, then every such team's own folder
   * (`clean-signin`, as the team user). Only teams that already have a user here are asked: no user is made for a team that never ran. The same choice again does the same work (a
   * folder left behind by an earlier switch is cleaned). The choice is written to disk first, then kept in memory; then the agent's runs stop.
   * A team that could not be signed out or cleaned leaves the old choice in place, and the answer says honestly which teams were signed out and which were not (`partial`).
   */
  async function switchScope(agentName: 'claude-code' | 'codex', key: SigninAgentKey, scope: 'shared' | 'per_team', teams: readonly string[]): Promise<{ status: number; body: unknown }> {
    const server = options.config.server;
    const tool = key === 'codex' ? 'Codex' : 'Claude Code';
    const outIfIn = async (target: AuthTarget, who: string, shared: boolean): Promise<number> => {
      const now = await authService.status(target);
      if (now.state === 'signed_out' || now.state === 'not_needed') return 0;
      if (now.state !== 'signed_in') throw new AuthRefused(502, 'not_checked', SCOPE_WORDS.notChecked(who));
      try {
        const after = shared ? await signOutShared(target) : await authService.logout(target);
        if (after.state === 'signed_in') throw new Error('still signed in');
      } catch {
        throw new AuthRefused(502, 'sign_out_failed', SCOPE_WORDS.notOut(who));
      }
      return 1;
    };
    let signedOut = 0;
    const signedOutTeams: string[] = [];
    const notSignedOut: string[] = [];
    const notCleaned: string[] = [];
    const cleaned: string[] = [];
    if (scope === 'per_team') {
      const shared = authService.resolve(undefined, agentName);
      if (shared !== null) signedOut += await outIfIn(shared, `The one ${tool} sign-in of this server`, true);
    } else if (hasTeamUsers(server)) {
      const here = teamsWithUser();
      const asked = [...new Set([...teams, ...ownSigninTeams(options.config, key)])].filter((t) => here.includes(t)).sort();
      for (const team of asked) {
        const target = authService.resolve(undefined, agentName, { slug: team, server });
        if (target === null) continue;
        try {
          if ((await outIfIn(target, `Team ${team}`, false)) > 0) {
            signedOut += 1;
            signedOutTeams.push(team);
          }
        } catch {
          notSignedOut.push(team);
        }
      }
      if (notSignedOut.length === 0) {
        const clean = options.cleanSignin ?? ((t: string, a: SigninAgentKey) => cleanTeamSignin(server, t, a));
        for (const team of here) {
          if (await clean(team, key)) cleaned.push(team);
          else notCleaned.push(team);
        }
      }
    }
    const changed = notSignedOut.length === 0 && notCleaned.length === 0;
    const removeOwn = cleaned.filter((t) => ownSigninTeams(options.config, key).includes(t));
    try {
      saveSigninScope(options.config, options.signinScopeFile, { agent: key, ...(changed ? { scope } : {}), removeOwn });
    } catch {
      if (changed) throw new AuthRefused(500, 'not_saved', SCOPE_WORDS.notSaved);
    }
    authService.forgetAll();
    // runs stop whatever came of it: a team signed out here must not go on with what its run read before
    const stopped = manager.stopAgent(key, SCOPE_WORDS.stopped);
    if (stopped > 0) log(`${key} sign-in scope: ${stopped} live run(s) stopped`);
    log(`${key} sign-in scope: ${changed ? scope : `still ${serverSigninScope(options.config, key)} (${notSignedOut.length} not signed out, ${notCleaned.length} not cleaned)`}`);
    return { status: 200, body: { scope: serverSigninScope(options.config, key), signedOut, signedOutTeams, notSignedOut, notCleaned } };
  }

  /** A team named by a per-team sign-in call may have a sign-in folder of its own from now on: kept in the list a switch back cleans (not while the kept choice is unreadable). */
  const recordOwn = (key: SigninAgentKey, team: string): void => {
    if (serverSigninUnreadable(options.config) || ownSigninTeams(options.config, key).includes(team)) return;
    try {
      saveSigninScope(options.config, options.signinScopeFile, { agent: key, addOwn: [team] });
    } catch {
      log(`${key}: team ${team} could not be added to the kept list of own sign-ins`);
    }
  };

  // A pod holds one sign-in; a bridge started with both answers with the first that is not fine.
  const signinCheck = (): string => [gate?.check(), codexGate?.check()].find((r) => r !== undefined && r !== 'ok') ?? 'ok';

  const bodyTimeoutMs = options.bodyTimeoutMs ?? 30_000;
  const authFailLimit = options.authFailLimit ?? 30;
  // Failed sign-ins per remote address in the last minute (in memory; a restart forgets them).
  const failures = new Map<string, number[]>();
  const recentFailures = (addr: string): number[] => {
    const cutoff = Date.now() - 60_000;
    const list = (failures.get(addr) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) failures.delete(addr);
    else failures.set(addr, list);
    return list;
  };
  const sweepFailures = setInterval(() => {
    for (const addr of [...failures.keys()]) recentFailures(addr);
  }, 60_000);
  sweepFailures.unref();

  const status = (run: Run): Record<string, unknown> => ({ run_id: run.id, status: run.status, output: run.output, usage: run.usage, error: run.error });

  async function stream(req: IncomingMessage, res: ServerResponse, run: Run, url: URL): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': open\n\n');
    const raw = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('last_seq');
    let last: number | null = raw !== undefined && raw !== null && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null;
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    let wake: (() => void) | null = null;
    const poke = (): void => wake?.();
    run.subscribers.add(poke);
    try {
      while (!closed) {
        for (const f of run.framesAfter(last)) {
          res.write(`id: ${f.seq}\ndata: ${JSON.stringify(f.data)}\n\n`);
          last = f.seq;
        }
        if (run.status !== 'running' && last !== null && last >= run.nextSeq - 1) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, KEEPALIVE_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (!closed && run.framesAfter(last).length === 0 && run.status === 'running') res.write(': keepalive\n\n');
      }
      res.write(': stream closed\n\n');
      res.end();
    } finally {
      run.subscribers.delete(poke);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = req.socket.remoteAddress ?? 'unknown';
    if (recentFailures(addr).length >= authFailLimit) return fail(res, 429, 'too many failed sign-ins from this address', 'too_many_failures', { 'retry-after': '60', connection: 'close' });
    if (!keyMatches(req.headers['authorization'], options.apiKey)) {
      failures.set(addr, [...recentFailures(addr), Date.now()]);
      return fail(res, 401, 'missing or wrong API key', 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
    const url = new URL(req.url ?? '/', 'http://bridge');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/health' && method === 'GET') return send(res, 200, { status: 'ok', profiles: Object.keys(options.config.profiles), ...(gate || codexGate ? { signin: signinCheck() } : {}) });
    // The admin page's "check this sign-in" and the pod controller ask here. The answer is one word from a fixed list; nothing from the file.
    if (path === '/v1/signin/check' && method === 'POST') return gate || codexGate ? send(res, 200, { result: signinCheck() }) : fail(res, 404, 'this bridge has no sign-in', 'not_found');
    // The pod's controller sends the repository list here when a project changes; the bridge checks it and writes the file the repo-sync step reads.
    if (path === '/internal/repos') {
      if (options.reposFile === undefined || options.reposFile === '') return fail(res, 404, 'this bridge keeps no repository list', 'not_found');
      if (method !== 'PUT') return fail(res, 405, 'method not allowed', 'method_not_allowed', { allow: 'PUT' });
      let raw: string;
      try {
        raw = await readBody(req, bodyTimeoutMs);
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail(res, 413, 'the request body is over 1 MB', 'too_large', { connection: 'close' });
        if (err instanceof BodyTimeout) return fail(res, 408, 'the request body took too long', 'request_timeout', { connection: 'close' });
        throw err;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'the body is not JSON', 'bad_request');
      }
      const list = parseRepoList(body);
      if (!list.ok) return fail(res, 400, list.error, 'bad_request');
      writeRepoList(options.reposFile, list.repos);
      return send(res, 200, { ok: true, count: list.repos.length });
    }
    // The server's connection check asks `/v1/models` (or `/p/<profile>/v1/models`), as it would a Hermes gateway: one model per profile, named by its agent.
    const models = /^(?:\/p\/([^/]+))?\/v1\/models$/.exec(path);
    if (models && method === 'GET') {
      let named: string | undefined;
      try {
        named = models[1] === undefined ? undefined : decodeURIComponent(models[1]);
      } catch {
        return fail(res, 400, 'bad profile name', 'bad_request');
      }
      const chosen = named === undefined ? profileFor(options.config, 'default') : profileFor(options.config, named);
      if (!chosen) return fail(res, 404, 'no such profile and no default', 'profile_not_found');
      return send(res, 200, { object: 'list', data: [{ id: chosen.profile.agent, object: 'model', owned_by: 'agent-bridge' }] });
    }

    if (path === '/v1/signin/scope') {
      const server = options.config.server;
      if (server === undefined) return fail(res, 404, 'this bridge is not an enrolled server', 'not_found');
      if (method !== 'POST') return fail(res, 405, 'method not allowed', 'method_not_allowed', { allow: 'POST' });
      const agentName = url.searchParams.get('agent');
      const key = agentName === null ? null : agentKeyOf(agentName);
      if (key === null || (agentName !== 'claude-code' && agentName !== 'codex')) return fail(res, 400, '"agent" must be claude-code or codex', 'bad_request');
      if (server.agents[key] === undefined) return fail(res, 404, SCOPE_WORDS.agentMissing(key === 'codex' ? 'Codex' : 'Claude Code'), 'agent_missing');
      const body = await readJsonObject(req, res, bodyTimeoutMs);
      if (body === null) return;
      const scope = body['scope'];
      const teams = body['teams'] ?? [];
      if (scope !== 'shared' && scope !== 'per_team') return fail(res, 400, '"scope" must be shared or per_team', 'bad_request');
      if (!Array.isArray(teams) || teams.length > 500 || teams.some((t) => !isSlug(t))) return fail(res, 400, '"teams" must be a list of team slugs', 'bad_request');
      if (scope === 'per_team' && !hasTeamUsers(server)) return fail(res, 409, SCOPE_WORDS.oneUser, 'no_team_users');
      if (scopeBusy.has(key)) return fail(res, 409, 'Who signs in is being changed already. Wait for it to finish.', 'busy');
      scopeBusy.add(key);
      try {
        const out = await switchScope(agentName, key, scope, teams as string[]);
        return send(res, out.status, out.body);
      } catch (err) {
        if (err instanceof AuthRefused) return fail(res, err.status, err.message, err.code);
        throw err;
      } finally {
        scopeBusy.delete(key);
      }
    }

    // Sign-in and sign-out of the agent (P25-09). The sign-in belongs to the tool, so the profile is only a way to name the tool.
    const authRoute = /^(?:\/p\/([^/]+))?\/v1\/auth\/(status|login|logout)(?:\/(answer|cancel))?$/.exec(path);
    if (authRoute) {
      let named: string | undefined;
      try {
        named = authRoute[1] === undefined ? undefined : decodeURIComponent(authRoute[1]);
      } catch {
        return fail(res, 400, 'bad profile name', 'bad_request');
      }
      // a team's own sign-in on a server where each team signs in (P35-10b)
      const teamName = url.searchParams.get('team');
      let team: TeamOfTarget | undefined;
      if (teamName !== null) {
        if (!isSlug(teamName)) return fail(res, 400, '"team" must be a team slug', 'bad_request');
        const server = options.config.server;
        if (!hasTeamUsers(server)) return fail(res, 409, SCOPE_WORDS.oneUser, 'no_team_users');
        team = { slug: teamName, server };
      }
      const chosen = authService.resolve(named, url.searchParams.get('agent') ?? undefined, team);
      if (!chosen) return fail(res, 404, 'no such profile and no default', 'profile_not_found');
      const [, , what, sub] = authRoute;
      const expected = what === 'status' ? 'GET' : 'POST';
      if (method !== expected || (sub !== undefined && what !== 'login')) return fail(res, 405, 'method not allowed', 'method_not_allowed', { allow: expected });
      const scopeKey = options.config.server === undefined ? null : agentKeyOf(chosen.profile.agent);
      const scopeNow = scopeKey === null ? 'shared' : serverSigninScope(options.config, scopeKey);
      if (team !== undefined && scopeNow !== 'per_team') return fail(res, 409, SCOPE_WORDS.oneSignIn, 'one_sign_in');
      // the shared folder is signed out and empty while each team signs in: a new sign-in there would be one nobody uses
      if (team === undefined && scopeNow === 'per_team' && what === 'login' && sub === undefined) return fail(res, 409, SCOPE_WORDS.teamNeeded, 'team_needed');
      if (team !== undefined && scopeKey !== null) recordOwn(scopeKey, team.slug);
      try {
        if (what === 'status') return send(res, 200, { auth: await authService.status(chosen) });
        const body = await readJsonObject(req, res, bodyTimeoutMs);
        if (body === null) return;
        if (what === 'logout') {
          if (team !== undefined && scopeKey !== null) {
            // one team's own sign-in: only that team's runs of the agent stop; nothing of another team or of the machine is touched
            const auth = await authService.logout(chosen);
            const stopped = manager.stopTeamAgent(scopeKey, team.slug, 'This team was signed out, so this run stopped. Sign the team in again on the Runners page.');
            if (stopped > 0) log(`${scopeKey} sign-out of team ${team.slug}: ${stopped} live run(s) stopped`);
            return send(res, 200, { auth });
          }
          return send(res, 200, { auth: await signOutShared(chosen) });
        }
        if (sub === 'cancel') {
          const id = body['attemptId'];
          if (id !== undefined && typeof id !== 'string') return fail(res, 400, '"attemptId" must be a string', 'bad_request');
          const attempt = authService.cancel(chosen, id);
          return attempt ? send(res, 200, { attempt }) : fail(res, 404, 'no such sign-in', 'no_such_sign_in');
        }
        if (sub === 'answer') {
          const id = body['attemptId'];
          if (typeof id !== 'string') return fail(res, 400, '"attemptId" must be a string', 'bad_request');
          const code = body['code'] === undefined ? undefined : cleanSecret(body['code'], 1, 2000);
          const apiKey = body['apiKey'] === undefined ? undefined : cleanSecret(body['apiKey'], 8, 500);
          if (code === null || apiKey === null || (code === undefined && apiKey === undefined) || (code !== undefined && apiKey !== undefined)) {
            return fail(res, 400, 'give "code" (one line) or "apiKey" (8 to 500 characters, no spaces)', 'bad_request');
          }
          return send(res, 200, { attempt: await authService.answer(chosen, id, { ...(code !== undefined ? { code } : {}), ...(apiKey !== undefined ? { apiKey } : {}) }) });
        }
        const methodId = body['methodId'];
        if (typeof methodId !== 'string' || methodId === '' || methodId.length > 80) return fail(res, 400, '"methodId" must be a string', 'bad_request');
        return send(res, 200, { attempt: await authService.login(chosen, methodId) });
      } catch (err) {
        // The message is one of this module's own plain sentences; nothing the adapter said about an account goes into it.
        if (err instanceof AuthRefused) return fail(res, err.status, err.message, err.code);
        throw err;
      }
    }

    const m = /^\/p\/([^/]+)\/v1\/runs(?:\/([^/]+)(\/events|\/stop|\/approval|\/steer)?)?$/.exec(path);
    if (!m) return fail(res, 404, 'not found', 'not_found');
    let profile: string;
    try {
      profile = decodeURIComponent(m[1]!);
    } catch {
      return fail(res, 400, 'bad profile name', 'bad_request');
    }
    if (!profileFor(options.config, profile)) return fail(res, 404, `no profile "${profile.slice(0, 64)}" and no default`, 'profile_not_found');
    const id = m[2];
    const tail = m[3];

    if (id === undefined) {
      if (method !== 'POST') return fail(res, 405, 'method not allowed', 'method_not_allowed');
      let raw: string;
      try {
        raw = await readBody(req, bodyTimeoutMs);
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail(res, 413, 'the request body is over 1 MB', 'too_large', { connection: 'close' });
        if (err instanceof BodyTimeout) return fail(res, 408, 'the request body took too long', 'request_timeout', { connection: 'close' });
        throw err;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'the body is not JSON', 'bad_request');
      }
      const parsed = parseRunRequest(json);
      if (!parsed.ok) return fail(res, 400, parsed.error, 'bad_request');
      const keyHeader = req.headers['idempotency-key'];
      const key = typeof keyHeader === 'string' && keyHeader !== '' ? keyHeader.slice(0, 200) : null;
      try {
        const { run } = manager.create(profile, parsed.value, raw, key);
        return send(res, 202, { run_id: run.id, status: run.status });
      } catch (err) {
        if (err instanceof IdempotencyConflict) return fail(res, 409, 'that idempotency key was used with a different body', 'idempotency_conflict');
        if (err instanceof TooManyRuns) return fail(res, 429, 'the bridge is at its limit of runs at once', 'too_many_runs', { 'retry-after': '5' });
        if (err instanceof UnknownProfile) return fail(res, 404, 'no such profile', 'profile_not_found');
        throw err;
      }
    }

    const run = manager.get(profile, id);
    if (!run) return fail(res, 404, 'run not found', 'run_not_found');
    if (tail === '/events' && method === 'GET') return stream(req, res, run, url);
    if (tail === '/stop' && method === 'POST') {
      manager.stop(run);
      return send(res, 200, { run_id: run.id, status: run.status === 'running' ? 'stopping' : run.status });
    }
    if ((tail === '/approval' || tail === '/steer') && method === 'POST') {
      let raw: string;
      try {
        raw = await readBody(req, bodyTimeoutMs);
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail(res, 413, 'the request body is over 1 MB', 'too_large', { connection: 'close' });
        if (err instanceof BodyTimeout) return fail(res, 408, 'the request body took too long', 'request_timeout', { connection: 'close' });
        throw err;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'the body is not JSON', 'bad_request');
      }
      const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      if (fields === null) return fail(res, 400, 'the body must be a JSON object', 'bad_request');
      if (tail === '/approval') {
        const choice = fields['choice'];
        const requestId = fields['request_id'];
        if (choice !== 'once' && choice !== 'session' && choice !== 'deny') return fail(res, 400, '"choice" must be once, session or deny', 'bad_request');
        if (requestId !== undefined && requestId !== null && typeof requestId !== 'string') return fail(res, 400, '"request_id" must be a string', 'bad_request');
        if (run.status !== 'running' || run.approvalHandler === null || !run.approvalHandler(typeof requestId === 'string' ? requestId : null, choice)) return fail(res, 404, 'no such question is waiting', 'no_such_question');
        return send(res, 200, { ok: true });
      }
      const text = fields['input'];
      if (typeof text !== 'string' || text.trim() === '') return fail(res, 400, '"input" must be a non-empty string', 'bad_request');
      if (run.status !== 'running') return fail(res, 404, 'the run has ended', 'run_ended');
      if (run.steerHandler === null || !(await run.steerHandler(text.slice(0, 8000)))) return fail(res, 409, 'this agent cannot take a note while it works', 'steer_unsupported');
      return send(res, 200, { ok: true });
    }
    if (tail === undefined && method === 'GET') return send(res, 200, status(run));
    return fail(res, 405, 'method not allowed', 'method_not_allowed');
  }

  const headersTimeoutMs = options.headersTimeoutMs ?? 10_000;
  const server: Server = createServer({ connectionsCheckingInterval: Math.max(100, Math.min(headersTimeoutMs, 5_000)) }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.name : 'error'}`);
      if (!res.headersSent) fail(res, 500, 'internal error', 'internal');
      else res.end();
    });
  });
  server.requestTimeout = 0; // event streams stay open; ordinary request bodies are bounded by bodyTimeoutMs instead
  server.headersTimeout = headersTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (options.socketPath !== undefined) {
      rmSync(options.socketPath, { force: true }); // a socket file left by a bridge that was killed
      server.listen(options.socketPath, resolve);
    } else server.listen(options.port ?? 8650, options.host ?? '127.0.0.1', resolve);
  });
  if (options.socketPath !== undefined) {
    chmodSync(options.socketPath, 0o600);
    return {
      url: 'http://unix',
      port: 0,
      close: async () => {
        clearInterval(sweepFailures);
        authService.close();
        manager.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
  const host = options.host ?? '127.0.0.1';
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    close: async () => {
      clearInterval(sweepFailures);
      authService.close();
      manager.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
