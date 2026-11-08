import { randomBytes } from 'node:crypto';
import { forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  BridgeAccountResponse,
  BridgeProviderParams,
  DeleteBridgeAccountResponse,
  ListBridgeAccountsResponse,
  ListConnectorHealthResponse,
  PutBridgeAccountRequest,
  PutBridgeCredentialsRequest,
  SwitchBridgeRequest,
  abuseLimit,
  bridgesHealthRoute,
  deleteBridgeAccountRoute,
  listBridgeAccountsRoute,
  putBridgeAccountRoute,
  putBridgeCredentialsRoute,
  switchBridgeRoute,
  type BridgeAccount,
  type BridgeProvider,
} from '@manythreads/shared';
import { ACCOUNT_COLUMNS, accountRef, callbackPath, dropSecrets, loadAccountOf, presentAccount, putSecret, putSecrets, type AccountRow } from './accounts.ts';
import { BRIDGE_ADAPTERS } from './adapters/index.ts';
import { BridgeSendError } from './door.ts';

// The workspace admin's side (PLAN Bundle D, P16-09): make the account of a service, put its credentials in (sealed, never read back), switch it on (the service is told where to send events) or
// off, remove it, and read its health. Workspace owners and admins only; the table's row-level security says the same.

/** Which credential fields a service takes. A field that does not belong is refused, so a pasted secret never sits unused. */
const CREDENTIAL_FIELDS: Readonly<Record<BridgeProvider, ReadonlyArray<keyof PutBridgeCredentialsRequest>>> = {
  telegram: ['botToken'],
  whatsapp: ['botToken', 'appSecret', 'inboundSecret'],
  slack: ['botToken', 'signingSecret'],
  // the Teams client secret is stored as the account's `bot_token`: it is the one credential the bot calls out with, and the database guard asks every account for one
  teams: ['botToken'],
};

const TELEGRAM_TOKEN = /^[0-9]{3,20}:[A-Za-z0-9_-]{16,}$/;
const SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

async function requireAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.lookup_workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace admin can set up chat apps');
}

/** A plain sentence for what went wrong at the service (never the service's own text, which can carry an address or an id). */
function sentenceFor(err: unknown): string {
  if (err instanceof BridgeSendError) {
    if (err.attention) return 'The chat app did not accept the token. Check it and try again.';
    if (err.retry) return 'The chat app could not be reached just now. Try again in a minute.';
    return err.message.slice(0, 200);
  }
  return 'The chat app could not be set up.';
}

