import { HttpError, createLockout, lockedError, type HttpRequest, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  PROVIDER_BODY_MAX_BYTES,
  ProviderHookDoorResponse,
  WEBHOOK_FAILURE_LOCK,
  WebhooksProviderEventReceivedEvent,
  WebhooksProviderEventRefusedEvent,
  abuseLimit,
  addressKey,
  providerHookDoorRoute,
  type ProviderRefusalReason,
  type WebhookProvider,
} from '@manythreads/shared';
import { createWindowLimiter, type WindowLimiter } from './limiter.ts';
import { PROVIDER_READERS, judgeDelivery } from './providers/index.ts';
import { isObj, sha256Hex, trimPayload } from './providers/common.ts';
import { readBody } from './routes-call.ts';

// Work package H (P16-10, decisions D17 to D19): the public door a work app calls, `POST /hooks/apps/:endpointId`. The address holds no secret: the app's signature is the credential.
// What happens, in this order, and nothing is read from the body before the signature has held:
//   1. the shape of the address, then the endpoint. An id that is not one, one that does not exist, a revoked one and one that is switched off all answer the same 404.
//   2. the endpoint's own limit (120 calls a minute), then the raw body, up to 1 MB (more is refused 413 as soon as the limit is crossed).
//   3. Asana's one-time handshake (the first call carries the secret in a header; it is echoed back and sealed).
//   4. the signature over the raw bytes with the endpoint's sealed secret, with the app's own replay window. A bad one answers 401 and changes nothing.
//   5. only now the body is parsed. An event whose own time is older than seven days is stale (the apps that send no timestamp with their signature).
//   6. the event is turned into a kind, a title, a link and an actor; one the platform does not use, or one the endpoint's filter leaves out, answers 202 and is forgotten.
//   7. one transaction stores it (a repeat of the same delivery, or the same body, is a no-op that answers 200 `duplicate`) and announces it with `webhooks.provider_event.received`.
// The answer never waits for a model: the bots that listen start from that announcement. A refusal is announced once a minute per endpoint and reason, with the count.

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = (): HttpError => new HttpError(404, 'not_found', 'Not found');

/** The most calls one endpoint accepts a minute. */
export const PROVIDER_PER_MINUTE = 120;
/** How long a stored event (and with it the card "What started this run") is kept, in days. The dedupe window itself is seven days; the longer keeping only makes a card last. */
export const PROVIDER_EVENT_KEEP_DAYS = 30;
const PURGE_QUEUE = 'webhooks.provider-purge';

interface EndpointRow {
  id: string;
  workspace_id: string;
  team_id: string;
  channel_id: string;
  revoked_at: Date | null;
  kind: string;
  provider: WebhookProvider;
  event_filter: string[];
  signing_secret_id: string | null;
  handshake_at: Date | null;
  live: boolean;
  [key: string]: unknown;
}

/** An exact kind or `ticket.*` (everything under `ticket.`). */
export const kindMatches = (pattern: string, kind: string): boolean => (pattern.endsWith('.*') ? kind.startsWith(pattern.slice(0, -1)) : pattern === kind);

/**
 * Lets a refusal through at most once a minute for each key and counts the ones it held back, so the next line says how many there were. A flood of bad calls writes a line a minute.
 */
export function createRefusalGate(windowMs = 60_000, now: () => number = Date.now): (key: string) => number {
  const seen = new Map<string, { at: number; held: number }>();
  return (key) => {
    const t = now();
    if (seen.size > 5_000) for (const [k, v] of seen) if (t - v.at >= windowMs) seen.delete(k);
    const entry = seen.get(key);
    if (entry && t - entry.at < windowMs) {
      entry.held += 1;
      return 0;
    }
    const count = 1 + (entry?.held ?? 0);
    seen.set(key, { at: t, held: 0 });
    return count;
  };
}

export interface DoorDeps {
  limiter?: WindowLimiter;
  perMinute?: number;
}

