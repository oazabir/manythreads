import type { PluginTx } from '@manythreads/sdk';
import type { PersonProviderId } from '@manythreads/shared';
import { isUsable } from '../rows.ts';
import { deleteConnectionAndSecrets, putConnectionSecretIn, readConnectionSecretIn, type SecretDeps } from '../secrets.ts';
import { OAuthError, refreshAccess, revokeToken, sha256, type FetchLike, type TokenSet } from './flow.ts';
import { resolveApp, resolveAppIn } from './apps.ts';
import { endpointsFor, providerDef, type Env } from './providers.ts';

// Where a person's provider sign-in lives in the database (PLAN P8-02): the unfinished sign-ins, the connection row of the person and what is known about it, and the
// sealed tokens. Everything here runs as the system role inside one workspace (the credential tables give the application role nothing), and every function takes the
// person's actor id as an argument that the CALLER read from the session or the run's own row, never from a request body.
//
// Two names for a person's connection: its `kind` and `slug` are both the provider's id (`google`), so a person has at most one per provider (a unique index of 0001) and
// signing in again to add a service updates that one row instead of making another.

export interface OAuthDeps extends SecretDeps {
  /** The server's clock (injectable in tests). */
  now(): Date;
  env: Env;
  /** Tests only: the HTTP call to the provider. */
  fetchImpl?: FetchLike | undefined;
  /**
   * Called (after the transaction that found it has committed) when a person's sign-in has stopped working for good, so they can be told to reconnect (notice.ts).
   * It is best effort: a failure here never changes the answer of the call that found the problem, and it is never given a token.
   */
  onNeedsReconnect?: ((input: { workspaceId: string; connectionId: string; provider: PersonProviderId }) => Promise<void>) | undefined;
}

/** The sign-in is no longer usable and the person must connect again (`needs_reconnect`), or never was (`not_connected`), or the provider is down (`unavailable`). */
export class ConnectionProblem extends Error {
  readonly code: 'needs_reconnect' | 'not_connected' | 'unavailable' | 'not_configured';
  constructor(code: ConnectionProblem['code'], message: string) {
    super(message);
    this.name = 'ConnectionProblem';
    this.code = code;
  }
}

/** How long a started sign-in may take before its state stops being accepted. */
export const FLOW_TTL_MS = 10 * 60_000;
/** An access token that stops working within this long is renewed before use. */
const REFRESH_SKEW_MS = 60_000;

// --- unfinished sign-ins --------------------------------------------------------------------------------------------------------------------------------

export async function recordFlow(
  deps: Pick<OAuthDeps, 'db' | 'now'>,
  input: { workspaceId: string; ownerId: string; provider: PersonProviderId; services: readonly string[]; state: string; verifier: string | null; returnTo: string },
): Promise<void> {
  const now = deps.now();
  await deps.db.system(
    async (tx) => {
      await tx.query('DELETE FROM app.connection_oauth_flows WHERE expires_at < $1', [now]);
      await tx.query(
        `INSERT INTO app.connection_oauth_flows (state_hash, workspace_id, owner_id, provider, services, code_verifier, return_to, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)`,
        [sha256(input.state), input.workspaceId, input.ownerId, input.provider, [...input.services], input.verifier, input.returnTo, now, new Date(now.getTime() + FLOW_TTL_MS)],
      );
    },
    { workspaceId: input.workspaceId },
  );
}

export type FlowRecord = {
  workspace_id: string;
  owner_id: string;
  provider: string;
  services: string[];
  code_verifier: string | null;
  return_to: string;
};

/** Takes a sign-in's row by its state, once: the row is gone after this whatever happens next. Null for a state nobody started, or one that ran out. */
export async function consumeFlow(deps: Pick<OAuthDeps, 'db' | 'now'>, workspaceId: string, state: string): Promise<FlowRecord | null> {
  return deps.db.system(
    async (tx) =>
      (
        await tx.query<FlowRecord>(
          `DELETE FROM app.connection_oauth_flows WHERE state_hash = $1 AND workspace_id = $2 AND expires_at > $3
           RETURNING workspace_id, owner_id, provider, services, code_verifier, return_to`,
          [sha256(state), workspaceId, deps.now()],
        )
      ).rows[0] ?? null,
    { workspaceId },
  );
}

// --- the connection and its tokens ----------------------------------------------------------------------------------------------------------------------

