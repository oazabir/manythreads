import { json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  ApiToken,
  ApiTokenParams,
  ApiTokenWithSecret,
  ChannelIntegrationParams,
  CreateApiTokenRequest,
  ListApiTokensResponse,
  RevokeApiTokenResponse,
  SLACK_METHODS,
  TestApiTokenResponse,
  abuseLimit,
  createApiTokenRoute,
  listApiTokensRoute,
  revokeApiTokenRoute,
  rotateApiTokenRoute,
  testApiTokenRoute,
} from '@manythreads/shared';
import { conflict, forbidden } from './http.ts';
import { postAsWebhook, recordUse, statusOf } from './deliver.ts';
import { WEBHOOK_COLUMNS, type WebhookRow } from './hooks.ts';
import { hashWebhookSecret, newApiToken } from './secrets.ts';
import { messageIdToTs } from './ts.ts';

// The routes a channel's lead (or a workspace admin) uses to manage API tokens of the Slack-shaped API: list, make, rotate, revoke, send a test message.
// A token is an integration (a row of the webhooks table of kind `api`) with its own author name; the secret is shown once and kept only as a hash. Who
// may is decided by the database exactly as for incoming webhooks: `app.integrations_create` and `app.webhooks_rotate` / `_revoke` check the caller
// against the channel, and the list is row-level security on the tables.

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

interface TokenRow extends WebhookRow {
  scopes: string[];
  channel_ids: string[];
}

const TOKEN_SELECT = `SELECT ${WEBHOOK_COLUMNS}, a.scopes,
       coalesce((SELECT array_agg(wc.channel_id ORDER BY wc.position, wc.channel_id) FROM app.webhook_channels wc WHERE wc.webhook_id = w.id), ARRAY[]::uuid[]) AS channel_ids
  FROM app.webhooks w JOIN app.webhook_api a ON a.webhook_id = w.id`;

export const toApiToken = (r: TokenRow): ApiToken =>
  ApiToken.parse({
    id: r.id,
    channelId: r.channel_id,
    name: r.name,
    emoji: r.emoji,
    channelIds: r.channel_ids,
    // the order of the methods is the order of the list, whatever order they were stored in
    methods: SLACK_METHODS.filter((m) => r.scopes.includes(m)),
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    lastStatus: r.last_status,
    callCount: Number(r.call_count),
  });

/** The Postgres "no_data_found" a definer raises for an integration that is gone or never was → a plain 404. */
function noData<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if ((err as { code?: string }).code === 'P0002') throw notFound('No such token');
    throw err;
  });
}

async function visibleToken(tx: PluginTx, id: string): Promise<TokenRow | null> {
  const res = await tx.query<TokenRow>(`${TOKEN_SELECT} WHERE w.id = $1::uuid AND w.kind = 'api' AND w.revoked_at IS NULL`, [id]);
  return res.rows[0] ?? null;
}

