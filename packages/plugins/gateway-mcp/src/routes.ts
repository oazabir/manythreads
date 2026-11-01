import { createHash } from 'node:crypto';
import type { HttpResponse, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  BotPairingPathParams,
  MCP_PATH,
  MCP_SESSION_HEADER,
  McpRunCloseRequest,
  McpRunMintRequest,
  McpRunMintResponse,
  McpToolsStatus,
  abuseLimit,
  addressKey,
  mcpToolsStatusRoute,
  mcpUrlOf,
} from '@manythreads/shared';
import { z } from 'zod';
import { HttpError, requireTeam } from '@manythreads/sdk';
import { json, notFound, route, unauthenticated } from './http.ts';
import { handleBotRpc, handleRpc, type BotEndpoint, type PairedBotHandle } from './protocol.ts';
import type { McpSessions } from './session.ts';
import type { StreamHub } from './streams.ts';
import { recordListing, refreshPushedDigest, toolsStatusOf } from './tools-state.ts';

// The endpoint (SPEC §11, PLAN P5-09). The runtime holds one pairing token for its bot and asks for a run; the
// answer is one URL and one token for that run only (docs/spikes/per-run-scoping.md). Every call to that URL is
// then resolved back to the run — the bot, the team and the person who asked are read from the database, never
// from the caller — and goes through the broker with the run's trigger.
//
// A pairing token proves "I am this bot's runtime", not "a person asked this bot something", so the public mint opens a
// run with **no asker** and the fixed trigger `webhook`: its reads run as the bot (team-public data only) and no `person:*`
// scope is offered. A conversation or mention run — with the person who asked — is opened only in-process, by the router
// (`runtime-hermes`, `ctx.runs.open`), which reads the asker from the message it is answering.
//
// The routes are public in the session sense: the pairing token (mint) or the run token (everything else) is the
// credential. The run token travels as `Authorization: Bearer <token>`, never in the URL (a path is logged by every proxy
// and access log); the URL names the run (`/api/mcp/runs/<runId>`) and must agree with the token's run. A revoked pairing
// token, a forged run token, an expired one, a finished run and a run id that is not the token's all answer the same 401,
// so a probe cannot tell which it hit. `POST /mcp` is the single address handed out everywhere; the two paths above remain for older profiles.

const sha256 = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

interface PairedBotRow {
  bot_id: string;
  team_id: string;
  workspace_id: string;
  actor_id: string;
  slug: string;
  [key: string]: unknown;
}

/** The bearer token of a request, or null. One header, one scheme; nothing is read from the URL or the body. */
const bearerToken = (req: { headers: Record<string, string | undefined> }): string | null => {
  const header = req.headers['authorization'];
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+([A-Za-z0-9_-]{1,200})[ \t]*$/.exec(header);
  return match?.[1] ?? null;
};

const RUN_GONE = 'This run endpoint is not valid any more';

/** The run the request's bearer token opens, and only when the URL names that same run. */
async function resolveRun(
  ctx: PluginContext,
  req: { headers: Record<string, string | undefined>; params: Record<string, string>; ip: string },
  failed: (ip: string, message?: string) => Error,
) {
  const token = bearerToken(req);
  if (token === null) throw failed(req.ip, RUN_GONE);
  const run = await ctx.runs.resolve(sha256(token));
  if (!run || run.runId !== req.params['runId']) throw failed(req.ip, RUN_GONE);
  return run;
}

/** The trigger of a run opened through the public mint: not a conversation or a mention, so it never carries `person:*`. */
const PUBLIC_MINT_TRIGGER = 'webhook';

/** The bot a presented bot token belongs to, and only when the URL names that same bot. One 401 for an unknown, revoked or someone else's token. */
async function resolveBotToken(
  tx: PluginTx,
  req: { headers: Record<string, string | undefined>; params: Record<string, string>; ip: string },
  failed: (ip: string) => Error,
): Promise<{ botId: string; botActorId: string; teamId: string; workspaceId: string }> {
  const token = bearerToken(req);
  if (token === null) throw failed(req.ip);
  const paired = (await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [sha256(token)])).rows[0];
  if (!paired || paired.bot_id !== req.params['botId']) throw failed(req.ip);
  return { botId: paired.bot_id, botActorId: paired.actor_id, teamId: paired.team_id, workspaceId: paired.workspace_id };
}

const CloseResponse = z.strictObject({ ok: z.literal(true), closed: z.boolean() });

/** Failed bot-token attempts per client address per minute before further failures answer 429, and calls per bot per minute once authenticated. */
const BOT_FAILURES_PER_IP_PER_MINUTE = 60;
const BOT_CALLS_PER_BOT_PER_MINUTE = 600;
/** Authenticated calls per run per minute on `/mcp` (the older per-run path has the same bound through its route option). */
const RUN_CALLS_PER_RUN_PER_MINUTE = 600;

