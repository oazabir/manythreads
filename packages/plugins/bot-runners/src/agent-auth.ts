import { conflict, HttpError, invalid, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { guardedFetch, OutboundBlockedError } from '@manythreads/sdk/hermes-outbound';
import {
  AgentAuth,
  AgentAuthPathParams,
  AgentLoginResponse,
  AgentLogoutResponse,
  AnswerAgentLoginRequest,
  CancelAgentLoginRequest,
  GetAgentAuthResponse,
  StartAgentLoginRequest,
  abuseLimit,
  agentLogoutRoute,
  answerAgentLoginRoute,
  cancelAgentLoginRoute,
  getAgentAuthRoute,
  startAgentLoginRoute,
  type AgentAuthAgent,
} from '@manythreads/shared';
import { z } from 'zod';
import { loadRunner, requireWorkspaceAdmin } from './common.ts';
import type { RunnerRow } from './rows.ts';

// Signing a bridge runner's agent in and out from the Runners page (P25-09, docs/plans/acp.md section 4.1). The server is a thin, admin-only proxy to the runner's agent bridge
// (`tools/agent-bridge`, `/v1/auth/*`), which asks the agent's own adapter. What it holds:
//   * the bridge's address and key are read as the system actor (as a run's are) and never leave this file;
//   * a code or an API key the admin types goes to the bridge in one request and is not stored, logged, audited or returned; the audit line says "an answer was given" only;
//   * every reply is parsed against the shared schema, which keeps only bounded fields, so a bridge cannot hand the page free text, a secret or the agent's account;
//   * the request goes through the outbound guard like the runner test does, with no redirects and a bounded read.
// A pod runner (`claude_cli`, `codex_cli`) signs in with its file (P19-06) and is refused here; its pod's bridge is not an address this server can reach (P25-14).

const BRIDGE_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);
const MAX_REPLY_BYTES = 64 * 1024;

const WORDS = {
  notBridge: 'Signing in from this page works for a Claude Code or Codex runner on an agent bridge. A pod runner signs in with its sign-in file.',
  notSetUp: 'This runner has no address or key yet.',
  unreachable: "The bridge did not answer. Check the address and that the agent bridge is running, then try again.",
  refusedKey: 'The bridge refused the key. Update the runner with the key the bridge was started with.',
  unreadable: 'The bridge answered something this page cannot read. Check that it runs the current version of the agent bridge.',
  old: 'This bridge cannot sign the agent in yet. Update the agent bridge on that machine.',
} as const;

interface Target {
  runner: RunnerRow;
  agent: AgentAuthAgent;
  baseUrl: string;
  key: string;
}

const BridgeError = z.object({ error: z.object({ message: z.string().max(2000), code: z.string().max(80) }) });
const printable = (s: string): string => s.replace(/[^\x20-\x7e\u00a0-\uffff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

export function registerAgentAuthRoutes(ctx: PluginContext): void {
  const now = (): string => ctx.runtime.now().toISOString();

  async function target(tx: PluginTx, id: string): Promise<Target> {
    await requireWorkspaceAdmin(tx);
    const runner = await loadRunner(tx, id);
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
      res = await guardedFetch(`${t.baseUrl}${path}${path.includes('?') ? '&' : '?'}agent=${encodeURIComponent(t.agent)}`, {
        method,
        headers: { authorization: `Bearer ${t.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HttpError(502, 'internal', err instanceof OutboundBlockedError ? 'That address cannot be used: it is not allowed from this server.' : WORDS.unreachable);
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

  const audit = (t: Target, tx: PluginTx, actorId: string, change: 'login_started' | 'answer_given' | 'login_cancelled' | 'signed_out') =>
    ctx.audit.emit(tx, { type: 'bot_runner.agent_auth.changed', workspaceId: t.runner.workspace_id, runnerId: t.runner.id, name: t.runner.name, agent: t.agent, change, actorId, at: now() });

  const Auth = z.object({ auth: AgentAuth });
  const Attempt = AgentLoginResponse;

  ctx.http.route({
    method: getAgentAuthRoute.method,
    path: getAgentAuthRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: GetAgentAuthResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      const t = await target(tx, id);
      return json(GetAgentAuthResponse.parse(await ask(t, 'GET', '/v1/auth/status', undefined, Auth, 40_000)));
    }),
  });

  ctx.http.route({
    method: startAgentLoginRoute.method,
    path: startAgentLoginRoute.path,
    rateLimit: abuseLimit(startAgentLoginRoute.method, startAgentLoginRoute.path),
    schema: { body: StartAgentLoginRequest, response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      const body = StartAgentLoginRequest.parse(req.body);
      const t = await target(tx, id);
      const out = await ask(t, 'POST', '/v1/auth/login', { methodId: body.methodId }, Attempt, 30_000);
      await audit(t, tx, tx.actor.id, 'login_started');
      return json(AgentLoginResponse.parse(out));
    }),
  });

  ctx.http.route({
    method: answerAgentLoginRoute.method,
    path: answerAgentLoginRoute.path,
    rateLimit: abuseLimit(answerAgentLoginRoute.method, answerAgentLoginRoute.path),
    schema: { body: AnswerAgentLoginRequest, response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      const body = AnswerAgentLoginRequest.parse(req.body);
      const t = await target(tx, id);
      // The code or the key is in this one request to the bridge and in nothing else here: the audit line below carries neither.
      const out = await ask(t, 'POST', '/v1/auth/login/answer', { attemptId: body.attemptId, ...(body.code !== undefined ? { code: body.code } : { apiKey: body.apiKey }) }, Attempt, 30_000);
      await audit(t, tx, tx.actor.id, 'answer_given');
      return json(AgentLoginResponse.parse(out));
    }),
  });

  ctx.http.route({
    method: cancelAgentLoginRoute.method,
    path: cancelAgentLoginRoute.path,
    rateLimit: abuseLimit(cancelAgentLoginRoute.method, cancelAgentLoginRoute.path),
    schema: { body: CancelAgentLoginRequest, response: AgentLoginResponse },
    handler: route(async (req, tx) => {
      const { id } = AgentAuthPathParams.parse(req.params);
      const body = CancelAgentLoginRequest.parse(req.body ?? {});
      const t = await target(tx, id);
      const out = await ask(t, 'POST', '/v1/auth/login/cancel', body.attemptId !== undefined ? { attemptId: body.attemptId } : {}, Attempt, 15_000);
      await audit(t, tx, tx.actor.id, 'login_cancelled');
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
      const t = await target(tx, id);
      const out = await ask(t, 'POST', '/v1/auth/logout', {}, Auth, 60_000);
      await audit(t, tx, tx.actor.id, 'signed_out');
      return json(AgentLogoutResponse.parse(out));
    }),
  });
}
