import { createHash, randomBytes } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';

// The credentials the platform generates for a managed bot's profile (mode B), kept as secrets in `app.hermes_profile_secrets` (system-only):
//
//  * the MCP token — the bot's pairing token. The profile presents it at the platform's one MCP address (`/mcp`).
//  * the API server key — the key that authorises requests to the profile on the pod's gateway (`Authorization: Bearer`).
//
// Both are created on first use and then stable, so a controller that asks twice writes the same `.env`. A lead who revokes or rotates the
// bot's pairing tokens by hand (the bots page) turns the MCP token off; that is recorded (`revoked_at`) and the platform does NOT mint a
// replacement on its own — the profile stays out of the pod's set until a lead re-enables it (`reenableProfileSecrets`).
//
// Everything here takes the system transaction (`ctx.db.system`): a credential table is not readable by a request.

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const newToken = (): string => randomBytes(32).toString('base64url');
/** Hermes refuses an API server key shorter than 16 characters; 256 random bits are far over that. */
const newApiKey = (): string => `mtk_${randomBytes(32).toString('base64url')}`;

export interface ProfileSecretValues {
  mcpToken: string;
  apiKey: string;
  /** True when this call created a credential: the pod's `.env` is out of date. */
  changed: boolean;
}

/** The bot's token was turned off by a person and nobody has turned the profile back on. */
export interface ProfileRevoked {
  revoked: true;
}

interface SecretsRow extends Record<string, unknown> {
  bot_id: string;
  mcp_token_secret_id: string;
  api_key_secret_id: string;
  revoked_at: Date | null;
}

const mintPairing = async (tx: PluginTx, botId: string, token: string): Promise<void> => {
  await tx.query('SELECT minted_at FROM app.bots_pairing_mint($1::uuid, $2)', [botId, sha256(token)]);
};

type BotRef = { id: string; workspace_id: string; team_id: string };

/**
 * The credentials of a bot's profile, created on first use. Runs in its own system transaction scoped to the bot's workspace, so the secrets
 * it writes carry that workspace: the reference guard on tables that point at a secret (`workspace_refs_guard`) compares the secret's workspace with the
 * row's. That is a consistency check, not isolation: secrets are readable by the system role whatever their workspace.
 *
 * A token that has stopped working was turned off by a person (nothing else revokes one): that is recorded, and from then on the answer is
 * `{ revoked: true }` until `reenableProfileSecrets` is called. The platform never mints a replacement behind a person's back.
 */
export function ensureProfileSecrets(ctx: PluginContext, bot: BotRef): Promise<ProfileSecretValues | ProfileRevoked> {
  return ctx.db.system((tx) => ensureIn(ctx, tx, bot), { workspaceId: bot.workspace_id });
}

/** One caller at a time per bot: two first calls cannot each mint a token and leave one live and unrecorded. */
const lockBot = (tx: PluginTx, botId: string): Promise<unknown> => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hermes.profile-secrets:${botId}`]);

async function ensureIn(ctx: PluginContext, tx: PluginTx, bot: BotRef): Promise<ProfileSecretValues | ProfileRevoked> {
  await lockBot(tx, bot.id);
  const existing = (
    await tx.query<SecretsRow>('SELECT bot_id, mcp_token_secret_id, api_key_secret_id, revoked_at FROM app.hermes_profile_secrets WHERE bot_id = $1::uuid', [bot.id])
  ).rows[0];
  if (!existing) {
    const mcpToken = newToken();
    const apiKey = newApiKey();
    await mintPairing(tx, bot.id, mcpToken);
    const mcpSecret = await ctx.secrets.put(tx, mcpToken);
    const keySecret = await ctx.secrets.put(tx, apiKey);
    await tx.query(
      `INSERT INTO app.hermes_profile_secrets (bot_id, workspace_id, team_id, mcp_token_secret_id, api_key_secret_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      [bot.id, bot.workspace_id, bot.team_id, mcpSecret, keySecret],
    );
    return { mcpToken, apiKey, changed: true };
  }
  if (existing.revoked_at !== null) return { revoked: true };
  const mcpToken = await ctx.secrets.get(tx, existing.mcp_token_secret_id);
  const apiKey = await ctx.secrets.get(tx, existing.api_key_secret_id);
  const live = await tx.query('SELECT 1 FROM app.bots_pairing_resolve($1)', [sha256(mcpToken)]);
  if (live.rows.length > 0) return { mcpToken, apiKey, changed: false };
  await tx.query('UPDATE app.hermes_profile_secrets SET revoked_at = now() WHERE bot_id = $1::uuid', [bot.id]);
  return { revoked: true };
}

/** The explicit way back after a person turned the token off: a fresh MCP token, the same API key, the mark cleared. */
export function reenableProfileSecrets(ctx: PluginContext, bot: BotRef): Promise<boolean> {
  return ctx.db.system(async (tx) => {
    await lockBot(tx, bot.id);
    const existing = (
      await tx.query<SecretsRow>('SELECT bot_id, mcp_token_secret_id, api_key_secret_id, revoked_at FROM app.hermes_profile_secrets WHERE bot_id = $1::uuid', [bot.id])
    ).rows[0];
    if (!existing) return false;
    // Whatever was live is turned off first, so exactly one token works afterwards.
    await tx.query('SELECT app.bots_pairing_revoke($1::uuid)', [bot.id]);
    const fresh = newToken();
    await mintPairing(tx, bot.id, fresh);
    const secret = await ctx.secrets.put(tx, fresh);
    await tx.query('UPDATE app.hermes_profile_secrets SET mcp_token_secret_id = $2::uuid, revoked_at = NULL, rotated_at = now() WHERE bot_id = $1::uuid', [bot.id, secret]);
    await ctx.secrets.delete(tx, existing.mcp_token_secret_id);
    return true;
  }, { workspaceId: bot.workspace_id });
}

/** The key that authorises requests to a managed bot's profile, or null when none was generated yet. `tx` is a system transaction. */
export async function readProfileApiKey(ctx: PluginContext, tx: PluginTx, botId: string): Promise<string | null> {
  const row = (await tx.query<SecretsRow>('SELECT bot_id, mcp_token_secret_id, api_key_secret_id, revoked_at FROM app.hermes_profile_secrets WHERE bot_id = $1::uuid', [botId])).rows[0];
  return row ? ctx.secrets.get(tx, row.api_key_secret_id) : null;
}