/** A sliding window of timestamps per key, in this process; pruned so a flood of distinct keys cannot grow it without bound. */
function windowed(limit: number, make: () => Error): (key: string) => Error | null {
  const seen = new Map<string, number[]>();
  return (key) => {
    const at = Date.now();
    const recent = (seen.get(key) ?? []).filter((t) => at - t < 60_000);
    recent.push(at);
    seen.set(key, recent);
    if (seen.size > 5000) for (const [k, times] of seen) if (times.every((t) => at - t >= 60_000)) seen.delete(k);
    return recent.length > limit ? make() : null;
  };
}

/** The session ids and the open event streams, made once by the plugin: the routes use them and the event subscribers wake the streams. */
export interface McpStreams {
  sessions: McpSessions;
  hub: StreamHub;
}

const EVENT_STREAM = /(^|,)\s*text\/event-stream\s*(;|,|$)/i;
const noStore = { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } as const;

export function registerMcpRoutes(ctx: PluginContext, { sessions, hub }: McpStreams): void {
  // The bot endpoint is reached by every profile of a pod from one address, so a per-address bucket would let one noisy bot starve the rest:
  // failures count per client address (a token-guessing flood is slowed), authenticated calls per bot.
  const rateLimited = (): Error => new HttpError(429, 'rate_limited', 'Too many requests; slow down', { 'retry-after': '30' });
  const countFailure = windowed(BOT_FAILURES_PER_IP_PER_MINUTE, rateLimited);
  const failedBotAuth = (ip: string, message = 'A valid bot token is required'): Error => countFailure(addressKey(ip)) ?? unauthenticated(message);
  const countBotCall = windowed(BOT_CALLS_PER_BOT_PER_MINUTE, rateLimited);
  const countRunCall = windowed(RUN_CALLS_PER_RUN_PER_MINUTE, rateLimited);

  // A `tools/list` at a bot's address is kept as "this token has read these tools" (the bot page's line); the write never holds up the answer.
  const endpoint: BotEndpoint = {
    sessions,
    listed: (botId, digest) => void ctx.db.system((tx) => recordListing(tx, botId, digest)).catch(() => undefined),
  };

  /** A session id the client sends back must be one this server issued for this bot; otherwise the session is unknown and the client starts a new one. No header: an older client, allowed. */
  const checkSession = (req: { headers: Record<string, string | undefined>; body?: unknown }, botId: string): void => {
    // an `initialize` starts a session, so a client that re-sends an old id with it (after a restart, or a rotated key) gets a new one instead of a 404
    if ((req.body as { method?: unknown } | null | undefined)?.method === 'initialize') return;
    const id = req.headers[MCP_SESSION_HEADER];
    if (id !== undefined && sessions.verify(id) !== botId) throw notFound('Unknown session; send initialize again');
  };

  const methodNotAllowed = (): HttpResponse => ({
    status: 405,
    headers: { allow: 'POST, GET' },
    body: { error: { code: 'validation_failed', message: 'This address takes POST requests, and GET for the event stream (Accept: text/event-stream)' } },
  });

  /**
   * The event stream of a bot: authenticated like a `POST` (the caller has already resolved the bot's token). It starts with one `list_changed`, so a client
   * that reconnects after a restart or a deploy lists again. The change counter is read BEFORE the stream opens so a change after that is never missed.
   */
  const openStream = async (req: { headers: Record<string, string | undefined> }, bot: PairedBotHandle, tokenHash: Buffer): Promise<HttpResponse> => {
    checkSession(req, bot.botId);
    const busy = (): HttpError => new HttpError(429, 'rate_limited', 'This bot already has its event streams open', { 'retry-after': '30' });
    if (hub.refusal(bot.botId) !== null) throw busy();
    const state = await ctx.db.system((stx) => refreshPushedDigest(ctx, stx, bot.botId));
    if (!state) throw unauthenticated('A valid bot token is required');
    // the list may have changed since the last stream looked (a new version of the platform): the others of this bot hear it too
    if (state.changed) hub.wake();
    const opened = hub.open(bot.botId, tokenHash.toString('hex'), state.version);
    if (!opened.ok) throw busy();
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', ...noStore },
      body: opened.stream,
    };
  };

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs',
    public: true,
    rateLimit: abuseLimit('POST', '/api/mcp/runs'),
    rateLimitBy: 'address',
    schema: { body: McpRunMintRequest, response: McpRunMintResponse },
    handler: route(async (req, tx) => {
      const body = McpRunMintRequest.parse(req.body);
      const paired = (await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [sha256(body.pairingToken)])).rows[0];
      if (!paired) throw failedBotAuth(req.ip, 'A valid pairing token is required');
      const { run, token } = await ctx.runs
        .open({
          botId: paired.bot_id,
          teamId: paired.team_id,
          workspaceId: paired.workspace_id,
          trigger: PUBLIC_MINT_TRIGGER,
          askerActorId: null,
          threadId: body.threadId ?? null,
          ttlSeconds: body.ttlSeconds,
        })
        .catch((err: unknown) => {
          throw new HttpError(400, 'validation_failed', err instanceof Error ? err.message : 'The run could not be opened');
        });
      return json(
        McpRunMintResponse.parse({
          runId: run.runId,
          botId: run.botId,
          url: mcpUrlOf(ctx.runtime.publicUrl),
          token,
          expiresAt: run.expiresAt,
        }),
        201,
      );
    }),
  });

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs/:runId',
    public: true,
    // A run makes many calls in a burst (list, then one call per tool use); the per-run token bounds who can spend them.
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req) => {
      const run = await resolveRun(ctx, req, failedBotAuth);
      return handleRpc(ctx, run, req.body);
    }),
  });

  // The bot's stable endpoint (mode A and B of the Hermes gateway): one address and one token per BOT, for a profile that cannot be given a new
  // token per run. The credential is the bot's pairing token (minted, rotated and revoked by a lead on the bot's page).
  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/bots/:botId',
    public: true,
    handler: route(async (req, tx) => {
      const bot = await resolveBotToken(tx, req, failedBotAuth);
      const limited = countBotCall(bot.botId);
      if (limited) throw limited;
      checkSession(req, bot.botId);
      const run = await ctx.runs.openRunOf(bot.botId).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AmbiguousRunError') return 'ambiguous' as const;
        throw err;
      });
      return handleBotRpc(ctx, bot, run, req.body, endpoint);
    }),
  });

  // The bot's event stream (GET, `Accept: text/event-stream`): the only frame it carries is `notifications/tools/list_changed`. Same credential as the POST.
  ctx.http.route({
    method: 'GET',
    path: '/api/mcp/bots/:botId',
    public: true,
    handler: route(async (req, tx) => {
      if (!EVENT_STREAM.test(req.headers['accept'] ?? '')) return methodNotAllowed();
      const bot = await resolveBotToken(tx, req, failedBotAuth);
      const limited = countBotCall(bot.botId);
      if (limited) throw limited;
      return openStream(req, bot, sha256(bearerToken(req) ?? ''));
    }),
  });

  // The one address (`/mcp`): the bearer token alone says who calls. A run token is tried first (a run's own call, with the asker's authority),
  // then a bot pairing token (a profile's stable credential). An unknown token is one 401, counted per client address like the bot route's.
  ctx.http.route({
    method: 'POST',
    path: MCP_PATH,
    public: true,
    handler: route(async (req, tx) => {
      const token = bearerToken(req);
      if (token === null) throw failedBotAuth(req.ip);
      const digest = sha256(token);
      const run = await ctx.runs.resolve(digest);
      if (run) {
        const runLimited = countRunCall(run.runId);
        if (runLimited) throw runLimited;
        return handleRpc(ctx, run, req.body);
      }
      const paired = (await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [digest])).rows[0];
      if (!paired) throw failedBotAuth(req.ip);
      const bot = { botId: paired.bot_id, botActorId: paired.actor_id, teamId: paired.team_id, workspaceId: paired.workspace_id };
      const limited = countBotCall(bot.botId);
      if (limited) throw limited;
      checkSession(req, bot.botId);
      const open = await ctx.runs.openRunOf(bot.botId).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AmbiguousRunError') return 'ambiguous' as const;
        throw err;
      });
      return handleBotRpc(ctx, bot, open, req.body, endpoint);
    }),
  });

  // The same stream at the one address. Only a bot's pairing token opens it: a run's own token has a run's address and nothing to watch.
  ctx.http.route({
    method: 'GET',
    path: MCP_PATH,
    public: true,
    handler: route(async (req, tx) => {
      if (!EVENT_STREAM.test(req.headers['accept'] ?? '')) return methodNotAllowed();
      const token = bearerToken(req);
      if (token === null) throw failedBotAuth(req.ip);
      const digest = sha256(token);
      const paired = (await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [digest])).rows[0];
      if (!paired) throw failedBotAuth(req.ip);
      const limited = countBotCall(paired.bot_id);
      if (limited) throw limited;
      return openStream(req, { botId: paired.bot_id, botActorId: paired.actor_id, teamId: paired.team_id, workspaceId: paired.workspace_id }, digest);
    }),
  });

  // The bot page's line: does the bot's Hermes hold the tools it would be offered now?
  ctx.http.route({
    ...mcpToolsStatusRoute,
    schema: { response: McpToolsStatus },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = (await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1::uuid AND slug = $2', [team.id, botSlug])).rows[0];
      if (!bot) throw notFound(`No bot "${botSlug}"`);
      const status = await ctx.db.system((stx) => toolsStatusOf(ctx, stx, bot.id));
      if (!status) throw notFound(`No bot "${botSlug}"`);
      return json(McpToolsStatus.parse(status));
    }),
  });

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs/:runId/close',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: McpRunCloseRequest, response: CloseResponse },
    handler: route(async (req) => {
      const run = await resolveRun(ctx, req, failedBotAuth);
      const body = McpRunCloseRequest.parse(req.body);
      const closed = await ctx.runs.close(run.runId, body.status);
      return json(CloseResponse.parse({ ok: true, closed }));
    }),
  });
}
