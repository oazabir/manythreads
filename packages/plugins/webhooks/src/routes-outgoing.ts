import { json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { SafeFetchError, vetUrl } from '@manythreads/sdk/safe-fetch';
import {
  ChannelIntegrationParams,
  ClearOutgoingSigningResponse,
  CreateOutgoingHookRequest,
  ListOutgoingHooksResponse,
  OutgoingHook,
  OutgoingHookParams,
  OutgoingSigningResponse,
  RevokeOutgoingHookResponse,
  TestOutgoingHookResponse,
  UpdateOutgoingHookRequest,
  abuseLimit,
  clearOutgoingSigningRoute,
  createOutgoingHookRoute,
  listOutgoingHooksRoute,
  revokeOutgoingHookRoute,
  setOutgoingSigningRoute,
  testOutgoingHookRoute,
  updateOutgoingHookRoute,
} from '@manythreads/shared';
import { forbidden, invalid } from './http.ts';
import { WEBHOOK_COLUMNS, type WebhookRow } from './hooks.ts';
import { buildPayload, classifyFailure, loadTarget, sendCall, type TriggerMessage } from './outgoing.ts';
import { newOutgoingSigningSecret, newVerificationToken } from './secrets.ts';

// The routes a channel's lead (or a workspace admin) uses to manage the channel's outgoing webhooks: list, make, change, switch off, set or clear the
// signing secret, send a test call. An outgoing webhook is an integration (a row of the webhooks table of kind `outgoing`) plus its address and trigger words
// (`app.webhook_outgoing`). Who may is decided by the database as for incoming webhooks: `app.integrations_create` and `app.webhooks_revoke` check the caller
// against the channel, and the list is row-level security. The updates themselves are the system role's, after the lead has been shown to see the hook.

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

interface HookRow extends WebhookRow {
  url: string;
  trigger_words: string[];
  match_mode: 'starts' | 'contains';
  enabled: boolean;
  verification_token: string;
  signing_secret_id: string | null;
  delivered_count: number;
  failed_count: number;
  last_delivery_at: Date | null;
  last_delivery_status: 'delivered' | 'retrying' | 'dead' | null;
  last_error: string | null;
}

const HOOK_SELECT = `SELECT ${WEBHOOK_COLUMNS}, o.url, o.trigger_words, o.match_mode, o.enabled, o.verification_token, o.signing_secret_id,
       o.delivered_count, o.failed_count, o.last_delivery_at, o.last_delivery_status, o.last_error
  FROM app.webhooks w JOIN app.webhook_outgoing o ON o.webhook_id = w.id`;

export const toOutgoingHook = (r: HookRow): OutgoingHook =>
  OutgoingHook.parse({
    id: r.id,
    channelId: r.channel_id,
    name: r.name,
    emoji: r.emoji,
    url: r.url,
    triggerWords: r.trigger_words,
    match: r.match_mode,
    enabled: r.enabled,
    signed: r.signing_secret_id !== null,
    verificationToken: r.verification_token,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    lastDeliveryAt: r.last_delivery_at ? r.last_delivery_at.toISOString() : null,
    lastDeliveryStatus: r.last_delivery_status,
    lastError: r.last_error,
    deliveredCount: r.delivered_count,
    failedCount: r.failed_count,
  });

async function visibleOutgoing(tx: PluginTx, id: string): Promise<HookRow | null> {
  const res = await tx.query<HookRow>(`${HOOK_SELECT} WHERE w.id = $1::uuid AND w.kind = 'outgoing' AND w.revoked_at IS NULL`, [id]);
  return res.rows[0] ?? null;
}

function noData<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if ((err as { code?: string }).code === 'P0002') throw notFound('No such outgoing webhook');
    throw err;
  });
}

