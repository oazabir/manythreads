import { conflict, HttpError, invalid, json, route, type ClaudePodsProvider, type HttpRequest, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { guardedFetch, OutboundBlockedError } from '@manythreads/sdk/hermes-outbound';
import {
  AgentAuth,
  AgentAuthPathParams,
  AgentLoginResponse,
  AgentLogoutRequest,
  AgentLogoutResponse,
  AnswerAgentLoginRequest,
  CancelAgentLoginRequest,
  GetAgentAuthQuery,
  GetAgentAuthResponse,
  ListAgentAuthTeamsResponse,
  SetSignInScopeRequest,
  SetSignInScopeResponse,
  StartAgentLoginRequest,
  abuseLimit,
  hasSignInScopeChoice,
  listAgentAuthTeamsRoute,
  setSignInScopeRoute,
  agentLogoutRoute,
  answerAgentLoginRoute,
  cancelAgentLoginRoute,
  getAgentAuthRoute,
  startAgentLoginRoute,
  type AgentAuthAgent,
  type AgentAuthAttempt,
} from '@manythreads/shared';
import { z } from 'zod';
import { agentOfKind, isPodCli, loadRunner, presentOne, requireWorkspaceAdmin } from './common.ts';
import type { RunnerRow } from './rows.ts';
import { setServerRunnerSignIn } from './servers.ts';
import { followTeams, oneTeam, storeTeamSignIn, teamSignIns, toTeamState } from './team-signins.ts';
import type { TunnelRegistry } from './tunnel/registry.ts';

// Signing a bridge runner's agent in and out from the Runners page (P25-09, docs/plans/acp.md section 4.1). The server is a thin, admin-only proxy to the runner's agent bridge
// (`tools/agent-bridge`, `/v1/auth/*`), which asks the agent's own adapter. What it holds:
//   * the bridge's address and key are read as the system actor (as a run's are) and never leave this file;
//   * a code or an API key the admin types goes to the bridge in one request and is not stored, logged, audited or returned; the audit line says "an answer was given" only;
//   * every reply is parsed against the shared schema, which keeps only bounded fields, so a bridge cannot hand the page free text, a secret or the agent's account;
//   * the request goes through the outbound guard like the runner test does, with no redirects and a bounded read;
//   * the audit line of a request is written BEFORE the bridge is asked, in a transaction of its own that commits whatever the bridge then answers (a request that fails still leaves
//     its line, with `refused` on a second one), and how a sign-in ended is audited when a page first sees it end (`done` or `failed`): the kind of sign-in and the outcome, never the secret;
//   * the admin check is the first thing a handler does, before the body is read: a person who is not an admin learns nothing about the shape of a request;
//   * the route's own transaction is open while the bridge is asked (the HTTP layer opens it before the handler runs, and a handler cannot give it back), but it has only read, so
//     it holds no row lock; the waits below are bounded (the bridge's own worst case is 60 s, so these stay above it) so the connection is held for a short time at the worst.
// A pod runner (`claude_cli`, `codex_cli`, P26-10) is signed in here too: its pod's bridge sits inside the cluster, so its address and key come from the claude-pods controller (never typed by a person)
// and are asked with a plain request (the outbound guard refuses cluster names on purpose). The sign-in lives in the pod's state volume; the older upload of a sign-in file stays beside it.

const BRIDGE_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);
const MAX_REPLY_BYTES = 64 * 1024;
/**
 * How long the server waits for the bridge, per request. The bridge's slowest answer is three steps of 20 s (a sign-out); these are above that and under a minute and a half. A server's
 * switch of who signs in (`scope`) checks and signs out each listed team one after another, so it may take a few minutes.
 */
const WAITS = { status: 70_000, login: 70_000, answer: 45_000, cancel: 20_000, logout: 75_000, scope: 300_000 } as const;
/** `MANYTHREADS_AGENT_AUTH_WAIT_SCALE` (a number above 0 and up to 1) shortens every wait: for tests of a bridge that does not answer, never set in production. */
const waitOf = (key: keyof typeof WAITS): number => {
  const scale = Number(process.env['MANYTHREADS_AGENT_AUTH_WAIT_SCALE']);
  return Number.isFinite(scale) && scale > 0 && scale <= 1 ? Math.max(100, Math.round(WAITS[key] * scale)) : WAITS[key];
};
/** How many finished sign-ins are remembered as already audited (per server process). */
const REMEMBER_FINISHED = 500;