/** Scopes as the provider spelled them, in one spelling: Microsoft sometimes answers with the full `https://graph.microsoft.com/Mail.Read`. */
export const normalizeScope = (scope: string): string => scope.replace(/^https:\/\/graph\.microsoft\.com\//, '');

/**
 * Saves a finished sign-in: the person's connection (made, or switched back on), what they agreed to (added to what they agreed to before), and the sealed tokens, all in
 * one transaction. A refresh token that the provider did not send again is kept, not erased.
 */
export async function saveSignIn(
  deps: OAuthDeps,
  input: { workspaceId: string; ownerId: string; provider: PersonProviderId; label: string; tokens: TokenSet; requestedScopes: readonly string[]; accountLabel: string | null },
): Promise<{ connectionId: string; scopes: string[] }> {
  const now = deps.now();
  const granted = (input.tokens.scopes ?? input.requestedScopes).map(normalizeScope);
  return deps.db.system(
    async (tx) => {
      const existing = (
        await tx.query<{ id: string; scopes: string[] | null }>(
          `SELECT c.id, o.scopes FROM app.connections c LEFT JOIN app.connection_oauth o ON o.connection_id = c.id
            WHERE c.workspace_id = $1 AND c.owner_id = $2 AND c.scope = 'person' AND c.slug = $3 FOR UPDATE OF c`,
          [input.workspaceId, input.ownerId, input.provider],
        )
      ).rows[0];
      let connectionId: string;
      if (existing) {
        connectionId = existing.id;
        await tx.query(`UPDATE app.connections SET status = 'enabled', expires_at = NULL, updated_at = now() WHERE id = $1`, [connectionId]);
      } else {
        connectionId = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id, status)
             VALUES ($1, NULL, $2, $2, $3, 'person', $4, 'enabled') RETURNING id`,
            [input.workspaceId, input.provider, input.label, input.ownerId],
          )
        ).rows[0]!.id;
      }
      const scopes = [...new Set([...(existing?.scopes ?? []), ...granted])];
      const expiresAt = input.tokens.expiresInSec === null ? null : new Date(now.getTime() + input.tokens.expiresInSec * 1000);
      await tx.query(
        `INSERT INTO app.connection_oauth (connection_id, workspace_id, provider, scopes, account_label, access_expires_at, state, refreshed_at)
         VALUES ($1, $2, $3, $4::text[], $5, $6, 'ok', $7)
         ON CONFLICT (connection_id) DO UPDATE SET scopes = EXCLUDED.scopes, account_label = COALESCE(EXCLUDED.account_label, app.connection_oauth.account_label),
           access_expires_at = EXCLUDED.access_expires_at, state = 'ok', refreshed_at = EXCLUDED.refreshed_at,
           failures = 0, last_problem = NULL, notified_at = NULL`,
        [connectionId, input.workspaceId, input.provider, scopes, input.accountLabel, expiresAt, now],
      );
      await putConnectionSecretIn(deps.secrets, tx, { workspaceId: input.workspaceId, connectionId, name: 'access_token', plaintext: input.tokens.accessToken });
      if (input.tokens.refreshToken !== null) {
        await putConnectionSecretIn(deps.secrets, tx, { workspaceId: input.workspaceId, connectionId, name: 'refresh_token', plaintext: input.tokens.refreshToken });
      }
      return { connectionId, scopes };
    },
    { workspaceId: input.workspaceId },
  );
}

/** The provider refused the stored sign-in for good: switch the connection off and say the person has to connect again. Runs in the caller's system transaction. */
async function markDead(tx: PluginTx, connectionId: string): Promise<void> {
  await tx.query(`UPDATE app.connection_oauth SET state = 'needs_reconnect' WHERE connection_id = $1`, [connectionId]);
  await tx.query(`UPDATE app.connections SET status = 'disabled', updated_at = now() WHERE id = $1`, [connectionId]);
}

/**
 * The access token for a connection, renewed first when it is about to stop working. The renewal holds the connection's row for its whole length, so two calls at
 * once renew once (a provider that rotates refresh tokens would refuse the second use of the first one). `force` renews even when the clock says the token is fine: the
 * provider just answered 401 to it. `skewMs` is how close to its end a token may be before it is renewed (the renewal job uses a wide one, so a person's next call
 * never waits for a renewal). A provider that refuses the refresh token for good (`invalid_grant`) turns the connection off and asks the person to reconnect (once: see
 * `onNeedsReconnect`); any other failure is counted on the connection (`failures`, `last_problem`) and shown on the connections page, and the person is not bothered.
 */
export async function accessTokenFor(
  deps: OAuthDeps,
  connection: { id: string; workspaceId: string; provider: PersonProviderId },
  options: { force?: boolean; skewMs?: number } = {},
): Promise<string> {
  const def = providerDef(connection.provider);
  if (!def) throw new ConnectionProblem('not_connected', 'That connection is not one this server knows.');
  const skew = options.skewMs ?? REFRESH_SKEW_MS;
  const outcome = await deps.db.system(
    async (tx): Promise<{ token: string } | { dead: true } | { unavailable: true } | { missing: true }> => {
      const meta = (
        await tx.query<{ state: string; access_expires_at: Date | null }>(
          'SELECT state, access_expires_at FROM app.connection_oauth WHERE connection_id = $1 AND workspace_id = $2 FOR UPDATE',
          [connection.id, connection.workspaceId],
        )
      ).rows[0];
      if (!meta) return { missing: true };
      if (meta.state === 'needs_reconnect') return { dead: true };
      const read = (name: string): Promise<string | null> => readConnectionSecretIn(deps.secrets, tx, { workspaceId: connection.workspaceId, connectionId: connection.id, name });
      const fresh = options.force !== true && (meta.access_expires_at === null || meta.access_expires_at.getTime() - deps.now().getTime() > skew);
      if (fresh) {
        const token = await read('access_token');
        if (token !== null) return { token };
      }
      const refreshToken = def.refreshes ? await read('refresh_token') : null;
      if (refreshToken === null) {
        // nothing to renew with: a token that does not expire was refused (Notion), or the refresh token is gone
        await markDead(tx, connection.id);
        return { dead: true };
      }
      const app = await resolveAppIn(deps, tx, connection.workspaceId, connection.provider);
      // no app to renew with (an admin removed it): not the provider's fault and not the person's, so nothing is counted and the person is not told
      if (!app) return { unavailable: true };
      let tokens: TokenSet;
      try {
        tokens = await refreshAccess({ provider: def, endpoints: endpointsFor(connection.provider, deps.env, app.tenant), app, fetchImpl: deps.fetchImpl }, refreshToken);
      } catch (err) {
        if (err instanceof OAuthError && err.failure === 'invalid_grant') {
          await markDead(tx, connection.id);
          return { dead: true };
        }
        await tx.query('UPDATE app.connection_oauth SET failures = failures + 1, last_problem = $2 WHERE connection_id = $1', [
          connection.id,
          err instanceof OAuthError && err.failure === 'rejected' ? 'rejected' : 'unavailable',
        ]);
        return { unavailable: true };
      }
      const now = deps.now();
      await tx.query(`UPDATE app.connection_oauth SET access_expires_at = $2, refreshed_at = $3, state = 'ok', failures = 0, last_problem = NULL WHERE connection_id = $1`, [
        connection.id,
        tokens.expiresInSec === null ? null : new Date(now.getTime() + tokens.expiresInSec * 1000),
        now,
      ]);
      await putConnectionSecretIn(deps.secrets, tx, { workspaceId: connection.workspaceId, connectionId: connection.id, name: 'access_token', plaintext: tokens.accessToken });
      if (tokens.refreshToken !== null) {
        await putConnectionSecretIn(deps.secrets, tx, { workspaceId: connection.workspaceId, connectionId: connection.id, name: 'refresh_token', plaintext: tokens.refreshToken });
      }
      return { token: tokens.accessToken };
    },
    { workspaceId: connection.workspaceId },
  );
  if ('token' in outcome) return outcome.token;
  if ('dead' in outcome) {
    // the person is told once (the notifier claims `notified_at`); a failure to tell them never changes what this call answers
    try {
      await deps.onNeedsReconnect?.({ workspaceId: connection.workspaceId, connectionId: connection.id, provider: connection.provider });
    } catch {
      /* best effort: the connections page still says the sign-in has to be made again */
    }
    throw new ConnectionProblem('needs_reconnect', `Your ${def.label} connection stopped working. Connect it again from your connections page.`);
  }
  if ('missing' in outcome) throw new ConnectionProblem('not_connected', `You have not connected ${def.label}.`);
  throw new ConnectionProblem('unavailable', `${def.label} could not be reached to renew the sign-in. Try again in a moment.`);
}

/**
 * Ends a person's connection to a provider: the provider is told to forget the token (best effort), then the connection and every sealed token go. False when the
 * person had none.
 */
export async function disconnectPerson(deps: OAuthDeps, input: { workspaceId: string; ownerId: string; provider: PersonProviderId }): Promise<boolean> {
  const def = providerDef(input.provider);
  if (!def) return false;
  const id = await deps.db.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(`SELECT id FROM app.connections WHERE workspace_id = $1 AND owner_id = $2 AND scope = 'person' AND slug = $3`, [
          input.workspaceId,
          input.ownerId,
          input.provider,
        ])
      ).rows[0]?.id ?? null,
    { workspaceId: input.workspaceId },
  );
  if (!id) return false;
  const held = await revocableToken(deps, { workspaceId: input.workspaceId, connectionId: id });
  await deleteConnectionAndSecrets(deps, { workspaceId: input.workspaceId, connectionId: id });
  if (held) await revokeAtProvider(deps, { workspaceId: input.workspaceId, provider: input.provider, token: held.token });
  return true;
}

/**
 * Asks the provider to forget a token (a person disconnected, or a connection was deleted). Best effort and silent: the token is already gone from our side by then, and
 * a provider that is down or has no revoke address must not stop that. The token goes only in the request, never into an error or a log line.
 */
export async function revokeAtProvider(deps: OAuthDeps, input: { workspaceId: string; provider: PersonProviderId; token: string }): Promise<void> {
  const def = providerDef(input.provider);
  if (!def) return;
  try {
    const app = await resolveApp(deps, input.workspaceId, input.provider);
    if (!app) return;
    await revokeToken({ provider: def, endpoints: endpointsFor(input.provider, deps.env, app.tenant), app, fetchImpl: deps.fetchImpl }, input.token);
  } catch {
    /* best effort */
  }
}

/**
 * The token to revoke for a person's OAuth connection (the refresh token, or the access token of a provider that has no refresh token), read BEFORE the connection is
 * deleted. Null when the connection is not a person's sign-in or holds no token.
 */
export async function revocableToken(deps: OAuthDeps, input: { workspaceId: string; connectionId: string }): Promise<{ provider: PersonProviderId; token: string } | null> {
  return deps.db.system(
    async (tx) => {
      const row = (await tx.query<{ provider: string }>('SELECT provider FROM app.connection_oauth WHERE connection_id = $1 AND workspace_id = $2', [input.connectionId, input.workspaceId])).rows[0];
      const def = row ? providerDef(row.provider) : undefined;
      if (!def) return null;
      const token = await readConnectionSecretIn(deps.secrets, tx, { workspaceId: input.workspaceId, connectionId: input.connectionId, name: def.refreshes ? 'refresh_token' : 'access_token' });
      return token === null ? null : { provider: def.id, token };
    },
    { workspaceId: input.workspaceId },
  );
}

// --- reading a person's connection ---------------------------------------------------------------------------------------------------------------------

export interface PersonConnectionState {
  id: string;
  status: 'enabled' | 'disabled';
  scopes: string[];
  accountLabel: string | null;
  state: 'ok' | 'needs_reconnect';
  /** The last renewal failed and none has worked since. */
  problem: 'unavailable' | 'rejected' | null;
  refreshedAt: Date | null;
}

/** The caller's own connections, by provider id. `tx` is the person's: row-level security shows them nobody else's. */
export async function ownConnections(tx: PluginTx, ownerId: string): Promise<Map<string, PersonConnectionState>> {
  const rows = await tx.query<{
    id: string;
    slug: string;
    status: 'enabled' | 'disabled';
    scopes: string[];
    account_label: string | null;
    state: 'ok' | 'needs_reconnect';
    last_problem: 'unavailable' | 'rejected' | null;
    refreshed_at: Date | null;
  }>(
    `SELECT c.id, c.slug, c.status, o.scopes, o.account_label, o.state, o.last_problem, o.refreshed_at
       FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
      WHERE c.scope = 'person' AND c.owner_id = $1`,
    [ownerId],
  );
  return new Map(
    rows.rows.map((r) => [r.slug, { id: r.id, status: r.status, scopes: r.scopes, accountLabel: r.account_label, state: r.state, problem: r.last_problem, refreshedAt: r.refreshed_at }]),
  );
}

export interface UsablePersonConnection {
  id: string;
  scopes: string[];
}

/**
 * The asker's connection to a provider, when it can be used right now (on, not expired, has a token, not waiting to be reconnected). Read as the system role keyed by the
 * asker's actor id: a bot's own transaction cannot see a person's connection (and must not), so the run's asker, read from the run's row by the caller, is the only key.
 */
export async function usablePersonConnection(
  deps: Pick<OAuthDeps, 'db'>,
  input: { workspaceId: string; ownerId: string; provider: string },
): Promise<UsablePersonConnection | null> {
  return deps.db.system(
    async (tx) => {
      const row = (
        await tx.query<{ id: string; status: 'enabled' | 'disabled'; has_credentials: boolean; expired: boolean; scopes: string[]; state: string }>(
          `SELECT c.id, c.status, c.has_credentials, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired, o.scopes, o.state
             FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
            WHERE c.workspace_id = $1 AND c.scope = 'person' AND c.owner_id = $2 AND c.slug = $3`,
          [input.workspaceId, input.ownerId, input.provider],
        )
      ).rows[0];
      return row && isUsable(row) && row.state === 'ok' ? { id: row.id, scopes: row.scopes } : null;
    },
    { workspaceId: input.workspaceId },
  );
}
