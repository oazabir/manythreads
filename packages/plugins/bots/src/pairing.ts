import { createHash, randomBytes } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';

// The pairing credential (SPEC §7.6, PLAN P5-04): a bot never holds one — its runtime holds a pairing token, and the database keeps only
// the token's sha256. Minting and revoking go through the SECURITY DEFINER functions of migration 0002 (bot_pairing_tokens has no app
// GRANT); resolving is the same door the gateway of P5-09 and a rules run use: hash the presented token, call
// `app.bots_pairing_resolve`, act on the ids it answers.

/** 256 random bits, base64url. Shown once; never stored, never returned again. */
export const newPairingToken = (): string => randomBytes(32).toString('base64url');

/** What the database stores and what resolve compares: sha256 of the token's utf8 bytes. */
export const hashPairingToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** The ids behind a presented pairing token: the bot, its team and workspace, and the bot's actor row. */
export interface PairedBot {
  botId: string;
  teamId: string;
  workspaceId: string;
  actorId: string;
  slug: string;
}

/**
 * Mint one pairing token for a bot. The caller's route has already checked `manage`; the definer function checks again (a caller
 * reaching this through another path gets 42501, which `route` turns into 403).
 */
export async function mintPairingToken(tx: PluginTx, botId: string): Promise<{ token: string; createdAt: Date }> {
  const token = newPairingToken();
  const res = await tx.query<{ minted_at: Date }>('SELECT minted_at FROM app.bots_pairing_mint($1, $2)', [botId, hashPairingToken(token)]);
  const minted = res.rows[0];
  if (!minted) throw new Error('the pairing mint answered no row');
  return { token, createdAt: minted.minted_at };
}

/** Turn every live token of a bot off; answers how many went (0 when there were none). */
export async function revokePairingTokens(tx: PluginTx, botId: string): Promise<number> {
  const res = await tx.query<{ revoked: string | number }>('SELECT app.bots_pairing_revoke($1) AS revoked', [botId]);
  return Number(res.rows[0]?.revoked ?? 0);
}

/**
 * Resolve a presented token to its bot actor: null for an unknown, revoked or malformed token — one answer for all three, so a probe
 * cannot tell which it hit. Callable from any plugin's own transaction (the function, not this wrapper, is the contract: plugins never
 * import each other, they share the `app` schema).
 */
export async function resolvePairingToken(tx: PluginTx, token: string): Promise<PairedBot | null> {
  const res = await tx.query<{ bot_id: string; team_id: string; workspace_id: string; actor_id: string; slug: string }>(
    'SELECT * FROM app.bots_pairing_resolve($1)',
    [hashPairingToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { botId: row.bot_id, teamId: row.team_id, workspaceId: row.workspace_id, actorId: row.actor_id, slug: row.slug };
}