const WORDS = {
  notBridge: 'Signing in from this page works for a Claude Code or Codex runner, in a pod or on an agent bridge.',
  podsOff: 'Pods are not turned on here, so this runner has no pod to sign in.',
  podNotUp: 'This runner has no pod yet, or the cluster did not answer. Wait a minute for the pod to start, then try again.',
  podUnreachable: 'The pod did not answer. It may still be starting: wait a minute, then try again.',
  notSetUp: 'This runner has no address or key yet.',
  unreachable: "The bridge did not answer. Check the address and that the agent bridge is running, then try again.",
  refusedKey: 'The bridge refused the key. Update the runner with the key the bridge was started with.',
  unreadable: 'The bridge answered something this page cannot read. Check that it runs the current version of the agent bridge.',
  old: 'This bridge cannot sign the agent in yet. Update the agent bridge on that machine.',
  noSignIn: 'This agent has no sign-in of its own to do here.',
  serverOffline: 'The server is not connected. Check that the machine is on and the bridge is running, then try again.',
  // a runner where each team signs in (P35-10)
  teamNeeded: 'Each team of this runner signs in on its own. Choose the team to sign in.',
  oneSignIn: 'This runner has one sign-in for all its teams, so no team is chosen here.',
  teamUnknown: 'That team is not one of the teams this runner serves.',
  teamNoPod: 'This team has no pod on this runner yet. Place one of its bots on the runner, then wait a minute for the pod to start.',
  noScopeChoice: 'Only a Claude Code or Codex runner can have a sign-in for each team.',
  serverOneUser: 'This server runs every team as one user, so a team cannot have a sign-in of its own there: one user can read every folder. Install the bridge on it again (it then makes a user per team) and try again.',
  serverOld: 'This server cannot let each team sign in yet. Update the agent bridge on that machine.',
  notPerTeam: 'This runner has one sign-in for all its teams, so there is no list of team sign-ins.',
  changed: 'Someone changed who signs this runner in at the same time. Look at the runner again, then try again.',
  switchOut: (who: string) => `${who} could not be signed out, so nothing was changed. Wait a minute for the pod to answer, then try again.`,
  switchCluster: 'The cluster did not remove the old sign-in, so nothing was changed. Try again in a moment.',
} as const;

interface Target {
  runner: RunnerRow;
  agent: AgentAuthAgent;
  /** The runner is a pod runner: the address is the pod's own, inside the cluster. */
  pod?: true;
  baseUrl: string;
  key: string;
  /** A runner on an enrolled server is asked through the server's open connection (no address, no key, no outbound guard). */
  tunnel?: typeof fetch;
  /** A runner where each team signs in (P35-10): the team whose own sign-in this is, and whose pod answers. */
  team?: { id: string; slug: string; name: string };
}

