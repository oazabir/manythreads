import { json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  ClearSigningResponse,
  CreateWebhookRequest,
  ListWebhooksResponse,
  RevokeWebhookResponse,
  SigningSecretResponse,
  TestWebhookResponse,
  WebhookParams,
  WebhookWithUrl,
  ChannelWebhookParams,
  clearWebhookSigningRoute,
  createWebhookRoute,
  listWebhooksRoute,
  revokeWebhookRoute,
  rotateWebhookRoute,
  setWebhookSigningRoute,
  testWebhookRoute,
} from '@manythreads/shared';
import { conflict, forbidden } from './http.ts';
import { WEBHOOK_COLUMNS, toWebhook, visibleHook, webhookUrl, type WebhookRow } from './hooks.ts';
import { postAsWebhook, recordUse, statusOf } from './deliver.ts';
import { hashWebhookSecret, newSigningSecret, newWebhookSecret } from './secrets.ts';

// The routes a channel's lead (or a workspace admin) uses to manage the channel's webhooks: list, make, rotate, revoke, set or clear the signing
// secret, send a test message. Who may is decided by the database: the make, rotate and revoke doors are definer functions that check the
// caller against the channel (migration 0001), and the list is row-level security on the table.

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

/** The Postgres "no_data_found" a definer raises for a webhook that is gone or never was → a plain 404. */
function noData<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if ((err as { code?: string }).code === 'P0002') throw notFound('No such webhook');
    throw err;
  });
}

async function requireVisible(tx: PluginTx, id: string): Promise<WebhookRow> {
  const row = await visibleHook(tx, id);
  if (!row) throw notFound('No such webhook');
  return row;
}

async function personName(tx: PluginTx): Promise<string> {
  const res = await tx.query<{ display_name: string | null }>('SELECT p.display_name FROM app.people p WHERE p.id = app.person_id()');
  return res.rows[0]?.display_name ?? 'someone';
}

