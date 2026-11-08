import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { BridgeAccount, BridgeSecretName, type BridgeProvider, type PutBridgeCredentialsRequest } from '@manythreads/shared';
import type { BridgeAccountRef } from './adapter.ts';

// One chat app account: reading its row, its sealed credentials and its counters. Credentials are read only by the system role, for the length of one call, and are never part of a
// route's answer, an event, a log line or an error.

export interface AccountRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider: BridgeProvider;
  status: 'off' | 'on' | 'attention';
  display_name: string;
  handle: string | null;
  external_app_id: string | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  inbound_count: string | number;
  outbound_count: string | number;
  dropped_count: string | number;
  last_error: string | null;
}

export const ACCOUNT_COLUMNS = `a.id, a.workspace_id, a.provider, a.status, a.display_name, a.handle, a.external_app_id, a.last_inbound_at, a.last_outbound_at,
  a.inbound_count, a.outbound_count, a.dropped_count, a.last_error`;

/** The path a chat service is told to call. */
export const callbackPath = (provider: BridgeProvider, accountId: string): string => `/hooks/bridges/${provider}/${accountId}`;

export async function loadAccount(tx: PluginTx, provider: BridgeProvider, accountId: string): Promise<AccountRow | null> {
  return (await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM app.bridge_accounts a WHERE a.id = $1::uuid AND a.provider = $2`, [accountId, provider])).rows[0] ?? null;
}

export async function loadAccountOf(tx: PluginTx, workspaceId: string, provider: BridgeProvider): Promise<AccountRow | null> {
  return (await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM app.bridge_accounts a WHERE a.workspace_id = $1::uuid AND a.provider = $2`, [workspaceId, provider])).rows[0] ?? null;
}

/** The credentials of an account, decrypted. Only in a system transaction. */
export async function readSecrets(ctx: PluginContext, sys: PluginTx, accountId: string): Promise<Partial<Record<BridgeSecretName, string>>> {
  const rows = (await sys.query<{ name: string; secret_id: string }>('SELECT name, secret_id FROM app.bridge_secrets WHERE account_id = $1::uuid', [accountId])).rows;
  const out: Partial<Record<BridgeSecretName, string>> = {};
  for (const r of rows) {
    const name = BridgeSecretName.safeParse(r.name);
    if (!name.success) continue;
    // a secret that cannot be opened is as good as missing: the account then refuses everything
    const value = await ctx.secrets.get(sys, r.secret_id).catch(() => null);
    if (value !== null) out[name.data] = value;
  }
  return out;
}

export async function accountRef(ctx: PluginContext, sys: PluginTx, row: AccountRow): Promise<BridgeAccountRef> {
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, handle: row.handle, externalAppId: row.external_app_id, secrets: await readSecrets(ctx, sys, row.id) };
}

const REQUEST_TO_SECRET = [
  ['botToken', 'bot_token'],
  ['appSecret', 'app_secret'],
  ['signingSecret', 'signing_secret'],
  ['inboundSecret', 'inbound_secret'],
] as const satisfies ReadonlyArray<readonly [keyof PutBridgeCredentialsRequest, BridgeSecretName]>;

/** Seals the given credentials (a missing field keeps the stored one) and drops the secrets they replace. System transaction. */
export async function putSecrets(ctx: PluginContext, sys: PluginTx, row: AccountRow, creds: PutBridgeCredentialsRequest): Promise<number> {
  let n = 0;
  for (const [field, name] of REQUEST_TO_SECRET) {
    const plaintext = creds[field];
    if (plaintext === undefined) continue;
    const old = (await sys.query<{ secret_id: string }>('SELECT secret_id FROM app.bridge_secrets WHERE account_id = $1::uuid AND name = $2 FOR UPDATE', [row.id, name])).rows[0];
    const secretId = await ctx.secrets.put(sys, plaintext);
    await sys.query(
      `INSERT INTO app.bridge_secrets (workspace_id, account_id, name, secret_id) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
       ON CONFLICT (account_id, name) DO UPDATE SET secret_id = EXCLUDED.secret_id`,
      [row.workspace_id, row.id, name, secretId],
    );
    if (old) await ctx.secrets.delete(sys, old.secret_id);
    n++;
  }
  return n;
}

/** Seals one named credential (the secret word we make for Telegram). */
export async function putSecret(ctx: PluginContext, sys: PluginTx, row: AccountRow, name: BridgeSecretName, plaintext: string): Promise<void> {
  const old = (await sys.query<{ secret_id: string }>('SELECT secret_id FROM app.bridge_secrets WHERE account_id = $1::uuid AND name = $2 FOR UPDATE', [row.id, name])).rows[0];
  const secretId = await ctx.secrets.put(sys, plaintext);
  await sys.query(
    `INSERT INTO app.bridge_secrets (workspace_id, account_id, name, secret_id) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
     ON CONFLICT (account_id, name) DO UPDATE SET secret_id = EXCLUDED.secret_id`,
    [row.workspace_id, row.id, name, secretId],
  );
  if (old) await ctx.secrets.delete(sys, old.secret_id);
}

/** Deletes every sealed credential of an account (it is being removed). */
export async function dropSecrets(ctx: PluginContext, sys: PluginTx, accountId: string): Promise<void> {
  const rows = (await sys.query<{ secret_id: string }>('DELETE FROM app.bridge_secrets WHERE account_id = $1::uuid RETURNING secret_id', [accountId])).rows;
  for (const r of rows) await ctx.secrets.delete(sys, r.secret_id);
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The admin's view of an account. Reads the credential names, the counts of linked people and channels. System transaction. */
export async function presentAccount(sys: PluginTx, row: AccountRow): Promise<BridgeAccount> {
  const secrets = (await sys.query<{ name: string }>('SELECT name FROM app.bridge_secrets WHERE account_id = $1::uuid ORDER BY name', [row.id])).rows
    .map((r) => BridgeSecretName.safeParse(r.name))
    .flatMap((p) => (p.success ? [p.data] : []));
  const counts = (
    await sys.query<{ people: string; channels: string }>(
      `SELECT (SELECT count(*) FROM app.bridge_identities WHERE account_id = $1::uuid) AS people, (SELECT count(*) FROM app.bridge_links WHERE account_id = $1::uuid) AS channels`,
      [row.id],
    )
  ).rows[0];
  return BridgeAccount.parse({
    id: row.id,
    provider: row.provider,
    status: row.status,
    displayName: row.display_name,
    handle: row.handle,
    secretsSet: secrets,
    callbackPath: callbackPath(row.provider, row.id),
    lastInboundAt: iso(row.last_inbound_at),
    lastOutboundAt: iso(row.last_outbound_at),
    inboundCount: Number(row.inbound_count),
    outboundCount: Number(row.outbound_count),
    droppedCount: Number(row.dropped_count),
    lastError: row.last_error,
    linkedPeople: Number(counts?.people ?? 0),
    linkedChannels: Number(counts?.channels ?? 0),
  });
}

/** Writes a plain sentence about why the account is in `attention`, or clears it. System transaction. */
export async function setAccountState(sys: PluginTx, accountId: string, state: { status?: 'on' | 'attention'; error: string | null }): Promise<void> {
  await sys.query('UPDATE app.bridge_accounts SET status = coalesce($2, status), last_error = $3 WHERE id = $1::uuid', [accountId, state.status ?? null, state.error === null ? null : state.error.slice(0, 400)]);
}
