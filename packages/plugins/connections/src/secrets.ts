import type { PluginDb, PluginTx, SecretService } from '@manythreads/sdk';

// The credentials of a connection (PLAN P8-01). They are sealed by the platform's own secret service (`ctx.secrets`, the kernel's envelope encryption: a fresh key
// per secret, wrapped by the master key; this plugin has no cipher of its own), and `app.connection_secrets` only points at the sealed row.
//
// The rules this file keeps, and the reviewer should check:
//   * a credential goes in through `putConnectionSecret` and comes out through `readConnectionSecret` — and only inside this plugin, to the kind that needs it
//     for one call. No route, event, audit row, log line or error message carries one, and no function here returns one to a caller that did not ask by name;
//   * both run as the system role (the table is system-only and `get` refuses any other transaction), scoped to the one workspace of the connection;
//   * a failure never includes the value: errors here name the connection and the credential's name, nothing else.

export interface SecretDeps {
  db: Pick<PluginDb, 'system'>;
  secrets: SecretService;
}

/** The longest credential accepted: a service-account key file is the biggest thing stored today. */
export const MAX_SECRET_LENGTH = 16_384;

/** Stores (or replaces) one credential inside a system transaction the caller already holds (a token refresh keeps its row lock across the swap). */
export async function putConnectionSecretIn(
  secrets: SecretService,
  tx: PluginTx,
  input: { workspaceId: string; connectionId: string; name: string; plaintext: string },
): Promise<void> {
  if (input.plaintext.length === 0 || input.plaintext.length > MAX_SECRET_LENGTH) throw new Error(`the credential "${input.name}" must be between 1 and ${MAX_SECRET_LENGTH} characters`);
  const own = await tx.query('SELECT 1 FROM app.connections WHERE id = $1 AND workspace_id = $2', [input.connectionId, input.workspaceId]);
  if (own.rows.length === 0) throw new Error('that connection does not exist in this workspace');
  const old = await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.connection_secrets WHERE connection_id = $1 AND name = $2', [input.connectionId, input.name]);
  const secretId = await secrets.put(tx, input.plaintext);
  if (old.rows[0]) {
    await tx.query('UPDATE app.connection_secrets SET secret_id = $3 WHERE connection_id = $1 AND name = $2', [input.connectionId, input.name, secretId]);
    await secrets.delete(tx, old.rows[0].secret_id);
  } else {
    await tx.query('INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, $3, $4)', [input.workspaceId, input.connectionId, input.name, secretId]);
  }
}

/** Stores (or replaces) one credential of a connection. Fails closed: an unknown connection, a connection of another workspace or an empty value stores nothing. */
export async function putConnectionSecret(deps: SecretDeps, input: { workspaceId: string; connectionId: string; name: string; plaintext: string }): Promise<void> {
  await deps.db.system((tx) => putConnectionSecretIn(deps.secrets, tx, input), { workspaceId: input.workspaceId });
}

/** Decrypts one credential inside a system transaction the caller already holds. Null when the connection has none of that name. */
export async function readConnectionSecretIn(secrets: SecretService, tx: PluginTx, input: { workspaceId: string; connectionId: string; name: string }): Promise<string | null> {
  const row = (
    await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.connection_secrets WHERE connection_id = $1 AND workspace_id = $2 AND name = $3', [
      input.connectionId,
      input.workspaceId,
      input.name,
    ])
  ).rows[0];
  return row ? secrets.get(tx, row.secret_id) : null;
}

/** Decrypts one credential, for the kind that is making one call. Undefined-safe: a credential that is not stored throws, it never answers an empty string. */
export async function readConnectionSecret(deps: SecretDeps, input: { workspaceId: string; connectionId: string; name: string }): Promise<string> {
  const value = await deps.db.system((tx) => readConnectionSecretIn(deps.secrets, tx, input), { workspaceId: input.workspaceId });
  if (value === null) throw new Error(`the connection has no credential called "${input.name}"`);
  return value;
}

/**
 * Removes a connection together with every sealed credential it holds, in one transaction (the table's policy lets only the system role delete a connection, so a
 * sealed value can never outlive the row that pointed at it). False when there was no such connection in that workspace.
 */
export async function deleteConnectionAndSecrets(deps: SecretDeps, input: { workspaceId: string; connectionId: string }): Promise<boolean> {
  return deps.db.system(
    async (tx) => {
      const held = await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.connection_secrets WHERE connection_id = $1 AND workspace_id = $2', [input.connectionId, input.workspaceId]);
      const gone = await tx.query('DELETE FROM app.connections WHERE id = $1 AND workspace_id = $2 RETURNING id', [input.connectionId, input.workspaceId]);
      for (const row of held.rows) await deps.secrets.delete(tx, row.secret_id);
      return gone.rows.length > 0;
    },
    { workspaceId: input.workspaceId },
  );
}