export function registerManageRoutes(ctx: PluginContext): void {
  const audit = (tx: PluginTx, type: string, hook: WebhookRow, extra: Record<string, unknown> = {}): Promise<void> =>
    ctx.audit.emit(tx, { type, workspaceId: hook.workspace_id, teamId: hook.team_id, channelId: hook.channel_id, webhookId: hook.id, actorId: tx.actor.id, ...extra, at: now(ctx) });
  const base = (): string => `${ctx.runtime.publicUrl.replace(/\/+$/, '')}/hooks/`;

  ctx.http.route({
    method: listWebhooksRoute.method,
    path: listWebhooksRoute.path,
    schema: { response: ListWebhooksResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelWebhookParams.parse(req.params);
      const ok = (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'manage'])).rows[0]?.ok === true;
      if (!ok) throw forbidden('Only a lead of this channel’s team or a workspace admin can see its webhooks');
      const rows = (
        await tx.query<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM app.webhooks w WHERE w.channel_id = $1::uuid AND w.revoked_at IS NULL ORDER BY w.created_at, w.id`, [channelId])
      ).rows;
      return json(ListWebhooksResponse.parse({ webhooks: rows.map(toWebhook), base: base() }));
    }),
  });

  ctx.http.route({
    method: createWebhookRoute.method,
    path: createWebhookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: CreateWebhookRequest, response: WebhookWithUrl },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelWebhookParams.parse(req.params);
      const body = CreateWebhookRequest.parse(req.body);
      const secret = newWebhookSecret();
      const made = await noData(
        tx.query<{ id: string }>('SELECT app.webhooks_create($1::uuid, $2, $3, $4) AS id', [channelId, body.name, body.emoji ?? null, hashWebhookSecret(secret)]),
      );
      const id = made.rows[0]?.id;
      if (!id) throw new Error('the webhook make answered no row');
      const row = await requireVisible(tx, id);
      await audit(tx, 'webhooks.hook.created', row);
      return json(WebhookWithUrl.parse({ webhook: toWebhook(row), url: webhookUrl(ctx.runtime.publicUrl, id, secret) }), 201);
    }),
  });

  ctx.http.route({
    method: rotateWebhookRoute.method,
    path: rotateWebhookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: WebhookWithUrl },
    handler: route(async (req, tx) => {
      const { webhookId } = WebhookParams.parse(req.params);
      const row = await requireVisible(tx, webhookId);
      const secret = newWebhookSecret();
      await noData(tx.query('SELECT app.webhooks_rotate($1::uuid, $2)', [webhookId, hashWebhookSecret(secret)]));
      await audit(tx, 'webhooks.hook.rotated', row);
      return json(WebhookWithUrl.parse({ webhook: toWebhook(row), url: webhookUrl(ctx.runtime.publicUrl, webhookId, secret) }));
    }),
  });

  ctx.http.route({
    method: revokeWebhookRoute.method,
    path: revokeWebhookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: RevokeWebhookResponse },
    handler: route(async (req, tx) => {
      const { webhookId } = WebhookParams.parse(req.params);
      const row = await requireVisible(tx, webhookId);
      const gone = await noData(tx.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhooks_revoke($1::uuid)', [webhookId]));
      const sealed = gone.rows[0]?.signing_secret_id ?? null;
      // the sealed signing secret goes with the webhook (a secret may only be deleted by an admin or the system, so this step is the system's)
      if (sealed) await ctx.db.system((sys) => ctx.secrets.delete(sys, sealed), { workspaceId: row.workspace_id });
      await audit(tx, 'webhooks.hook.revoked', row);
      return json(RevokeWebhookResponse.parse({ revoked: true }));
    }),
  });

  // The signing secret: the value a sender such as GitHub signs its calls with. Generated here, shown once, kept sealed (it has to be readable to check
  // a signature, so it is encrypted rather than hashed). Setting it again replaces the old one. The webhook row records only that one is set.
  ctx.http.route({
    method: setWebhookSigningRoute.method,
    path: setWebhookSigningRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: SigningSecretResponse },
    handler: route(async (req, tx) => {
      const { webhookId } = WebhookParams.parse(req.params);
      const row = await requireVisible(tx, webhookId);
      const plaintext = newSigningSecret();
      await ctx.db.system(
        async (sys) => {
          const old = (await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhook_secrets WHERE webhook_id = $1::uuid FOR UPDATE', [webhookId])).rows[0];
          if (!old) throw notFound('No such webhook');
          const id = await ctx.secrets.put(sys, plaintext);
          await sys.query('UPDATE app.webhook_secrets SET signing_secret_id = $2::uuid WHERE webhook_id = $1::uuid', [webhookId, id]);
          await sys.query('UPDATE app.webhooks SET signed = true WHERE id = $1::uuid', [webhookId]);
          if (old.signing_secret_id) await ctx.secrets.delete(sys, old.signing_secret_id);
        },
        { workspaceId: row.workspace_id },
      );
      await audit(tx, 'webhooks.hook.signing_changed', row, { enabled: true });
      return json(SigningSecretResponse.parse({ webhook: toWebhook(await requireVisible(tx, webhookId)), signingSecret: plaintext }));
    }),
  });

  ctx.http.route({
    method: clearWebhookSigningRoute.method,
    path: clearWebhookSigningRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: ClearSigningResponse },
    handler: route(async (req, tx) => {
      const { webhookId } = WebhookParams.parse(req.params);
      const row = await requireVisible(tx, webhookId);
      await ctx.db.system(
        async (sys) => {
          const old = (await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhook_secrets WHERE webhook_id = $1::uuid FOR UPDATE', [webhookId])).rows[0];
          if (!old) throw notFound('No such webhook');
          await sys.query('UPDATE app.webhook_secrets SET signing_secret_id = NULL WHERE webhook_id = $1::uuid', [webhookId]);
          await sys.query('UPDATE app.webhooks SET signed = false WHERE id = $1::uuid', [webhookId]);
          if (old.signing_secret_id) await ctx.secrets.delete(sys, old.signing_secret_id);
        },
        { workspaceId: row.workspace_id },
      );
      await audit(tx, 'webhooks.hook.signing_changed', row, { enabled: false });
      return json(ClearSigningResponse.parse({ webhook: toWebhook(await requireVisible(tx, webhookId)) }));
    }),
  });

  // "Send test message": posts a short note through the same path a real call takes, so the lead sees exactly what a call looks like in the channel.
  ctx.http.route({
    method: testWebhookRoute.method,
    path: testWebhookRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: TestWebhookResponse },
    handler: route(async (req, tx) => {
      const { webhookId } = WebhookParams.parse(req.params);
      const row = await requireVisible(tx, webhookId);
      const who = await personName(tx);
      const text = `✅ **Test message**\n\nThis note was sent by ${who.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)} to check that the webhook **${row.name.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)}** reaches this channel. If you can read it, the address works.`;
      try {
        const posted = await postAsWebhook(ctx, row, text);
        return json(TestWebhookResponse.parse({ messageId: posted.messageId, webhook: toWebhook(await requireVisible(tx, webhookId)) }));
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
