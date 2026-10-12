import { createHash } from 'node:crypto';
import type { PluginContext } from '@manythreads/sdk';
import { McpRunCloseRequest, McpRunMintRequest, McpRunMintResponse } from '@manythreads/shared';
import { z } from 'zod';
import { HttpError } from '@manythreads/sdk';
import { json, route, unauthenticated } from './http.ts';
import { handleRpc } from './protocol.ts';

// The endpoint (SPEC §11, PLAN P5-09). The runtime holds one pairing token for its bot and asks for a run; the
// answer is one URL and one token for that run only (docs/spikes/per-run-scoping.md). Every call to that URL is
// then resolved back to the run — the bot, the team and the person who asked are read from the database, never
// from the caller — and goes through the broker with the run's trigger.
//
// All three routes are public in the session sense: the pairing token (mint) or the run token (everything else) is
// the credential. A revoked pairing token, a forged run token, an expired one and a finished run all answer the
// same 401, so a probe cannot tell which it hit.

const sha256 = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

interface PairedBotRow {
  bot_id: string;
  team_id: string;
  workspace_id: string;
  actor_id: string;
  slug: string;
  [key: string]: unknown;
}

const CloseResponse = z.strictObject({ ok: z.literal(true), closed: z.boolean() });

export function registerMcpRoutes(ctx: PluginContext): void {
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
      // A pairing token is valid but the asker it names may not be (not a person of that team, no such actor): that is
      // the caller's payload to fix, so it is a 400 with the service's own reason rather than a 500.
      const { run, token } = await ctx.runs
        .open({
          botId: paired.bot_id,
          teamId: paired.team_id,
          workspaceId: paired.workspace_id,
          trigger: body.trigger,
          askerActorId: body.askerActorId ?? null,
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
          url: `${ctx.runtime.publicUrl}/api/mcp/runs/${token}`,
          token,
          expiresAt: run.expiresAt,
        }),
        201,
      );
    }),
  });

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs/:token',
    public: true,
    // A run makes many calls in a burst (list, then one call per tool use); the per-run token bounds who can spend them.
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req) => {
      const run = await ctx.runs.resolve(sha256(req.params['token'] ?? ''));
      if (!run) throw unauthenticated('This run endpoint is not valid any more');
      return handleRpc(ctx, run, req.body);
    }),
  });

  ctx.http.route({
    method: 'POST',
    path: '/api/mcp/runs/:token/close',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: McpRunCloseRequest, response: CloseResponse },
    handler: route(async (req) => {
      const run = await ctx.runs.resolve(sha256(req.params['token'] ?? ''));
      if (!run) throw unauthenticated('This run endpoint is not valid any more');
      const body = McpRunCloseRequest.parse(req.body);
      const closed = await ctx.runs.close(run.runId, body.status);
      return json(CloseResponse.parse({ ok: true, closed }));
    }),
  });
}