export function registerProviderDoor(ctx: PluginContext, deps: DoorDeps = {}): void {
  const limiter = deps.limiter ?? createWindowLimiter();
  const perMinute = deps.perMinute ?? PROVIDER_PER_MINUTE;
  const gate = createRefusalGate(60_000, () => ctx.runtime.now().getTime());
  // Calls that name no live endpoint, per client address: 30 in 5 minutes lock the address for 5 minutes, and a locked address gets 429 instead of 404 for its failing calls. A call with
  // a good signature is never held back by the lock (a provider's senders share addresses), and only failures count.
  const strangers = createLockout({ now: ctx.runtime.now, ...WEBHOOK_FAILURE_LOCK });
  const at = (): string => ctx.runtime.now().toISOString();

  const refuse = async (hook: EndpointRow, reason: ProviderRefusalReason): Promise<void> => {
    const count = gate(`${hook.id}:${reason}`);
    if (count === 0) return;
    await ctx.db
      .system(
        (sys) =>
          ctx.audit.emit(
            sys,
            WebhooksProviderEventRefusedEvent.parse({
              type: 'webhooks.provider_event.refused',
              schemaVersion: 1,
              workspaceId: hook.workspace_id,
              teamId: hook.team_id,
              channelId: hook.channel_id,
              webhookId: hook.id,
              provider: hook.provider,
              reason,
              count,
              at: at(),
            }),
          ),
        { workspaceId: hook.workspace_id },
      )
      .catch(() => undefined);
  };

  const touch = (hook: EndpointRow, status: 'posted' | 'ignored' | 'failed'): Promise<void> =>
    ctx.db
      .system(
        async (sys) => {
          await sys.query(
            `UPDATE app.webhooks SET last_used_at = now(), last_status = $2, posted_count = posted_count + CASE WHEN $2 = 'posted' THEN 1 ELSE 0 END WHERE id = $1::uuid`,
            [hook.id, status],
          );
        },
        { workspaceId: hook.workspace_id },
      )
      .catch(() => undefined);

  /** Asana's handshake: keeps the secret Asana sent, once, and says whether this call was one. */
  const handshake = async (hook: EndpointRow, secret: string): Promise<boolean> =>
    ctx.db.system(
      async (sys) => {
        const row = (await sys.query<{ handshake_at: Date | null; signing_secret_id: string | null }>('SELECT handshake_at, signing_secret_id FROM app.webhook_provider WHERE webhook_id = $1::uuid FOR UPDATE', [hook.id])).rows[0];
        if (!row || row.handshake_at !== null) return false;
        const sealed = await ctx.secrets.put(sys, secret);
        await sys.query('UPDATE app.webhook_provider SET signing_secret_id = $2::uuid, handshake_at = now() WHERE webhook_id = $1::uuid', [hook.id, sealed]);
        await sys.query('UPDATE app.webhooks SET signed = true WHERE id = $1::uuid', [hook.id]);
        if (row.signing_secret_id) await ctx.secrets.delete(sys, row.signing_secret_id);
        return true;
      },
      { workspaceId: hook.workspace_id },
    );

  /** Stores the event and announces it; null when this delivery (or this very body) was already taken. */
  const store = async (
    hook: EndpointRow,
    input: { key: string; bodyHash: string; kind: string; externalId: string; url: string | null; title: string; actor: string; payload: unknown },
  ): Promise<string | null> =>
    ctx.db.system(
      async (sys: PluginTx) => {
        const same = await sys.query(
          `SELECT 1 FROM app.webhook_provider_events WHERE webhook_id = $1::uuid AND received_at > now() - interval '7 days' AND payload ->> 'sha256' = $2 LIMIT 1`,
          [hook.id, input.bodyHash],
        );
        if (same.rows.length > 0) return null;
        const row = (
          await sys.query<{ id: string }>(
            `INSERT INTO app.webhook_provider_events (workspace_id, team_id, webhook_id, provider, delivery_key, kind, external_id, url, title, actor_label, payload)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
             ON CONFLICT (webhook_id, delivery_key) DO NOTHING RETURNING id`,
            [
              hook.workspace_id,
              hook.team_id,
              hook.id,
              hook.provider,
              input.key,
              input.kind,
              input.externalId === '' ? null : input.externalId.slice(0, 200),
              input.url,
              input.title === '' ? null : input.title,
              input.actor === '' ? null : input.actor,
              JSON.stringify({ sha256: input.bodyHash, data: input.payload }),
            ],
          )
        ).rows[0];
        if (!row) return null;
        await ctx.audit.emit(
          sys,
          WebhooksProviderEventReceivedEvent.parse({
            type: 'webhooks.provider_event.received',
            schemaVersion: 1,
            workspaceId: hook.workspace_id,
            teamId: hook.team_id,
            channelId: hook.channel_id,
            webhookId: hook.id,
            eventId: row.id,
            provider: hook.provider,
            kind: input.kind,
            at: at(),
          }),
        );
        await sys.query(`UPDATE app.webhooks SET last_used_at = now(), last_status = 'posted', posted_count = posted_count + 1 WHERE id = $1::uuid`, [hook.id]);
        return row.id;
      },
      { workspaceId: hook.workspace_id },
    );

  ctx.http.route({
    method: providerHookDoorRoute.method,
    path: providerHookDoorRoute.path,
    public: true,
    // csrf is for cookie sessions; a work app's call carries none
    csrfExempt: true,
    rawBody: true,
    rateLimit: abuseLimit('POST', providerHookDoorRoute.path),
    rateLimitBy: 'address',
    handler: async (req: HttpRequest) => {
      const { endpointId } = req.params as { endpointId: string };
      const strangerKey = `app\n${addressKey(req.ip)}`;
      const barred = strangers.check(strangerKey);
      const stranger = (): HttpError => {
        if (barred.locked) return lockedError(barred, 'calls to work app addresses');
        strangers.fail(strangerKey);
        return NOT_FOUND();
      };
      if (!ID_SHAPE.test(endpointId)) throw stranger();
      const hook = (
        await ctx.db.system((sys) =>
          sys.query<EndpointRow>(
            `SELECT w.id, w.workspace_id, w.team_id, w.channel_id, w.revoked_at, w.kind, p.provider, p.event_filter, p.signing_secret_id, p.handshake_at, p.live
               FROM app.webhooks w JOIN app.webhook_provider p ON p.webhook_id = w.id WHERE w.id = $1::uuid`,
            [endpointId],
          ),
        )
      ).rows[0];
      if (!hook || hook.kind !== 'provider' || hook.revoked_at !== null || !hook.live) throw stranger();

      const slot = limiter.hit(hook.id, perMinute, 60_000);
      if (!slot.allowed) throw new HttpError(429, 'rate_limited', `This address accepts ${perMinute} calls a minute. Try again shortly.`, { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) });

      let raw: Buffer;
      try {
        raw = await readBody(req, PROVIDER_BODY_MAX_BYTES);
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) await refuse(hook, 'too_large');
        throw err;
      }

      const reader = PROVIDER_READERS[hook.provider];
      const now = ctx.runtime.now().getTime();

      const hookSecret = req.headers['x-hook-secret'];
      if (hook.provider === 'asana' && hookSecret !== undefined && hook.handshake_at === null) {
        if (hookSecret.length < 8 || hookSecret.length > 500 || !/^[\x21-\x7e]+$/.test(hookSecret)) throw new HttpError(400, 'validation_failed', 'The handshake secret is not valid');
        if (await handshake(hook, hookSecret)) {
          await touch(hook, 'ignored');
          return { status: 200, body: ProviderHookDoorResponse.parse({ ok: true, ignored: true }), headers: { 'x-hook-secret': hookSecret } };
        }
      }

      const sealed = hook.signing_secret_id;
      const secret = sealed === null ? null : await ctx.db.system((sys) => ctx.secrets.get(sys, sealed), { workspaceId: hook.workspace_id }).catch(() => null);
      if (secret === null) {
        await refuse(hook, 'bad_signature');
        throw new HttpError(401, 'unauthenticated', 'The call is not signed');
      }
      const judged = judgeDelivery(reader, {
        headers: req.headers,
        rawBody: raw,
        secret,
        now,
        method: 'POST',
        uri: `${ctx.runtime.publicUrl.replace(/\/+$/, '')}/hooks/apps/${hook.id}`,
      });
      if (!judged.ok) {
        if (judged.reason === 'bad_body') {
          await touch(hook, 'failed');
          throw new HttpError(400, 'validation_failed', 'The body is not JSON');
        }
        await refuse(hook, judged.reason);
        throw new HttpError(401, 'unauthenticated', judged.reason === 'stale' ? 'The call is too old' : 'The call is not signed with this address’s secret');
      }
      const body = judged.body;

      const normalised = reader.normalise({ headers: req.headers, body });
      const passes = normalised !== null && (hook.event_filter.length === 0 || hook.event_filter.some((p) => kindMatches(p, normalised.kind)));
      if (normalised === null || !passes) {
        await touch(hook, 'ignored');
        return { status: 202, body: ProviderHookDoorResponse.parse({ ok: true, ignored: true }) };
      }

      const bodyHash = sha256Hex(raw);
      const key = (reader.deliveryKey(req.headers, body) ?? bodyHash).slice(0, 200);
      const stored = await store(hook, {
        key,
        bodyHash,
        kind: normalised.kind,
        externalId: normalised.externalId,
        url: normalised.url,
        title: normalised.title,
        actor: normalised.actor,
        payload: trimPayload(isObj(body) || Array.isArray(body) ? body : null),
      });
      if (stored === null) {
        await refuse(hook, 'replayed');
        return { status: 200, body: ProviderHookDoorResponse.parse({ ok: true, duplicate: true }) };
      }
      return { status: 200, body: ProviderHookDoorResponse.parse({ ok: true }) };
    },
  });

  // Stored events (and with them the latch rows and the "What started this run" card) go after thirty days.
  ctx.jobs.register(
    PURGE_QUEUE,
    async (_payload, tx, job) => {
      const gone = await tx.query(`DELETE FROM app.webhook_provider_events WHERE received_at < now() - interval '${PROVIDER_EVENT_KEEP_DAYS} days' RETURNING id`);
      if (gone.rows.length > 0) job.log.info(`webhooks: removed ${gone.rows.length} stored event(s) older than ${PROVIDER_EVENT_KEEP_DAYS} days`);
    },
    { cron: '23 * * * *', maxAttempts: 1 },
  );
}
