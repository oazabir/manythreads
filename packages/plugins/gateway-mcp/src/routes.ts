import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { McpRunCloseRequest, McpRunMintRequest, McpRunMintResponse } from '@manythreads/shared';
import { z } from 'zod';
import { HttpError } from '@manythreads/sdk';
import { json, route, unauthenticated } from './http.ts';
import { handleBotRpc, handleRpc } from './protocol.ts';

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
// so a probe cannot tell which it hit.

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

/** The run the request's bearer token opens, and only when the URL names that same run. */
async function resolveRun(ctx: PluginContext, req: { headers: Record<string, string | undefined>; params: Record<string, string> }) {
  const token = bearerToken(req);
  if (token === null) throw unauthenticated('This run endpoint is not valid any more');
  const run = await ctx.runs.resolve(sha256(token));
  if (!run || run.runId !== req.params['runId']) throw unauthenticated('This run endpoint is not valid any more');
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

export function registerMcpRoutes(ctx: PluginContext): void {
  // The bot endpoint is reached by every profile of a pod from one address, so a per-address bucket would let one noisy bot starve the rest:
  // failures count per client address (a token-guessing flood is slowed), authenticated calls per bot.
  const rateLimited = (): Error => new HttpError(429, 'rate_limited', 'Too many requests; slow down', { 'retry-after': '30' });
  const countFailure = windowed(BOT_FAILURES_PER_IP_PER_MINUTE, rateLimited);
  const failedBotAuth = (ip: string): Error => countFailure(ip) ?? unauthenticated('A valid bot token is required');
  const countBotCall = windowed(BOT_CALLS_PER_BOT_PER_MINUTE, rateLimited);
  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: McpRunMintRequest, response: McpRunMintResponse },
    handler: route(async (req, tx) => {
      const body = McpRunMintRequest.parse(req.body);
      const paired = (await tx.query<PairedBotRow>('SELECT * FROM app.bots_pairing_resolve($1)', [sha256(body.pairingToken)])).rows[0];
      if (!paired) throw unauthenticated('A valid pairing token is required');
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
          url: `${ctx.runtime.publicUrl}/api/mcp/runs/${run.runId}`,
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
      const run = await resolveRun(ctx, req);
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
      const run = await ctx.runs.openRunOf(bot.botId).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AmbiguousRunError') return 'ambiguous' as const;
        throw err;
      });
      return handleBotRpc(ctx, bot, run, req.body);
    }),
  });

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs/:runId/close',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: McpRunCloseRequest, response: CloseResponse },
    handler: route(async (req) => {
      const run = await resolveRun(ctx, req);
      const body = McpRunCloseRequest.parse(req.body);
      const closed = await ctx.runs.close(run.runId, body.status);
      return json(CloseResponse.parse({ ok: true, closed }));
    }),
  });
}