export function registerAdminRoutes(ctx: PluginContext): void {
  const audit = (tx: PluginTx, row: Pick<AccountRow, 'id' | 'workspace_id' | 'provider'>, change: 'created' | 'updated' | 'switched' | 'credential_set' | 'deleted', status: 'off' | 'on' | 'attention'): Promise<void> =>
    ctx.audit.emit(tx, { type: 'bridges.account.changed', workspaceId: row.workspace_id, accountId: row.id, provider: row.provider, change, status, actorId: tx.actor.id, at: now(ctx) });
  const present = (row: AccountRow, tx: PluginTx): Promise<BridgeAccount> => ctx.db.system((sys) => presentAccount(sys, row), { workspaceId: tx.actor.workspaceId });
  const required = async (tx: PluginTx, provider: BridgeProvider): Promise<AccountRow> => {
    const row = await loadAccountOf(tx, tx.actor.workspaceId, provider);
    if (!row) throw notFound('Set this chat app up first: give it a name');
    return row;
  };

  ctx.http.route({
    ...listBridgeAccountsRoute,
    schema: { response: ListBridgeAccountsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      const rows = (await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM app.bridge_accounts a WHERE a.workspace_id = $1::uuid ORDER BY a.provider`, [tx.actor.workspaceId])).rows;
      const accounts = await ctx.db.system(async (sys) => Promise.all(rows.map((r) => presentAccount(sys, r))), { workspaceId: tx.actor.workspaceId });
      return json(ListBridgeAccountsResponse.parse({ accounts }));
    }),
  });

  ctx.http.route({
    ...putBridgeAccountRoute,
    schema: { body: PutBridgeAccountRequest, response: BridgeAccountResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = BridgeProviderParams.parse(req.params);
      const body = PutBridgeAccountRequest.parse(req.body);
      // the app id of Teams is what every incoming call is checked against: it must be the id Azure shows (a GUID)
      if (provider === 'teams' && body.externalAppId != null && !GUID.test(body.externalAppId)) throw invalid('That does not look like an application (client) id. It is the long id with dashes that Azure shows for the bot.');
      const before = await loadAccountOf(tx, tx.actor.workspaceId, provider);
      const keepHandle = body.handle === undefined;
      const keepApp = body.externalAppId === undefined;
      const res = await tx.query<AccountRow>(
        `INSERT INTO app.bridge_accounts AS a (workspace_id, provider, display_name, handle, external_app_id) VALUES ($1::uuid, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET display_name = EXCLUDED.display_name,
           handle = CASE WHEN $6::boolean THEN a.handle ELSE EXCLUDED.handle END,
           external_app_id = CASE WHEN $7::boolean THEN a.external_app_id ELSE EXCLUDED.external_app_id END
         RETURNING ${ACCOUNT_COLUMNS}`,
        [tx.actor.workspaceId, provider, body.displayName, body.handle ?? null, body.externalAppId ?? null, keepHandle, keepApp],
      );
      const row = res.rows[0]!;
      await audit(tx, row, before ? 'updated' : 'created', row.status);
      return json(BridgeAccountResponse.parse({ account: await present(row, tx) }), before ? 200 : 201);
    }),
  });

  ctx.http.route({
    ...putBridgeCredentialsRoute,
    schema: { body: PutBridgeCredentialsRequest, response: BridgeAccountResponse },
    rateLimit: abuseLimit('PUT', putBridgeCredentialsRoute.path),
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = BridgeProviderParams.parse(req.params);
      const creds = PutBridgeCredentialsRequest.parse(req.body);
      const allowed = CREDENTIAL_FIELDS[provider];
      for (const key of Object.keys(creds)) if (!allowed.includes(key as keyof PutBridgeCredentialsRequest)) throw invalid(`That credential does not belong to this chat app (${key})`);
      if (provider === 'telegram' && creds.botToken !== undefined && !TELEGRAM_TOKEN.test(creds.botToken)) throw invalid('That does not look like a Telegram bot token. It looks like 123456789:ABC… and comes from BotFather.');
      if (provider === 'slack' && creds.botToken !== undefined && !SLACK_BOT_TOKEN.test(creds.botToken)) throw invalid('That does not look like a Slack bot token. It starts with xoxb- and is under OAuth & Permissions in your Slack app.');
      const row = await required(tx, provider);
      await ctx.db.system((sys) => putSecrets(ctx, sys, row, creds), { workspaceId: row.workspace_id });
      // a new token or secret changes who the service talks to: the app is switched off until the admin switches it on again (which tells the service again)
      let status = row.status;
      if (row.status !== 'off' && (creds.botToken !== undefined || creds.appSecret !== undefined || creds.inboundSecret !== undefined || creds.signingSecret !== undefined)) {
        await tx.query(`UPDATE app.bridge_accounts SET status = 'off', last_error = NULL WHERE id = $1::uuid`, [row.id]);
        status = 'off';
      }
      await audit(tx, row, 'credential_set', status);
      const fresh = (await loadAccountOf(tx, row.workspace_id, provider)) ?? row;
      return json(BridgeAccountResponse.parse({ account: await present(fresh, tx) }));
    }),
  });

  ctx.http.route({
    ...switchBridgeRoute,
    schema: { body: SwitchBridgeRequest, response: BridgeAccountResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = BridgeProviderParams.parse(req.params);
      const { on } = SwitchBridgeRequest.parse(req.body);
      const row = await required(tx, provider);
      const adapter = BRIDGE_ADAPTERS[provider];
      // the credentials are read in a short transaction of their own; the service is called with none open
      const prepared = await ctx.db.system(
        async (sys) => {
          let ref = await accountRef(ctx, sys, row);
          if (on && provider === 'telegram' && !ref.secrets.inbound_secret) {
            // Telegram sends back the word we choose; the admin never types it
            await putSecret(ctx, sys, row, 'inbound_secret', randomBytes(32).toString('base64url'));
            ref = await accountRef(ctx, sys, row);
          }
          return ref;
        },
        { workspaceId: row.workspace_id },
      );
      if (!on) {
        if (row.status === 'on' && adapter.disconnect) await adapter.disconnect(prepared).catch(() => undefined);
        await tx.query(`UPDATE app.bridge_accounts SET status = 'off', last_error = NULL WHERE id = $1::uuid`, [row.id]);
        await audit(tx, row, 'switched', 'off');
        return json(BridgeAccountResponse.parse({ account: await present({ ...row, status: 'off', last_error: null }, tx) }));
      }
      const secrets = prepared.secrets;
      const missing =
        provider === 'teams'
          ? !prepared.externalAppId || !secrets.bot_token
            ? 'Add the application id and the client secret first.'
            : null
          : provider === 'slack'
            ? !secrets.bot_token || !secrets.signing_secret
              ? 'Add the bot token and the signing secret first.'
              : null
            : !secrets.bot_token
              ? 'Add the token first.'
              : provider === 'whatsapp' && (!secrets.app_secret || !secrets.inbound_secret || !prepared.externalAppId)
                ? 'Add the phone number id, the app secret and the verify word first.'
                : null;
      if (missing !== null) {
        await tx.query('UPDATE app.bridge_accounts SET last_error = $2 WHERE id = $1::uuid', [row.id, missing]);
        return json(BridgeAccountResponse.parse({ account: await present({ ...row, last_error: missing }, tx) }));
      }
      let learned: { handle: string | null; externalAppId: string | null } = { handle: row.handle, externalAppId: row.external_app_id };
      let failure: string | null = null;
      try {
        if (adapter.connect) learned = await adapter.connect(prepared, `${ctx.runtime.publicUrl.replace(/\/+$/, '')}${callbackPath(provider, row.id)}`);
      } catch (err) {
        failure = sentenceFor(err);
      }
      if (failure !== null) {
        await tx.query('UPDATE app.bridge_accounts SET last_error = $2 WHERE id = $1::uuid', [row.id, failure]);
        await audit(tx, row, 'switched', row.status);
        return json(BridgeAccountResponse.parse({ account: await present({ ...row, last_error: failure }, tx) }));
      }
      const res = await tx.query<AccountRow>(
        `UPDATE app.bridge_accounts a SET status = 'on', last_error = NULL, handle = coalesce($2, a.handle), external_app_id = coalesce($3, a.external_app_id) WHERE a.id = $1::uuid RETURNING ${ACCOUNT_COLUMNS}`,
        [row.id, learned.handle, learned.externalAppId],
      );
      await audit(tx, row, 'switched', 'on');
      return json(BridgeAccountResponse.parse({ account: await present(res.rows[0]!, tx) }));
    }),
  });

  ctx.http.route({
    ...deleteBridgeAccountRoute,
    schema: { response: DeleteBridgeAccountResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { provider } = BridgeProviderParams.parse(req.params);
      const row = await required(tx, provider);
      const links = (await tx.query<{ id: string; team_id: string; channel_id: string }>('SELECT id, team_id, channel_id FROM app.bridge_links WHERE account_id = $1::uuid', [row.id])).rows;
      const adapter = BRIDGE_ADAPTERS[provider];
      const ref = row.status === 'on' && adapter.disconnect ? await ctx.db.system((sys) => accountRef(ctx, sys, row), { workspaceId: row.workspace_id }) : null;
      if (ref && adapter.disconnect) await adapter.disconnect(ref).catch(() => undefined);
      await ctx.db.system((sys) => dropSecrets(ctx, sys, row.id), { workspaceId: row.workspace_id });
      for (const l of links) {
        await ctx.audit.emit(tx, {
          type: 'bridges.channel.unlinked',
          workspaceId: row.workspace_id,
          teamId: l.team_id,
          channelId: l.channel_id,
          accountId: row.id,
          linkId: l.id,
          provider,
          actorId: tx.actor.id,
          reason: 'account_removed',
          at: now(ctx),
        });
      }
      await tx.query('DELETE FROM app.bridge_accounts WHERE id = $1::uuid', [row.id]);
      await audit(tx, row, 'deleted', 'off');
      return json(DeleteBridgeAccountResponse.parse({ removed: true }));
    }),
  });

  ctx.http.route({
    ...bridgesHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      const rows = await ctx.db.system(
        async (sys) =>
          (
            await sys.query<{
              provider: string;
              status: string;
              last_error: string | null;
              people: string;
              channels: string;
              calls: string;
              failed: string;
              unverified: string;
              last_used: Date | null;
            }>(
              `SELECT a.provider, a.status, a.last_error,
                      (SELECT count(*) FROM app.bridge_identities i WHERE i.account_id = a.id) AS people,
                      (SELECT count(*) FROM app.bridge_links l WHERE l.account_id = a.id) AS channels,
                      (SELECT count(*) FROM app.bridge_messages m WHERE m.account_id = a.id AND m.created_at > now() - interval '7 days') AS calls,
                      (SELECT count(*) FROM app.bridge_messages m WHERE m.account_id = a.id AND m.status = 'dead' AND m.created_at > now() - interval '7 days') AS failed,
                      (SELECT coalesce(sum(u.dropped_count), 0) FROM app.bridge_unlinked_chats u WHERE u.account_id = a.id AND u.last_seen_at > now() - interval '7 days') AS unverified,
                      greatest(a.last_inbound_at, a.last_outbound_at) AS last_used
                 FROM app.bridge_accounts a WHERE a.workspace_id = $1::uuid ORDER BY a.provider`,
              [tx.actor.workspaceId],
            )
          ).rows,
        { workspaceId: tx.actor.workspaceId },
      );
      return json(
        ListConnectorHealthResponse.parse({
          rows: rows.map((r) => ({
            connector: r.provider,
            area: 'bridges',
            people: Number(r.people),
            shared: Number(r.channels),
            needsReconnect: r.status === 'attention' ? 1 : 0,
            calls7d: Number(r.calls),
            failures7d: Number(r.failed),
            refused7d: Number(r.unverified) > 0 ? { unverified: Number(r.unverified) } : {},
            lastUsedAt: r.last_used === null ? null : r.last_used.toISOString(),
            problem: r.status === 'attention' ? (r.last_error ?? 'The chat app needs attention.') : r.status === 'off' ? null : r.last_error,
          })),
        }),
      );
    }),
  });
}
