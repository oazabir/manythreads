import { HttpError, createLockout, json, lockedError, type HttpRequest, type PluginContext } from '@manythreads/sdk';
import { MAX_WEBHOOK_BODY_BYTES, WEBHOOK_FAILURE_LOCK, WebhookCallResponse, addressKey, webhookCallRoute } from '@manythreads/shared';
import { adapt, parseBody } from './adapters/index.ts';
import { postAsWebhook, recordUse, statusOf } from './deliver.ts';
import { loadHook, type HookWithSecrets } from './hooks.ts';
import { createOncePer, createWindowLimiter, type WindowLimiter } from './limiter.ts';
import { callIsSigned, secretMatches } from './secrets.ts';

// The public door: `POST /hooks/<webhook id>/<secret>`. Anyone holding the address may post into the channel, so everything here is about not telling
// a stranger anything: an id that does not exist, a wrong secret, a rotated secret and a revoked webhook all answer the same 404, after the same work.
// The order is: shape of the address → the webhook and its secret → the webhook's own rate limit → the body (capped) → the signature (when the
// webhook has a signing secret) → the payload adapter → the post.

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_SHAPE = /^mtwh_[A-Za-z0-9_-]{20,100}$/;

const NOT_FOUND = (): HttpError => new HttpError(404, 'not_found', 'Not found');

export interface CallDeps {
  limiter?: WindowLimiter;
  /** Calls per minute one webhook accepts. Default 120, or `MANYTHREADS_WEBHOOK_RATE_PER_MINUTE`. */
  perMinute?: number;
}

const perMinuteFromEnv = (): number => {
  const n = Number(process.env['MANYTHREADS_WEBHOOK_RATE_PER_MINUTE']);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 120;
};

/** Reads the body up to `max` bytes; a longer one is refused as soon as the limit is crossed, without reading the rest. */
export async function readBody(req: HttpRequest, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw tooLarge(max);
  if (!req.stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.stream) {
    total += chunk.byteLength;
    if (total > max) throw tooLarge(max);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
const tooLarge = (max: number): HttpError => new HttpError(413, 'validation_failed', `The body is larger than ${Math.round(max / 1024)} KB`, { connection: 'close' });

export function registerCallRoute(ctx: PluginContext, deps: CallDeps = {}): void {
  const limiter = deps.limiter ?? createWindowLimiter();
  const perMinute = deps.perMinute ?? perMinuteFromEnv();
  const onceAMinute = createOncePer(60_000);
  // Calls that name no live webhook or carry a wrong secret, per client address: 30 in 5 minutes lock the address for 5 minutes, and a locked address
  // gets 429 with `retry-after` instead of 404 for its failing calls. A call with a right secret is never refused by the lock, and only failures count.
  const strangers = createLockout({ now: ctx.runtime.now, ...WEBHOOK_FAILURE_LOCK });

  type Reason = 'bad_secret' | 'revoked' | 'bad_signature' | 'too_large' | 'rate_limited' | 'bad_payload' | 'channel_unavailable';
  /** One audit line per webhook and reason per minute; a failure to write it never changes the answer. */
  const refused = async (hook: HookWithSecrets, reason: Reason): Promise<void> => {
    if (!onceAMinute(`${hook.id}:${reason}`)) return;
    await ctx.db
      .system(
        (sys) => ctx.audit.emit(sys, { type: 'webhooks.hook.use_failed', workspaceId: hook.workspace_id, teamId: hook.team_id, channelId: hook.channel_id, webhookId: hook.id, reason, at: ctx.runtime.now().toISOString() }),
        { workspaceId: hook.workspace_id },
      )
      .catch(() => undefined);
  };

  ctx.http.route({
    method: webhookCallRoute.method,
    path: webhookCallRoute.path,
    public: true,
    // csrf is for cookie sessions; a call carries none, and a browser form could not guess the secret address
    csrfExempt: true,
    rawBody: true,
    // a coarse per-address limit against floods and guessing (listed in docs/deploy/rate-limits.md); each webhook also has its own limit below
    rateLimit: { limit: 600, windowMs: 60_000 },
    rateLimitBy: 'address',
    handler: async (req) => {
      const { webhookId, secret } = req.params as { webhookId: string; secret: string };
      const strangerKey = `hook\n${addressKey(req.ip)}`;
      // The lock only changes the answer for a call that would fail anyway. A good call from a locked address still goes through: senders share
      // addresses (GitHub's, a company's CI), and one of them posting to a rotated or revoked address must not silence the others' good webhooks.
      const barred = strangers.check(strangerKey);
      const stranger = (): HttpError => {
        if (barred.locked) return lockedError(barred, 'webhook calls');
        strangers.fail(strangerKey);
        return NOT_FOUND();
      };
      if (!ID_SHAPE.test(webhookId) || !SECRET_SHAPE.test(secret)) throw stranger();
      const hook = await ctx.db.system((sys) => loadHook(sys, webhookId));
      // one comparison whether or not the webhook exists, so the time does not say
      const matches = secretMatches(secret, hook?.secret_hash ?? null);
      if (!hook) throw stranger();
      if (hook.revoked_at !== null) {
        await refused(hook, 'revoked');
        throw stranger();
      }
      if (!matches) {
        await refused(hook, 'bad_secret');
        throw stranger();
      }

      const slot = limiter.hit(hook.id, perMinute, 60_000);
      if (!slot.allowed) {
        await refused(hook, 'rate_limited');
        throw new HttpError(429, 'rate_limited', `This webhook accepts ${perMinute} calls a minute. Try again shortly.`, { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) });
      }

      let raw: Buffer;
      try {
        raw = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) await refused(hook, 'too_large');
        throw err;
      }

      if (hook.signing_secret_id !== null) {
        const signingId = hook.signing_secret_id;
        const signing = await ctx.db.system((sys) => ctx.secrets.get(sys, signingId), { workspaceId: hook.workspace_id }).catch(() => null);
        if (signing === null || !callIsSigned(signing, raw, req.headers)) {
          await refused(hook, 'bad_signature');
          throw new HttpError(401, 'unauthenticated', 'The call is not signed with this webhook’s signing secret');
        }
      }

      const contentType = req.headers['content-type'] ?? '';
      const text = raw.toString('utf8');
      const adapted = adapt({ headers: req.headers, contentType, raw: text, json: parseBody(contentType, text) });
      if (adapted.kind === 'reject') {
        await refused(hook, 'bad_payload');
        await recordUse(ctx, hook, 'failed');
        throw new HttpError(400, 'validation_failed', adapted.reason);
      }
      if (adapted.kind === 'ignore') {
        await recordUse(ctx, hook, 'ignored');
        return json(WebhookCallResponse.parse({ ok: true, ignored: adapted.reason }));
      }
      try {
        const posted = await postAsWebhook(ctx, hook, adapted.text);
        return json(WebhookCallResponse.parse({ ok: true, messageId: posted.messageId }));
      } catch (err) {
        await recordUse(ctx, hook, 'failed');
        const status = statusOf(err);
        if (status !== undefined && status < 500) {
          await refused(hook, 'channel_unavailable');
          throw new HttpError(409, 'conflict', status === 409 ? 'The channel is archived, so nothing can be posted in it' : 'The channel is not available for posting');
        }
        throw err;
      }
    },
  });
}