export function registerTokenRoutes(ctx: PluginContext): void {
  const audit = (tx: PluginTx, row: WebhookRow, change: 'created' | 'rotated' | 'revoked'): Promise<void> =>
    ctx.audit.emit(tx, { type: 'webhooks.token.changed', workspaceId: row.workspace_id, teamId: row.team_id, channelId: row.channel_id, webhookId: row.id, actorId: tx.actor.id, change, at: now(ctx) });
  const apiBase = (): string => `${ctx.runtime.publicUrl.replace(/\/+$/, '')}/api/slack/`;

  ctx.http.route({
    method: listApiTokensRoute.method,
    path: listApiTokensRoute.path,
    schema: { response: ListApiTokensResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelIntegrationParams.parse(req.params);
      const ok = (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'manage'])).rows[0]?.ok === true;
      if (!ok) throw forbidden('Only a lead of this channel’s team or a workspace admin can see its API tokens');
      // the tokens that reach this channel, including one made in another channel of the team
      const rows = (
        await tx.query<TokenRow>(
          `${TOKEN_SELECT}
            WHERE w.kind = 'api' AND w.revoked_at IS NULL AND EXISTS (SELECT 1 FROM app.webhook_channels c WHERE c.webhook_id = w.id AND c.channel_id = $1::uuid)
            ORDER BY w.created_at, w.id`,
          [channelId],
        )
      ).rows;
      return json(ListApiTokensResponse.parse({ tokens: rows.map(toApiToken), apiBase: apiBase() }));
    }),
  });

  ctx.http.route({
    method: createApiTokenRoute.method,
    path: createApiTokenRoute.path,
    rateLimit: abuseLimit(createApiTokenRoute.method, createApiTokenRoute.path),
    schema: { body: CreateApiTokenRequest, response: ApiTokenWithSecret },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelIntegrationParams.parse(req.params);
      const body = CreateApiTokenRequest.parse(req.body);
      const secret = newApiToken();
      const methods = body.methods ? SLACK_METHODS.filter((m) => body.methods?.includes(m)) : [...SLACK_METHODS];
      const made = await noData(
        tx.query<{ id: string }>('SELECT app.integrations_create($1, $2::uuid, $3, $4, $5, $6::text[], $7::uuid[], NULL, NULL, NULL, NULL) AS id', [
          'api',
          channelId,
          body.name,
          body.emoji ?? null,
          hashWebhookSecret(secret),
          methods,
          body.moreChannelIds ?? [],
        ]),
      );
      const id = made.rows[0]?.id;
      if (!id) throw new Error('the token make answered no row');
      const row = await visibleToken(tx, id);
      if (!row) throw new Error('the token just made cannot be read');
      await audit(tx, row, 'created');
      return json(ApiTokenWithSecret.parse({ token: toApiToken(row), secret }), 201);
    }),
  });

  ctx.http.route({
    method: rotateApiTokenRoute.method,
    path: rotateApiTokenRoute.path,
    rateLimit: abuseLimit(rotateApiTokenRoute.method, rotateApiTokenRoute.path),
    schema: { response: ApiTokenWithSecret },
    handler: route(async (req, tx) => {
      const { tokenId } = ApiTokenParams.parse(req.params);
      const row = await visibleToken(tx, tokenId);
      if (!row) throw notFound('No such token');
      const secret = newApiToken();
      await noData(tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [tokenId, hashWebhookSecret(secret)]));
      await audit(tx, row, 'rotated');
      return json(ApiTokenWithSecret.parse({ token: toApiToken(row), secret }));
    }),
  });

  ctx.http.route({
    method: revokeApiTokenRoute.method,
    path: revokeApiTokenRoute.path,
    rateLimit: abuseLimit(revokeApiTokenRoute.method, revokeApiTokenRoute.path),
    schema: { response: RevokeApiTokenResponse },
    handler: route(async (req, tx) => {
      const { tokenId } = ApiTokenParams.parse(req.params);
      const row = await visibleToken(tx, tokenId);
      if (!row) throw notFound('No such token');
      await noData(tx.query('SELECT * FROM app.webhooks_revoke($1::uuid)', [tokenId]));
      await audit(tx, row, 'revoked');
      return json(RevokeApiTokenResponse.parse({ revoked: true }));
    }),
  });

  // "Send test message": posts a short note into the token's own channel as the integration, through the same path a real call takes.
  ctx.http.route({
    method: testApiTokenRoute.method,
    path: testApiTokenRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: TestApiTokenResponse },
    handler: route(async (req, tx) => {
      const { tokenId } = ApiTokenParams.parse(req.params);
      const row = await visibleToken(tx, tokenId);
      if (!row) throw notFound('No such token');
      const who = (await tx.query<{ display_name: string | null }>('SELECT p.display_name FROM app.people p WHERE p.id = app.person_id()')).rows[0]?.display_name ?? 'someone';
      const esc = (s: string): string => s.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
      const text = `✅ **Test message**\n\nThis note was sent by ${esc(who)} to check that the API token **${esc(row.name)}** reaches this channel. If you can read it, the token's channel works.`;
      try {
        const posted = await postAsWebhook(ctx, row, text);
        const fresh = await visibleToken(tx, tokenId);
        return json(TestApiTokenResponse.parse({ messageId: posted.messageId, ts: messageIdToTs(posted.messageId), token: toApiToken(fresh ?? row) }));
      } catch (err) {
        await recordUse(ctx, row, 'failed');
        const status = statusOf(err);
        if (status === 409) throw conflict('The channel is archived, so nothing can be posted in it');
        if (status === 403 || status === 404) throw conflict('The channel is not available for posting');
        throw err;
      }
    }),
  });
}
