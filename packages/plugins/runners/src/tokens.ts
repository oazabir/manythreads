import { createHash, randomBytes } from 'node:crypto';
import { RUNNER_TOKEN_PREFIX } from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';

// The runner credential (SPEC §7.4, PLAN P6-06), the same scheme as a bot's pairing token (bots/src/pairing.ts): the program on the machine
// holds the token, the database keeps only its sha256. Minting and revoking go through the SECURITY DEFINER functions of migration 0001
// (`runner_tokens` has no privilege for the app role); resolving happens in the connection route, as the system role.

/** `mtr_` and 256 random bits, base64url. Shown once; never stored, never returned again. */
export const newRunnerToken = (): string => `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

/** What the database stores and what resolve compares: sha256 of the token's utf8 bytes. */
export const hashRunnerToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** The bearer token of an `Authorization` header, or null when it is missing, another scheme, or not shaped like a runner token. */
export function bearerRunnerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+(mtr_[A-Za-z0-9_-]{20,200})[ \t]*$/.exec(header);
  return match?.[1] ?? null;
}

export async function mintRunnerToken(tx: PluginTx, runnerId: string): Promise<{ token: string; createdAt: Date }> {
  const token = newRunnerToken();
  const res = await tx.query<{ minted_at: Date }>('SELECT minted_at FROM app.runners_token_mint($1::uuid, $2)', [runnerId, hashRunnerToken(token)]);
  const minted = res.rows[0];
  if (!minted) throw new Error('the runner token mint answered no row');
  return { token, createdAt: minted.minted_at };
}

/** Turn every live token of a runner off; answers how many went (0 when there were none). */
export async function revokeRunnerTokens(tx: PluginTx, runnerId: string): Promise<number> {
  const res = await tx.query<{ revoked: string | number }>('SELECT app.runners_token_revoke($1::uuid) AS revoked', [runnerId]);
  return Number(res.rows[0]?.revoked ?? 0);
}

/** The runner behind a presented token (system transaction): null for an unknown or revoked one, one answer for both. */
export interface ResolvedRunner {
  tokenId: string;
  runnerId: string;
  name: string;
  teamId: string;
  teamSlug: string;
  workspaceId: string;
}

export async function resolveRunnerToken(tx: PluginTx, token: string): Promise<ResolvedRunner | null> {
  const res = await tx.query<{ token_id: string; runner_id: string; name: string; team_id: string; slug: string; workspace_id: string }>(
    `SELECT k.id AS token_id, r.id AS runner_id, r.name, r.team_id, t.slug, r.workspace_id
       FROM app.runner_tokens k
       JOIN app.runners r ON r.id = k.runner_id
       JOIN app.teams t ON t.id = r.team_id
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND t.archived_at IS NULL`,
    [hashRunnerToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { tokenId: row.token_id, runnerId: row.runner_id, name: row.name, teamId: row.team_id, teamSlug: row.slug, workspaceId: row.workspace_id };
}

/** Whether a token (by its row id) is still live: asked on every heartbeat, so a revoked token ends its connection within a beat. */
export async function tokenIsLive(tx: PluginTx, tokenId: string): Promise<boolean> {
  const res = await tx.query('SELECT 1 FROM app.runner_tokens WHERE id = $1::uuid AND revoked_at IS NULL', [tokenId]);
  return res.rows.length > 0;
}
