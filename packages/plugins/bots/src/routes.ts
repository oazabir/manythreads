import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  BotPairingPathParams,
  MintPairingTokenResponse,
  RotatePairingTokenResponse,
  rotatePairingTokenRoute,
  RevokePairingTokensResponse,
  mintPairingTokenRoute,
  revokePairingTokensRoute,
} from '@manythreads/shared';
import { conflict, forbidden, json, notFound, requireManage, requireTeam, route } from './http.ts';
import { mintPairingToken, revokePairingTokens } from './pairing.ts';

// The pairing routes (PLAN P5-04): a lead of the team mints the token a bot's runtime presents, and turns every live token of that bot
// off. The token is returned once; only its sha256 is stored. Resolving is not a route — the caller of a token hashes it and calls
// `app.bots_pairing_resolve` in its own transaction (docs/plugins/bots.md).

/**
 * The bot of the team, or 404: an unknown slug and one from another team answer the same, so a probe learns nothing. The workspace Brain belongs to no team and is found
 * through any team of its workspace; only a workspace owner or admin may pair it (there is no team lead to ask), anyone else is told no.
 */
async function requireBot(tx: PluginTx, team: { id: string; workspace_id: string }, botSlug: string): Promise<{ id: string; status: string }> {
  // A retired team Brain (the one the workspace Brain replaced, `retired_at` set, disabled) keeps its slug in the team: it must not hide the workspace bot of the same
  // slug, or the mint answers "this bot is disabled" for the Brain. A retired row answers only when no current bot of that name exists.
  const res = await tx.query<{ id: string; status: string }>('SELECT id, status FROM app.bots WHERE team_id = $1 AND slug = $2 AND retired_at IS NULL', [team.id, botSlug]);
  const bot = res.rows[0];
  if (bot) return bot;
  const shared = (
    await tx.query<{ id: string; status: string }>(`SELECT id, status FROM app.bots WHERE scope = 'workspace' AND team_id IS NULL AND workspace_id = $1 AND slug = $2`, [team.workspace_id, botSlug])
  ).rows[0];
  if (!shared) {
    const retired = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM app.bots WHERE team_id = $1 AND slug = $2', [team.id, botSlug])).rows[0];
    if (retired) return retired;
    throw notFound(`No bot "${botSlug}"`);
  }
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace admin can pair the workspace bot');
  return shared;
}

export function registerPairingRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...mintPairingTokenRoute,
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = await requireBot(tx, team, botSlug);
      // the definer function refuses too (55000); this is the clear answer. A token for a bot that cannot resolve would do nothing.
      if (bot.status !== 'active') {
        throw conflict(
          bot.status === 'disabled'
            ? 'This bot is disabled. Turn it on before pairing it.'
            : 'This bot\'s BOT.md is invalid. Fix the definition before pairing it.',
        );
      }
      const minted = await mintPairingToken(tx, bot.id);
      return json(MintPairingTokenResponse.parse({ token: minted.token, createdAt: minted.createdAt.toISOString() }), 201);
    }),
  });

  // Rotate: every live token off and one new one, in one transaction, so there is never a moment with two tokens that work or none (a Hermes
  // profile holding the old token loses access the moment the lead pastes the new one in).
  ctx.http.route({
    ...rotatePairingTokenRoute,
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = await requireBot(tx, team, botSlug);
      if (bot.status !== 'active') throw conflict('This bot is not active. Turn it on and fix its definition before pairing it.');
      const revoked = await revokePairingTokens(tx, bot.id);
      const minted = await mintPairingToken(tx, bot.id);
      await ctx.audit.emit(tx, { type: 'bots.pairing.rotated', workspaceId: team.workspace_id, teamId: team.id, botId: bot.id, actorId: tx.actor.id, revoked, at: ctx.runtime.now().toISOString() });
      return json(RotatePairingTokenResponse.parse({ token: minted.token, createdAt: minted.createdAt.toISOString(), revoked }), 201);
    }),
  });

  ctx.http.route({
    ...revokePairingTokensRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotPairingPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = await requireBot(tx, team, botSlug);
      return json(RevokePairingTokensResponse.parse({ revoked: await revokePairingTokens(tx, bot.id) }));
    }),
  });
}