/** The trigger words as they are kept: trimmed, one of each (capitals do not matter), in the order given. */
export function cleanWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const t = w.trim();
    const key = t.toLowerCase();
    if (t === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** The shortest trigger word allowed in `contains` mode: a one- or two-letter word would match almost every message and send the channel out wholesale. */
export const MIN_CONTAINS_WORD = 3;

/** Refuses, with a sentence for the lead, a `contains` hook whose trigger words are so short that they match nearly every message. */
export function checkTriggerWords(words: readonly string[], match: 'starts' | 'contains'): void {
  if (match !== 'contains') return;
  const short = words.find((w) => [...w].length < MIN_CONTAINS_WORD);
  if (short !== undefined) {
    throw invalid(`The trigger word "${short}" is too short to look for anywhere in a message (it would match almost every message). Use at least ${MIN_CONTAINS_WORD} characters, or choose “starts with a trigger word”.`);
  }
}

/** The address as it will be called: checked now for what can be known without the network, with a sentence for the lead when it can never work. */
export function vetOutgoingUrl(raw: string): string {
  try {
    return vetUrl(raw).href;
  } catch (err) {
    if (!(err instanceof SafeFetchError)) throw err;
    switch (err.code) {
      case 'blocked_port':
        throw invalid('Use an address on the usual web ports: 80 for http, 443 for https. Other ports are not reached.');
      case 'blocked_scheme':
        throw invalid('Use an address that starts with https:// or http://.');
      case 'blocked_host':
      case 'blocked_address':
        throw invalid('That address points inside a network (a local name or a private number). Use a public address; a server cannot call into a private network.');
      default:
        throw invalid('That is not a web address.');
    }
  }
}

export function registerOutgoingRoutes(ctx: PluginContext): void {
  const audit = (tx: PluginTx, row: WebhookRow, change: 'created' | 'updated' | 'revoked' | 'signing_set' | 'signing_cleared'): Promise<void> =>
    ctx.audit.emit(tx, { type: 'webhooks.outgoing.changed', workspaceId: row.workspace_id, teamId: row.team_id, channelId: row.channel_id, webhookId: row.id, actorId: tx.actor.id, change, at: now(ctx) });
  const needHook = async (tx: PluginTx, id: string): Promise<HookRow> => {
    const row = await visibleOutgoing(tx, id);
    if (!row) throw notFound('No such outgoing webhook');
    return row;
  };

  /** The caller can read the channel (a lead who left a private channel, or was never in it, cannot send its messages to an outside address or change where they go). */
  const needReadChannel = async (tx: PluginTx, channelId: string): Promise<void> => {
    const ok = (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'read'])).rows[0]?.ok === true;
    if (!ok) throw forbidden('You can only set up an outgoing webhook for a channel you can read yourself, because it sends the channel’s messages to an address outside. Join the channel first (you can still switch an existing webhook off).');
  };
  const needRead = (tx: PluginTx, row: WebhookRow): Promise<void> => needReadChannel(tx, row.channel_id);

  ctx.http.route({
    method: listOutgoingHooksRoute.method,
    path: listOutgoingHooksRoute.path,
    schema: { response: ListOutgoingHooksResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelIntegrationParams.parse(req.params);
      const ok = (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'manage'])).rows[0]?.ok === true;
      if (!ok) throw forbidden('Only a lead of this channel’s team or a workspace admin can see its outgoing webhooks');
      const rows = (await tx.query<HookRow>(`${HOOK_SELECT} WHERE w.channel_id = $1::uuid AND w.kind = 'outgoing' AND w.revoked_at IS NULL ORDER BY w.created_at, w.id`, [channelId])).rows;
      return json(ListOutgoingHooksResponse.parse({ hooks: rows.map(toOutgoingHook) }));
    }),
  });

  ctx.http.route({
    method: createOutgoingHookRoute.method,
    path: createOutgoingHookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: CreateOutgoingHookRequest, response: OutgoingHook },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelIntegrationParams.parse(req.params);
      const body = CreateOutgoingHookRequest.parse(req.body);
      // the database refuses too (`app.integrations_create`); this puts the reason in a sentence. A caller who may not manage the channel gets the database's answer.
      const manage = (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'manage'])).rows[0]?.ok === true;
      if (manage) await needReadChannel(tx, channelId);
      const url = vetOutgoingUrl(body.url);
      const words = cleanWords(body.triggerWords);
      if (words.length === 0) throw invalid('Give at least one trigger word.');
      checkTriggerWords(words, body.match);
      const made = await noData(
        tx.query<{ id: string }>('SELECT app.integrations_create($1, $2::uuid, $3, $4, NULL, NULL, NULL, $5, $6::text[], $7, $8) AS id', [
          'outgoing',
          channelId,
          body.name,
          body.emoji ?? null,
          url,
          words,
          body.match,
          newVerificationToken(),
        ]),
      );
      const id = made.rows[0]?.id;
      if (!id) throw new Error('the outgoing webhook make answered no row');
      const row = await needHook(tx, id);
      await audit(tx, row, 'created');
      return json(toOutgoingHook(row), 201);
    }),
  });

  ctx.http.route({
    method: updateOutgoingHookRoute.method,
    path: updateOutgoingHookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: UpdateOutgoingHookRequest, response: OutgoingHook },
    handler: route(async (req, tx) => {
      const { hookId } = OutgoingHookParams.parse(req.params);
      const body = UpdateOutgoingHookRequest.parse(req.body);
      const row = await needHook(tx, hookId);
      const url = body.url === undefined ? null : vetOutgoingUrl(body.url);
      const words = body.triggerWords === undefined ? null : cleanWords(body.triggerWords);
      if (words !== null && words.length === 0) throw invalid('Give at least one trigger word.');
      checkTriggerWords(words ?? row.trigger_words, body.match ?? row.match_mode);
      // Switching a hook OFF is always allowed (a lead who lost access must be able to stop it); any other change, including turning it on, needs the
      // lead to be able to read the channel, since the hook sends that channel's messages to an outside address.
      const onlyOff = body.enabled === false && url === null && words === null && body.match === undefined;
      if (!onlyOff) await needRead(tx, row);
      await ctx.db.system(
        (sys) =>
          sys.query(
            `UPDATE app.webhook_outgoing SET url = coalesce($2, url), trigger_words = coalesce($3::text[], trigger_words), match_mode = coalesce($4, match_mode), enabled = coalesce($5::boolean, enabled)
              WHERE webhook_id = $1::uuid`,
            [hookId, url, words, body.match ?? null, body.enabled ?? null],
          ),
        { workspaceId: row.workspace_id },
      );
      await audit(tx, row, 'updated');
      return json(toOutgoingHook(await needHook(tx, hookId)));
    }),
  });

  ctx.http.route({
    method: revokeOutgoingHookRoute.method,
    path: revokeOutgoingHookRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: RevokeOutgoingHookResponse },
    handler: route(async (req, tx) => {
      const { hookId } = OutgoingHookParams.parse(req.params);
      const row = await needHook(tx, hookId);
      await noData(tx.query('SELECT * FROM app.webhooks_revoke($1::uuid)', [hookId]));
      // the sealed signing secret goes with the hook, and the hook is off (a secret may only be deleted by an admin or the system, so this step is the system's)
      await ctx.db.system(
        async (sys) => {
          await sys.query('UPDATE app.webhook_outgoing SET enabled = false, signing_secret_id = NULL WHERE webhook_id = $1::uuid', [hookId]);
          if (row.signing_secret_id) await ctx.secrets.delete(sys, row.signing_secret_id);
        },
        { workspaceId: row.workspace_id },
      );
      await audit(tx, row, 'revoked');
      return json(RevokeOutgoingHookResponse.parse({ revoked: true }));
    }),
  });

  // The signing secret: the value the receiver checks a call's signature with. Generated here, shown once, kept sealed. Setting it again replaces the old one.
  ctx.http.route({
    method: setOutgoingSigningRoute.method,
    path: setOutgoingSigningRoute.path,
    rateLimit: abuseLimit(setOutgoingSigningRoute.method, setOutgoingSigningRoute.path),
    schema: { response: OutgoingSigningResponse },
    handler: route(async (req, tx) => {
      const { hookId } = OutgoingHookParams.parse(req.params);
      const row = await needHook(tx, hookId);
      await needRead(tx, row);
      const plaintext = newOutgoingSigningSecret();
      await ctx.db.system(
        async (sys) => {
          const old = (await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhook_outgoing WHERE webhook_id = $1::uuid FOR UPDATE', [hookId])).rows[0];
          if (!old) throw notFound('No such outgoing webhook');
          const id = await ctx.secrets.put(sys, plaintext);
          await sys.query('UPDATE app.webhook_outgoing SET signing_secret_id = $2::uuid WHERE webhook_id = $1::uuid', [hookId, id]);
          await sys.query('UPDATE app.webhooks SET signed = true WHERE id = $1::uuid', [hookId]);
          if (old.signing_secret_id) await ctx.secrets.delete(sys, old.signing_secret_id);
        },
        { workspaceId: row.workspace_id },
      );
      await audit(tx, row, 'signing_set');
      return json(OutgoingSigningResponse.parse({ hook: toOutgoingHook(await needHook(tx, hookId)), signingSecret: plaintext }));
    }),
  });

  ctx.http.route({
    method: clearOutgoingSigningRoute.method,
    path: clearOutgoingSigningRoute.path,
    rateLimit: abuseLimit(clearOutgoingSigningRoute.method, clearOutgoingSigningRoute.path),
    schema: { response: ClearOutgoingSigningResponse },
    handler: route(async (req, tx) => {
      const { hookId } = OutgoingHookParams.parse(req.params);
      const row = await needHook(tx, hookId);
      await ctx.db.system(
        async (sys) => {
          const old = (await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhook_outgoing WHERE webhook_id = $1::uuid FOR UPDATE', [hookId])).rows[0];
          if (!old) throw notFound('No such outgoing webhook');
          await sys.query('UPDATE app.webhook_outgoing SET signing_secret_id = NULL WHERE webhook_id = $1::uuid', [hookId]);
          await sys.query('UPDATE app.webhooks SET signed = false WHERE id = $1::uuid', [hookId]);
          if (old.signing_secret_id) await ctx.secrets.delete(sys, old.signing_secret_id);
        },
        { workspaceId: row.workspace_id },
      );
      await audit(tx, row, 'signing_cleared');
      return json(ClearOutgoingSigningResponse.parse({ hook: toOutgoingHook(await needHook(tx, hookId)) }));
    }),
  });

  // "Send a test call": sends a sample message to the address now, through the same guarded path a real delivery takes, and says what the receiver answered.
  // Nothing is posted in the channel (the reply is only reported as "would reply"), and no counter moves.
  ctx.http.route({
    method: testOutgoingHookRoute.method,
    path: testOutgoingHookRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: TestOutgoingHookResponse },
    handler: route(async (req, tx) => {
      const { hookId } = OutgoingHookParams.parse(req.params);
      const row = await needHook(tx, hookId);
      const who = (await tx.query<{ display_name: string | null }>('SELECT p.display_name FROM app.people p WHERE p.id = app.person_id()')).rows[0]?.display_name ?? 'Someone';
      const inTx = <T>(fn: (t: PluginTx) => Promise<T>): Promise<T> => ctx.db.system(fn, { workspaceId: row.workspace_id });
      const prepared = await inTx(async (sys) => {
        const target = await loadTarget(sys, hookId);
        if (!target) return null;
        const id = (await sys.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id as string;
        const signing = target.signingSecretId ? await ctx.secrets.get(sys, target.signingSecretId).catch(() => null) : null;
        return { target, id, signing };
      });
      if (prepared === null) throw notFound('No such outgoing webhook');
      const { target, id, signing } = prepared;
      const word = target.triggerWords[0] ?? 'test';
      const message: TriggerMessage = { id, channelId: target.channelId, body: `${word} this is a test call from manythreads`, threadRootId: null, deleted: false, authorKind: 'person', personId: null, authorName: who };
      try {
        const sent = await sendCall(ctx, inTx, target, (text) => buildPayload(target, message, word, text), message.body, signing);
        return json(TestOutgoingHookResponse.parse({ delivered: true, statusCode: sent.statusCode, reason: null, wouldReply: sent.reply !== null }));
      } catch (err) {
        const f = classifyFailure(err);
        return json(TestOutgoingHookResponse.parse({ delivered: f.deliveredAnyway === true, statusCode: f.statusCode, reason: f.reason, wouldReply: false }));
      }
    }),
  });
}
