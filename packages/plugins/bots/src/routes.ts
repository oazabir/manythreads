import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  BotPairingPathParams,
  MintPairingTokenResponse,
  RevokePairingTokensResponse,
  mintPairingTokenRoute,
  revokePairingTokensRoute,
} from '@manythreads/shared';
import { json, notFound, requireManage, requireTeam, route } from './http.ts';
import { mintPairingToken, revokePairingTokens } from './pairing.ts';

// The pairing routes (PLAN P5-04): a lead of the team mints the token a bot's runtime presents, and turns every live token of that bot
// off. The token is returned once; only its sha256 is stored. Resolving is not a route — the caller of a token hashes it and calls
// `app.bots_pairing_resolve` in its own transaction (docs/plugins/bots.md).

/** The bot of the team, or 404: an unknown slug and one from another team answer the same, so a probe learns nothing. */
async function requireBot(tx: PluginTx, teamId: string, botSlug: string): Promise<string> {
  const res = await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [teamId, botSlug]);
  const id = res.rows[0]?.id;
  if (!id) throw notFound(`No bot "${botSlug}"`);
  return id;
}

export function registerPairingRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...mintPairingTokenRoute,
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const botId = await requireBot(tx, team.id, botSlug);
      const minted = await mintPairingToken(tx, botId);
      return json(MintPairingTokenResponse.parse({ token: minted.token, createdAt: minted.createdAt.toISOString() }), 201);
    }),
  });

  ctx.http.route({
    ...revokePairingTokensRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const botId = await requireBot(tx, team.id, botSlug);
      return json(RevokePairingTokensResponse.parse({ revoked: await revokePairingTokens(tx, botId) }));
    }),
  });
}