const BridgeError = z.object({ error: z.object({ message: z.string().max(2000), code: z.string().max(80) }) });
const printable = (s: string): string => s.replace(/[^\x20-\x7e\u00a0-\uffff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

export function registerAgentAuthRoutes(ctx: PluginContext, registry?: TunnelRegistry): void {
  const now = (): string => ctx.runtime.now().toISOString();

  /** The team a request names, as one of the teams the runner serves; refused when it names none, an unknown team or one the runner is not open to. */
  async function teamOf(runner: RunnerRow, slug: string): Promise<{ teamId: string; slug: string; name: string; served: boolean }> {
    const team = await ctx.db.system((sys) => oneTeam(sys, runner.id, slug), { workspaceId: runner.workspace_id });
    if (!team) throw invalid(WORDS.teamUnknown);
    return team;
  }

  /** Every caller has made the admin check already, as the first thing it does (before the body is read). */
  async function target(tx: PluginTx, id: string, teamSlug?: string): Promise<Target> {
    const runner = await loadRunner(tx, id);
    const perTeam = runner.sign_in_scope === 'per_team';
    if (!perTeam && teamSlug !== undefined) throw invalid(WORDS.oneSignIn);
    if (perTeam && !isPodCli(runner.kind) && runner.kind !== 'server_agent') throw conflict(WORDS.noScopeChoice);
    if (runner.kind === 'server_agent') {
      // Hermes on a server has no sign-in of its own here: the bridge's answer for it is `not_needed`, and the page shows nothing to do.
      if (runner.server_id === null || registry === undefined) throw conflict('This runner has no server.');
      const server = (await tx.query<{ name: string; team_users: boolean }>('SELECT name, team_users FROM app.bot_servers WHERE id = $1::uuid', [runner.server_id])).rows[0];
      if (!server) throw conflict('This runner has no server.');
      if (runner.agent !== 'claude-code' && runner.agent !== 'codex') throw invalid(WORDS.noSignIn);
      const base: Target = { runner, agent: runner.agent as AgentAuthAgent, baseUrl: 'http://server.invalid', key: '', tunnel: registry.fetchFor(runner.server_id, server.name) };
      if (!perTeam) return base;
      // a team's own sign-in on a server (P35-10b): the bridge signs it in as the team's own user, into the team's own folder; any team open to the runner may sign in
      if (!server.team_users) throw conflict(WORDS.serverOneUser);
      if (teamSlug === undefined) throw invalid(WORDS.teamNeeded);
      const team = await teamOf(runner, teamSlug);
      return { ...base, team: { id: team.teamId, slug: team.slug, name: team.name } };
    }
    if (isPodCli(runner.kind)) {
      const pods = ctx.providers.get<ClaudePodsProvider>('claude.pods');
      if (!pods) throw conflict(WORDS.podsOff);
      const which = agentOfKind(runner.kind);
      if (perTeam) {
        // the team's own pod answers for the team's own sign-in, and no other pod
        if (teamSlug === undefined) throw invalid(WORDS.teamNeeded);
        const team = await teamOf(runner, teamSlug);
        const found = await pods.bridge({ runnerName: runner.name, agent: which, teamSlug: team.slug }).catch(() => null);
        if (!found) throw conflict(team.served ? WORDS.podNotUp : WORDS.teamNoPod);
        return { runner, agent: which === 'codex' ? 'codex' : 'claude-code', baseUrl: found.address, key: found.key, pod: true, team: { id: team.teamId, slug: team.slug, name: team.name } };
      }
      const found = await pods.bridge({ runnerName: runner.name, agent: which }).catch(() => null);
      if (!found) throw conflict(WORDS.podNotUp);
      return { runner, agent: which === 'codex' ? 'codex' : 'claude-code', baseUrl: found.address, key: found.key, pod: true };
    }
    if (runner.kind !== 'hermes_gateway' || !BRIDGE_AGENTS.has(runner.agent)) throw invalid(WORDS.notBridge);
    if (runner.base_url === null || runner.secret_id === null) throw conflict(WORDS.notSetUp);
    const secretId = runner.secret_id;
    const key = await ctx.db.system((sys) => ctx.secrets.get(sys, secretId), { workspaceId: runner.workspace_id });
    return { runner, agent: runner.agent as AgentAuthAgent, baseUrl: runner.base_url.replace(/\/+$/, ''), key };
  }

  /** One request to the bridge; returns the parsed JSON of a 200, or throws the plain refusal the page shows. */
  async function ask<T extends z.ZodType>(t: Target, method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, schema: T, timeoutMs: number): Promise<z.infer<T>> {
    let res: Response;
    try {
      // a server's bridge is told the team in the address (a pod's bridge is the team's own pod and is told nothing)
      const url = `${t.baseUrl}${path}${path.includes('?') ? '&' : '?'}agent=${encodeURIComponent(t.agent)}${t.tunnel && t.team ? `&team=${encodeURIComponent(t.team.slug)}` : ''}`;
      const init = {
        method,
        headers: { ...(t.tunnel ? {} : { authorization: `Bearer ${t.key}` }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error' as const,
        signal: AbortSignal.timeout(timeoutMs),
      };
      res = t.tunnel ? await t.tunnel(url, init) : t.pod ? await fetch(url, init) : await guardedFetch(url, init);
    } catch (err) {
      throw new HttpError(502, 'internal', err instanceof OutboundBlockedError ? 'That address cannot be used: it is not allowed from this server.' : t.tunnel ? WORDS.serverOffline : t.pod ? WORDS.podUnreachable : WORDS.unreachable);
    }
    let text = '';
    try {
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REPLY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error('too large');
        }
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      throw new HttpError(502, 'internal', WORDS.unreadable);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'internal', WORDS.refusedKey);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'internal', WORDS.unreadable);
    }
    if (!res.ok) {
      // The bridge's own plain sentence for what went wrong with the sign-in (it never holds a code, a key or the account); shown cleaned and clipped.
      const refused = BridgeError.safeParse(parsed);
      // The route itself is unknown to a bridge that predates the sign-in routes.
      if (res.status === 404 && refused.success && refused.data.error.code === 'not_found') throw new HttpError(502, 'internal', WORDS.old);
      const message = refused.success ? printable(refused.data.error.message) : WORDS.unreadable;
      const status = res.status === 400 ? 400 : res.status === 404 ? 404 : res.status === 409 ? 409 : 502;
      throw new HttpError(status, status === 400 ? 'validation_failed' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'internal', message === '' ? WORDS.unreadable : message);
    }
    const ok = schema.safeParse(parsed);
    if (!ok.success) throw new HttpError(502, 'internal', WORDS.unreadable);
    return ok.data;
  }

  type Line = { change: 'login_started' | 'answer_given' | 'login_cancelled' | 'signed_out' | 'login_succeeded' | 'login_failed'; how?: AgentAuthAttempt['how']; answerKind?: 'code' | 'key'; refused?: true };

  /** One audit line in a transaction of its own, so it is kept whatever the route then answers. */
  const audit = (req: HttpRequest, t: Target, line: Line): Promise<void> =>
    ctx.db.as(req.caller, (own) =>
      ctx.audit.emit(own, {
        type: 'bot_runner.agent_auth.changed',
        workspaceId: t.runner.workspace_id,
        runnerId: t.runner.id,
        name: t.runner.name,
        agent: t.agent,
        ...line,
        ...(t.team ? { teamId: t.team.id } : {}),
        actorId: own.actor.id,
        at: now(),
      }),
    );

  /** Asks the bridge after the audit line is written; when the bridge does not carry it out, a second line says so. */
  async function asked<R>(req: HttpRequest, t: Target, line: Line, call: () => Promise<R>): Promise<R> {
    await audit(req, t, line);
    try {
      return await call();
    } catch (err) {
      await audit(req, t, { ...line, refused: true }).catch(() => undefined);
      throw err;
    }
  }

  // A sign-in that ended is audited once, when a page first sees it end (the polling does not stop being how the end is learned: nothing here runs on its own).
  const finished = new Set<string>();
  /** Returns true when this is the first time a page sees a sign-in end well (a real sign-in on the page). */
  async function noteEnd(req: HttpRequest, t: Target, attempt: AgentAuthAttempt | null): Promise<boolean> {
    if (attempt === null || (attempt.state !== 'done' && attempt.state !== 'failed')) return false;
    const id = `${t.runner.id}:${t.team?.id ?? ''}:${attempt.id}`;
    if (finished.has(id)) return false;
    finished.add(id);
    if (finished.size > REMEMBER_FINISHED) finished.delete(finished.values().next().value as string);
    try {
      await audit(req, t, { change: attempt.state === 'done' ? 'login_succeeded' : 'login_failed', how: attempt.how });
    } catch {
      finished.delete(id);
    }
    return attempt.state === 'done';
  }

  /** A server's runner is ready when its agent is signed in on the server, and waits for a sign-in when it is not; the page's own reads keep it true. */
  async function followSignIn(t: Target, state: string): Promise<void> {
    if (!t.tunnel || t.team || (state !== 'signed_in' && state !== 'signed_out' && state !== 'not_needed')) return;
    await ctx.db.system((sys) => setServerRunnerSignIn(sys, t.runner.id, state !== 'signed_out'), { workspaceId: t.runner.workspace_id }).catch(() => undefined);
  }

  /**
   * A pod runner is ready when its agent is signed in inside the pod, and waits for a sign-in when it is not. The controller finds that out on its own next pass; this lets the page
   * say it as soon as the page itself has seen the bridge say it. Only a runner in the one state the change leaves is touched.
   */
  async function followPodSignIn(t: Target, state: string, real = false): Promise<void> {
    // a team's own sign-in on a server is stored the same way as a team pod's (P35-10b)
    if ((t.pod !== true && !(t.tunnel && t.team)) || (state !== 'signed_in' && state !== 'signed_out')) return;
    if (t.team) {
      // A team's own sign-in: stored for the list and the run resolver; the runner is ready while any of its teams is signed in. A plain status read (`real` false) never clears a
      // refused sign-in or a plan limit: the pod may still read its old file as signed in. A sign-in that ended well on the page, or a sign-out, does.
      const team = t.team;
      await ctx.db
        .system(async (sys) => {
          await storeTeamSignIn(sys, t.runner.id, team.id, state, { force: real });
          await followTeams(sys, t.runner.id);
        }, { workspaceId: t.runner.workspace_id })
        .catch(() => undefined);
      return;
    }
    const [from, to, detail] = state === 'signed_in' ? ['waiting_for_sign_in', 'ready', null] : ['ready', 'waiting_for_sign_in', 'Waiting for a sign-in. Choose Sign in on this runner.'];
    await ctx.db
      .system(async (sys) => {
        await sys.query(
          `UPDATE app.bot_runners SET status = $3, status_detail = $4, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid AND kind IN ('claude_cli', 'codex_cli') AND status = $2`,
          [t.runner.id, from, to, detail],
        );
      })
      .catch(() => undefined);
  }

  const Auth = z.object({ auth: AgentAuth });
  const Attempt = AgentLoginResponse;

  ctx.http.route({
    method: getAgentAuthRoute.method,
    path: getAgentAuthRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: GetAgentAuthResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const query = GetAgentAuthQuery.safeParse(req.query ?? {});
      if (!query.success) throw invalid(WORDS.teamUnknown);
      const t = await target(tx, id, query.data.team);
      const out = GetAgentAuthResponse.parse(await ask(t, 'GET', '/v1/auth/status', undefined, Auth, waitOf('status')));
      // a device-code sign-in ends while the page polls: the first read that sees it done is a real sign-in
      const signedNow = await noteEnd(req, t, out.auth.attempt);
      await followPodSignIn(t, out.auth.state, signedNow && out.auth.state === 'signed_in');
      await followSignIn(t, out.auth.state);
      return json(out);
    }),
  });

  ctx.http.route({
    method: startAgentLoginRoute.method,
    path: startAgentLoginRoute.path,
    rateLimit: abuseLimit(startAgentLoginRoute.method, startAgentLoginRoute.path),
    schema: { response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx); // the admin check comes before the body is looked at
      const body = StartAgentLoginRequest.parse(req.body);
      const t = await target(tx, id, body.team);
      const out = await asked(req, t, { change: 'login_started' }, () => ask(t, 'POST', '/v1/auth/login', { methodId: body.methodId }, Attempt, waitOf('login')));
      await noteEnd(req, t, out.attempt);
      if (out.attempt?.state === 'done') await followPodSignIn(t, 'signed_in', true);
      return json(AgentLoginResponse.parse(out));
    }),
  });

  ctx.http.route({
    method: answerAgentLoginRoute.method,
    path: answerAgentLoginRoute.path,
    rateLimit: abuseLimit(answerAgentLoginRoute.method, answerAgentLoginRoute.path),
    schema: { response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const body = AnswerAgentLoginRequest.parse(req.body);
      const t = await target(tx, id, body.team);
      // The code or the key is in this one request to the bridge and in nothing else here: the audit line says only which of the two it was.
      const out = await asked(req, t, { change: 'answer_given', answerKind: body.code !== undefined ? 'code' : 'key' }, () =>
        ask(t, 'POST', '/v1/auth/login/answer', { attemptId: body.attemptId, ...(body.code !== undefined ? { code: body.code } : { apiKey: body.apiKey }) }, Attempt, waitOf('answer')),
      );
      await noteEnd(req, t, out.attempt);
      if (out.attempt?.state === 'done') await followPodSignIn(t, 'signed_in', true);
      return json(AgentLoginResponse.parse(out));
    }),
  });

  ctx.http.route({
    method: cancelAgentLoginRoute.method,
    path: cancelAgentLoginRoute.path,
    rateLimit: abuseLimit(cancelAgentLoginRoute.method, cancelAgentLoginRoute.path),
    schema: { response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const body = CancelAgentLoginRequest.parse(req.body ?? {});
      const t = await target(tx, id, body.team);
      const out = await asked(req, t, { change: 'login_cancelled' }, () => ask(t, 'POST', '/v1/auth/login/cancel', body.attemptId !== undefined ? { attemptId: body.attemptId } : {}, Attempt, waitOf('cancel')));
      return json(AgentLoginResponse.parse(out));
    }),
  });

  ctx.http.route({
    method: agentLogoutRoute.method,
    path: agentLogoutRoute.path,
    rateLimit: abuseLimit(agentLogoutRoute.method, agentLogoutRoute.path),
    schema: { response: AgentLogoutResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const body = AgentLogoutRequest.parse(req.body ?? {});
      const t = await target(tx, id, body.team);
      const out = await asked(req, t, { change: 'signed_out' }, () => ask(t, 'POST', '/v1/auth/logout', {}, Auth, waitOf('logout')));
      await followSignIn(t, out.auth.state);
      await followPodSignIn(t, out.auth.state, true);
      return json(AgentLogoutResponse.parse(out));
    }),
  });

  // The teams of a runner where each team signs in, each with its stored state (the pod controller's pass, or this page's last read): no team is probed here.
  ctx.http.route({
    method: listAgentAuthTeamsRoute.method,
    path: listAgentAuthTeamsRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    schema: { response: ListAgentAuthTeamsResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const runner = await loadRunner(tx, id);
      if (runner.sign_in_scope !== 'per_team') throw invalid(WORDS.notPerTeam);
      const teams = await ctx.db.system((sys) => teamSignIns(sys, runner), { workspaceId: runner.workspace_id });
      return json(ListAgentAuthTeamsResponse.parse({ items: teams.map(toTeamState) }));
    }),
  });

  const ScopeReply = z.object({
    scope: z.enum(['shared', 'per_team']),
    signedOut: z.number().int().min(0).max(10_000),
    signedOutTeams: z.array(z.string().max(63)).max(2000).default([]),
    notSignedOut: z.array(z.string().max(63)).max(2000).default([]),
    notCleaned: z.array(z.string().max(63)).max(2000).default([]),
  });
  const list = (slugs: readonly string[]): string => (slugs.length <= 5 ? slugs.join(', ') : `${slugs.slice(0, 5).join(', ')} and ${slugs.length - 5} more`);

  /**
   * Who signs a server's Claude Code or Codex runner in (P35-10b, docs/plans/per-team-sign-in.md sections 4, 7 and 8). Only on a server whose bridge said each team runs as a user of
   * its own. The bridge does the switch and keeps the choice (`POST /v1/signin/scope` through the server's connection): it signs the old sign-ins out for real first, removes each team's
   * own folder as the team user, and stops the agent's runs. Choosing the value the runner already has asks the bridge all the same (it cleans what an earlier switch left, and sets a
   * bridge that keeps another choice).
   *
   * No row lock is held while the bridge works (it may take minutes): a short transaction claims the runner (`scope_switch_at`, a second admin's switch is refused while it is set), the
   * bridge is asked outside any transaction, and a second short one writes the column, the server's kept choice and the audit line and clears the claim. If that last write fails after
   * the bridge switched, the next hello shows the difference on the runner (it is never flipped silently). A switch the bridge did only in part (a team could not be signed out or
   * cleaned) changes no column, stores the teams it did sign out as signed out, and says which.
   */
  async function switchServer(req: HttpRequest, tx: PluginTx, runner: RunnerRow, scope: 'shared' | 'per_team') {
    if (runner.server_id === null || registry === undefined) throw conflict('This runner has no server.');
    if (runner.agent !== 'claude-code' && runner.agent !== 'codex') throw invalid(WORDS.noScopeChoice);
    const server = (await tx.query<{ name: string; team_users: boolean }>('SELECT name, team_users FROM app.bot_servers WHERE id = $1::uuid', [runner.server_id])).rows[0];
    if (!server) throw conflict('This runner has no server.');
    if (scope === 'per_team' && !server.team_users) throw conflict(WORDS.serverOneUser);
    const claimed = await ctx.db.as(req.caller, async (own) =>
      (
        await own.query(
          `UPDATE app.bot_runners SET scope_switch_at = now() WHERE id = $1::uuid AND sign_in_scope = $2 AND (scope_switch_at IS NULL OR scope_switch_at < now() - interval '10 minutes') RETURNING id`,
          [runner.id, runner.sign_in_scope],
        )
      ).rows.length === 1,
    );
    if (!claimed) throw conflict(WORDS.changed);
    const release = (): Promise<unknown> => ctx.db.as(req.caller, (own) => own.query('UPDATE app.bot_runners SET scope_switch_at = NULL WHERE id = $1::uuid', [runner.id])).catch(() => undefined);
    // to shared: only the teams that may hold a sign-in of their own here (one with a stored state, or one that may sign in and has one of its bots or is the first), never every
    // open team, so the bridge makes no user for a team that never ran; it adds the teams it signed in itself
    const teams = scope === 'shared' ? (await ctx.db.system((sys) => teamSignIns(sys, runner), { workspaceId: runner.workspace_id })).filter((t) => t.served || t.state !== null) : [];
    const t: Target = { runner, agent: runner.agent as AgentAuthAgent, baseUrl: 'http://server.invalid', key: '', tunnel: registry.fetchFor(runner.server_id, server.name) };
    let out: z.infer<typeof ScopeReply>;
    try {
      out = await ask(t, 'POST', '/v1/signin/scope', { scope, teams: teams.map((x) => x.slug) }, ScopeReply, waitOf('scope'));
    } catch (err) {
      await release();
      // a bridge from before P35-10b does not know the route
      if (err instanceof HttpError && err.message === WORDS.old) throw conflict(WORDS.serverOld);
      throw err;
    }
    const key = runner.agent === 'codex' ? 'codex' : 'claude';
    if (out.scope !== scope) {
      // done in part: the teams the bridge signed out are stored so; the choice stays as it was
      const byslug = new Map(teams.map((x) => [x.slug, x.teamId]));
      await ctx.db
        .system(async (sys) => {
          for (const slug of out.signedOutTeams) {
            const id = byslug.get(slug);
            if (id !== undefined) await storeTeamSignIn(sys, runner.id, id, 'signed_out', { force: true });
          }
          await followTeams(sys, runner.id);
        }, { workspaceId: runner.workspace_id })
        .catch(() => undefined);
      await release();
      const parts = [
        out.signedOutTeams.length > 0 ? `Signed out: ${list(out.signedOutTeams)}.` : 'No team was signed out.',
        out.notSignedOut.length > 0 ? `Could not be signed out: ${list(out.notSignedOut)}.` : '',
        out.notCleaned.length > 0 ? `The sign-in folder could not be removed for: ${list(out.notCleaned)}.` : '',
      ].filter((p) => p !== '');
      throw conflict(`The switch was not finished, so this runner still lets each team sign in. ${parts.join(' ')} Try again in a moment.`);
    }
    const detail = scope === 'per_team' ? 'No team has signed in yet. Choose Sign-in on this runner to sign a team in.' : 'Waiting for a sign-in. Choose Sign-in for this agent on its server.';
    await ctx.db.as(req.caller, async (own) => {
      await own.query(`UPDATE app.bot_runners SET sign_in_scope = $2, scope_switch_at = NULL, status = 'waiting_for_sign_in', status_detail = $3, paused_until = NULL, updated_at = now() WHERE id = $1::uuid`, [runner.id, scope, detail]);
      await own.query(`UPDATE app.bot_servers SET signin_scopes = jsonb_set(signin_scopes, ARRAY[$2::text], to_jsonb($3::text)), updated_at = now() WHERE id = $1::uuid`, [runner.server_id, key, scope]);
      await own.query('SELECT app.bot_runner_team_signins_clear($1::uuid)', [runner.id]);
      await ctx.audit.emit(own, { type: 'bot_runner.sign_in_scope.changed', workspaceId: runner.workspace_id, runnerId: runner.id, name: runner.name, from: runner.sign_in_scope, to: scope, signedOut: out.signedOut, actorId: own.actor.id, at: now() });
    });
    return presentOne(ctx, tx, runner.id);
  }

  /**
   * Who signs a pod runner in: one sign-in for all its teams, or each team on its own (P35-10, docs/plans/per-team-sign-in.md sections 2, 3 and 7). The old sign-ins are signed out
   * for real first (deleting a volume alone would leave a copy a full-access team may already hold valid), through each pod's bridge; only then is the column written and the old
   * volumes deleted (the claim of the shared sign-in and its uploaded file, or every team's sign-in claim). A refusal of the cluster rolls the column back. The controller's next pass
   * restarts every pod of the runner on its new volume, which also clears the shell homes and bridge sessions kept beside the sign-in: runs under way stop.
   */
  ctx.http.route({
    method: setSignInScopeRoute.method,
    path: setSignInScopeRoute.path,
    rateLimit: abuseLimit(setSignInScopeRoute.method, setSignInScopeRoute.path),
    schema: { body: SetSignInScopeRequest, response: SetSignInScopeResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const body = SetSignInScopeRequest.parse(req.body);
      const runner = await loadRunner(tx, id);
      // a server runner asks its bridge even for the choice it has (see switchServer)
      if (runner.kind === 'server_agent' && hasSignInScopeChoice(runner)) return json(SetSignInScopeResponse.parse({ runner: await switchServer(req, tx, runner, body.scope) }));
      if (runner.sign_in_scope === body.scope) return json(SetSignInScopeResponse.parse({ runner: await presentOne(ctx, tx, id) }));
      if (!hasSignInScopeChoice(runner)) throw invalid(WORDS.noScopeChoice);
      if (!isPodCli(runner.kind)) throw invalid(WORDS.noScopeChoice);
      const pods = ctx.providers.get<ClaudePodsProvider>('claude.pods');
      if (!pods) throw conflict(WORDS.podsOff);
      const which = agentOfKind(runner.kind);
      const agent: AgentAuthAgent = which === 'codex' ? 'codex' : 'claude-code';
      const toolName = agent === 'codex' ? 'Codex' : 'Claude Code';

      /** Sign one pod's sign-in out when it is signed in. A pod that does not exist has no sign-in to sign out (its volume is deleted below); one that does not answer stops the switch. */
      const signOut = async (found: { address: string; key: string } | null, who: string): Promise<number> => {
        if (!found) return 0;
        const t: Target = { runner, agent, baseUrl: found.address, key: found.key, pod: true };
        try {
          const status = await ask(t, 'GET', '/v1/auth/status', undefined, Auth, waitOf('status'));
          if (status.auth.state !== 'signed_in') return 0;
          const out = await ask(t, 'POST', '/v1/auth/logout', {}, Auth, waitOf('logout'));
          if (out.auth.state === 'signed_in') throw new Error('still signed in');
          return 1;
        } catch {
          throw conflict(WORDS.switchOut(who));
        }
      };

      let signedOut = 0;
      if (body.scope === 'per_team') {
        // the one sign-in for all teams: any pod of the runner answers for it
        signedOut += await signOut(await pods.bridge({ runnerName: runner.name, agent: which }).catch(() => null), `The ${toolName} sign-in of ${runner.label}`);
      } else {
        // every team's own sign-in: a team that is served, or that has a stored state, is asked through its own pod
        const teams = await ctx.db.system((sys) => teamSignIns(sys, runner), { workspaceId: runner.workspace_id });
        for (const team of teams.filter((x) => x.served || x.state !== null)) {
          signedOut += await signOut(await pods.bridge({ runnerName: runner.name, agent: which, teamSlug: team.slug }).catch(() => null), `Team ${team.name}`);
        }
      }

      // the row is locked only now, after the slow sign-outs; a change made in between by someone else wins
      const locked = await loadRunner(tx, id, true);
      if (locked.sign_in_scope !== runner.sign_in_scope) throw conflict(WORDS.changed);
      if (body.scope === 'per_team') {
        // the uploaded sign-in file (if any) goes with the shared sign-in, as the remove route does
        await tx.query(
          `UPDATE app.bot_runners
              SET sign_in_scope = 'per_team', owner_actor_id = NULL, plan_label = NULL, credentials_expires_at = NULL, uploaded_at = NULL, login_id = NULL, credentials_sha256 = NULL,
                  status = 'waiting_for_sign_in', status_detail = 'No team has signed in yet. Choose Sign-in on this runner to sign a team in.', paused_until = NULL, updated_at = now()
            WHERE id = $1::uuid`,
          [id],
        );
      } else {
        await tx.query(
          `UPDATE app.bot_runners
              SET sign_in_scope = 'shared', status = 'waiting_for_sign_in', status_detail = 'Waiting for a sign-in. Choose Sign in on this runner once its pod is up.', paused_until = NULL, updated_at = now()
            WHERE id = $1::uuid`,
          [id],
        );
      }
      // The stored team states belong to the old scope: cleared in this transaction (the table's one door for an admin), so they go exactly when the switch commits. The row
      // lock above makes a controller pass that stores a team state wait for this one, and then see the new scope.
      await tx.query('SELECT app.bot_runner_team_signins_clear($1::uuid)', [id]);
      await ctx.audit.emit(tx, { type: 'bot_runner.sign_in_scope.changed', workspaceId: runner.workspace_id, runnerId: id, name: runner.name, from: runner.sign_in_scope, to: body.scope, signedOut, actorId: tx.actor.id, at: now() });
      // Written last: if the cluster refuses, the request fails and the column goes back with the rows above.
      try {
        if (body.scope === 'per_team') await pods.removeCredentials({ runnerName: runner.name, agent: which });
        else await pods.removeTeamSignins({ runnerId: id });
      } catch {
        throw conflict(WORDS.switchCluster);
      }
      return json(SetSignInScopeResponse.parse({ runner: await presentOne(ctx, tx, id) }));
    }),
  });
}
