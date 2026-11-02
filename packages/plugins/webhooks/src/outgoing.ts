import type { MessageProvider, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { DEFAULT_DEPS, SafeFetchError, safeFetch, type SafeFetchDeps } from '@manythreads/sdk/safe-fetch';
import {
  ChannelMessagePostedEvent,
  OUTGOING_MAX_REPLY_BYTES,
  OUTGOING_MAX_TEXT,
  OUTGOING_TIMEOUT_MS,
  OutgoingPayload,
} from '@manythreads/shared';
import { adaptSlackMessage } from './adapters/index.ts';
import { clip } from './adapters/md.ts';
import { createOncePer, createWindowLimiter } from './limiter.ts';
import { outgoingSignature } from './secrets.ts';
import { messageIdToTs } from './ts.ts';
import { z } from 'zod';

// Outgoing webhooks (PLAN P14-14). A lead sets, for one channel, some trigger words and an address. When a person's message in the channel starts with (or
// contains) a trigger word, the server sends it to the address as a JSON call shaped like Slack's outgoing webhook, and if the receiver answers with
// `{ "text": "..." }` that text is posted back in the channel as the integration (a Webhook-marked author), once.
//
//  - It is a background job. The event subscriber only asks "does this channel have a live hook, and does the message match?" and queues one job per
//    (hook, message), deduplicated. The job (`detached`: no database transaction is open while the receiver is waited for) loads everything again in a
//    short transaction, so a revoked hook, a deleted message or an archived channel stops it, then sends.
//  - The address is reached only through the shared guarded fetcher (`@manythreads/sdk/safe-fetch`): public addresses only, ports 80 and 443, the name
//    resolved once and dialled by its vetted address, redirects (307 and 308 only, at most two) vetted again, 5 seconds for everything, the answer read up to
//    64 KB. The `pre_egress` chain judges the destination (the workspace's air-gapped / strict-egress presets, the team's own list of hosts) and the text
//    (the data-loss check redacts or refuses) before anything leaves.
//  - Delivery is at least once and says so: a try that fails for a reason that can pass (timeout, 5xx, 429, a dropped connection) is retried with backoff up
//    to five times, then dead-lettered; a refusal that cannot change (a blocked address, a 4xx answer, the policy) is dead at once. The receiver can tell a
//    repeat by `message_id`. The row in `app.webhook_deliveries` is the once-only guard for the reply and the record the lead sees.
//  - Loop guard: only a **person's** message triggers a hook. The reply is written by the integration's own actor (a system actor), so it can never trigger
//    this hook or another; and a reply is posted only in the same transaction that marks the delivery done, so it is posted once.

export const OUTGOING_QUEUE = 'webhooks.outgoing';
export const OUTGOING_PURGE_QUEUE = 'webhooks.outgoing_purge';
export const OUTGOING_MAX_ATTEMPTS = 5;
/** Most messages one hook is sent per minute; past it a message is not sent (one dead-letter line a minute says so). */
export const OUTGOING_PER_MINUTE = 60;
/** The most of a reply that is posted back, in characters. */
export const OUTGOING_MAX_REPLY_TEXT = 8_000;
const DELIVERY_KEEP = '14 days';
const PURGE_CRON = '41 3 * * *';
const DESTINATION = 'webhook_out';

/** What the delivery uses instead of the real network, in tests. The server runs in the test process, so a test sets `fetchDeps` here (see link-preview's `DEFAULT_JOB_DEPS`). */
export const OUTGOING_DEPS: { fetchDeps: SafeFetchDeps } = { fetchDeps: DEFAULT_DEPS };

/**
 * Browser specs run the whole server in another process, so they cannot set `OUTGOING_DEPS`. With `NODE_ENV=test` and `MANYTHREADS_STACK_WEBHOOK_RECEIVER=<port>`
 * a name ending in `.fake.example` resolves to a public number (so every rule of the guarded fetch still runs on it) and the connection to that number is made to
 * 127.0.0.1:<port>, where the spec's receiver listens. Any other name does not resolve. Never active outside `NODE_ENV=test`.
 */
export function testReceiverDeps(env: Readonly<Record<string, string | undefined>>): SafeFetchDeps | null {
  if (env['NODE_ENV'] !== 'test') return null;
  const port = Number(env['MANYTHREADS_STACK_WEBHOOK_RECEIVER']);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    resolve: async (host) => {
      if (host.endsWith('.fake.example')) return [{ address: '93.184.216.34', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    dial: () => ({ host: '127.0.0.1', port }),
  };
}

// ---- matching -----------------------------------------------------------------------------------------------------------------------------------------

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/**
 * The first trigger word that `body` starts with (`starts`) or contains (`contains`), as the hook has it written, or null. Capitals do not matter. A
 * word matches as a whole word: "deploy" is in "please deploy now" and in "deploy!", not in "deployment" (the check looks only at the edges that are
 * letters, digits or underscores, so a trigger such as "!deploy" or "/run" works). `starts` ignores leading spaces. Linear in the text for each word.
 */
export function matchTrigger(body: string, words: readonly string[], mode: 'starts' | 'contains'): string | null {
  const text = body.slice(0, 40_000).toLowerCase();
  const start = text.search(/\S/);
  if (start < 0) return null;
  for (const word of words) {
    const w = word.trim().toLowerCase();
    if (w === '') continue;
    const wordEndsWithWordChar = isWordChar(w[w.length - 1]);
    const wordStartsWithWordChar = isWordChar(w[0]);
    if (mode === 'starts') {
      if (text.startsWith(w, start) && !(wordEndsWithWordChar && isWordChar(text[start + w.length]))) return word;
      continue;
    }
    for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + 1)) {
      const before = at > 0 ? text[at - 1] : undefined;
      const after = text[at + w.length];
      if (wordStartsWithWordChar && isWordChar(before)) continue;
      if (wordEndsWithWordChar && isWordChar(after)) continue;
      return word;
    }
  }
  return null;
}

// ---- reading the receiver's answer ---------------------------------------------------------------------------------------------------------------------

export interface Reply {
  text: string;
  /** `response_type: "comment"`: answer in a thread under the message, even when it was not in one. */
  inThread: boolean;
}

/**
 * The message a receiver's answer asks for, or null when it asks for none. Slack's and Mattermost's reply shapes: `{ "text": "..." }`, with `blocks`
 * and `attachments` read as for `chat.postMessage`. An answer that is not a JSON object, has nothing to show, or is `ephemeral` (meant for one person,
 * which a webhook reply cannot be) posts nothing. The text is cleaned like every text from outside: no raw HTML, and no `@name`, `@here` or `@channel` that
 * would notify anybody.
 */
export function parseReply(body: Buffer): Reply | null {
  if (body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o['response_type'] === 'ephemeral') return null;
  const message: Record<string, unknown> = {};
  for (const key of ['text', 'blocks', 'attachments'] as const) if (o[key] !== undefined) message[key] = o[key];
  if (Object.keys(message).length === 0) return null;
  const adapted = adaptSlackMessage(message);
  if (adapted.kind !== 'post' || adapted.text.trim() === '') return null;
  return { text: clip(adapted.text, OUTGOING_MAX_REPLY_TEXT), inThread: o['response_type'] === 'comment' };
}

// ---- what a failure means ------------------------------------------------------------------------------------------------------------------------------

export interface Failure {
  /** A short category for the lead (`timeout`, `status_503`, `blocked_address`); never an address or a body. */
  reason: string;
  /** Whether another try can pass. */
  retry: boolean;
  statusCode: number | null;
  /** The receiver did answer 2xx, but the answer could not be read: the call counts as delivered, with no reply. */
  deliveredAnyway?: boolean;
}

/** How a failed send is treated. Pure. */
export function classifyFailure(err: unknown): Failure {
  if (!(err instanceof SafeFetchError)) return { reason: 'internal_error', retry: true, statusCode: null };
  switch (err.code) {
    case 'bad_status': {
      const status = err.status ?? 0;
      const again = status === 408 || status === 425 || status === 429 || status >= 500;
      return { reason: `status_${status}`, retry: again, statusCode: status || null };
    }
    case 'timeout':
    case 'network':
    case 'dns_failed':
      return { reason: err.code, retry: true, statusCode: null };
    case 'too_large':
    case 'bad_type':
    case 'bad_encoding':
      return { reason: err.code, retry: false, statusCode: null, deliveredAnyway: true };
    default:
      // blocked_address, blocked_host, blocked_port, blocked_scheme, blocked_by_policy, bad_url, too_many_redirects, bad_redirect, host_cooling
      return { reason: err.code, retry: false, statusCode: null };
  }
}

// ---- the call ------------------------------------------------------------------------------------------------------------------------------------------

export interface HookTarget {
  id: string;
  workspaceId: string;
  teamId: string;
  teamSlug: string;
  channelId: string;
  channelName: string;
  actorId: string;
  name: string;
  url: string;
  triggerWords: string[];
  match: 'starts' | 'contains';
  verificationToken: string;
  signingSecretId: string | null;
  enabled: boolean;
  revoked: boolean;
  archived: boolean;
}

interface TargetRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  team_slug: string;
  channel_id: string;
  channel_name: string;
  actor_id: string;
  name: string;
  url: string;
  trigger_words: string[];
  match_mode: 'starts' | 'contains';
  verification_token: string;
  signing_secret_id: string | null;
  enabled: boolean;
  revoked: boolean;
  archived: boolean;
}

/** An outgoing webhook with what a delivery needs, or null. */
export async function loadTarget(tx: PluginTx, hookId: string): Promise<HookTarget | null> {
  const r = (
    await tx.query<TargetRow>(
      `SELECT w.id, w.workspace_id, w.team_id, t.slug AS team_slug, w.channel_id, c.name AS channel_name, w.actor_id, w.name,
              o.url, o.trigger_words, o.match_mode, o.verification_token, o.signing_secret_id, o.enabled,
              (w.revoked_at IS NOT NULL) AS revoked, (c.archived_at IS NOT NULL) AS archived
         FROM app.webhooks w
         JOIN app.webhook_outgoing o ON o.webhook_id = w.id
         JOIN app.teams t ON t.id = w.team_id
         JOIN app.channels c ON c.id = w.channel_id
        WHERE w.id = $1::uuid AND w.kind = 'outgoing'`,
      [hookId],
    )
  ).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    teamSlug: r.team_slug,
    channelId: r.channel_id,
    channelName: r.channel_name,
    actorId: r.actor_id,
    name: r.name,
    url: r.url,
    triggerWords: r.trigger_words,
    match: r.match_mode,
    verificationToken: r.verification_token,
    signingSecretId: r.signing_secret_id,
    enabled: r.enabled,
    revoked: r.revoked,
    archived: r.archived,
  };
}

export interface TriggerMessage {
  id: string;
  channelId: string;
  body: string;
  threadRootId: string | null;
  deleted: boolean;
  authorKind: string;
  personId: string | null;
  authorName: string;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  channel_id: string;
  body: string;
  thread_root_id: string | null;
  deleted: boolean;
  author_kind: string;
  person_id: string | null;
  display_name: string | null;
}

export async function loadTriggerMessage(tx: PluginTx, workspaceId: string, messageId: string): Promise<TriggerMessage | null> {
  const r = (
    await tx.query<MessageRow>(
      `SELECT m.id, m.channel_id, m.body, m.thread_root_id, (m.deleted_at IS NOT NULL) AS deleted, a.kind AS author_kind,
              CASE WHEN a.kind = 'person' THEN a.ref_id END AS person_id, p.display_name
         FROM app.messages m
         JOIN app.actors a ON a.id = m.author_id
         LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
        WHERE m.id = $1::uuid AND m.workspace_id = $2::uuid`,
      [messageId, workspaceId],
    )
  ).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    channelId: r.channel_id,
    body: r.body,
    threadRootId: r.thread_root_id,
    deleted: r.deleted,
    authorKind: r.author_kind,
    personId: r.person_id,
    authorName: r.display_name ?? 'Someone',
  };
}

/** The body a receiver gets, for one message. `text` is cut at 16,000 characters (`truncated` says so). */
export function buildPayload(target: HookTarget, message: TriggerMessage, trigger: string, text: string): OutgoingPayload {
  const truncated = text.length > OUTGOING_MAX_TEXT;
  return OutgoingPayload.parse({
    token: target.verificationToken,
    team_id: target.teamId,
    team_domain: target.teamSlug,
    channel_id: target.channelId,
    channel_name: target.channelName,
    timestamp: messageIdToTs(message.id),
    user_id: message.personId ?? message.id,
    user_name: message.authorName,
    text: truncated ? text.slice(0, OUTGOING_MAX_TEXT) : text,
    trigger_word: trigger,
    message_id: message.id,
    ...(message.threadRootId ? { thread_ts: messageIdToTs(message.threadRootId) } : {}),
    ...(truncated ? { truncated: true } : {}),
  });
}

/** The headers of a call: JSON, the time, and (with a signing secret) the signature over `v0:<time>:<body>`. */
export function callHeaders(body: string, signingSecret: string | null, now: Date): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-manythreads-request-timestamp': timestamp,
    ...(signingSecret ? { 'x-manythreads-signature': outgoingSignature(signingSecret, timestamp, body) } : {}),
  };
}

type InTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

/** The workspace's guard preset and egress allowlist (kept by the model gateway; `standard` and none when it keeps none). */
async function loadEgressSetup(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

/**
 * The egress guard. `reach` is asked before every address the fetcher requests (the first one and each redirect): the destination, with no text. `content`
 * is asked once with the text that would leave: `allow`, or the redacted text, or a refusal. Fails closed when nothing guards the destination.
 */
function egress(ctx: PluginContext, inTx: InTx, scope: { workspaceId: string; teamId: string; setup: { preset: string; allowlist: string[] } }) {
  const ask = (host: string, text: string) =>
    inTx((tx) =>
      ctx.hooks.runPreEgress(tx, {
        destination: DESTINATION,
        workspaceId: scope.workspaceId,
        teamId: scope.teamId,
        text,
        preset: scope.setup.preset,
        allowlist: scope.setup.allowlist,
        targets: [{ name: 'outgoing-webhook', host: host.toLowerCase(), local: false }],
        recorded: false,
      }),
    );
  return {
    async reach(url: URL): Promise<void> {
      const d = await ask(url.hostname, '');
      if (d.hooks === 0 || d.outcome !== 'allow') throw new SafeFetchError('blocked_by_policy', d.message ?? 'The workspace guard does not let this address be reached.');
    },
    async content(host: string, text: string): Promise<string> {
      const d = await ask(host, text);
      if (d.hooks === 0 || d.outcome === 'block' || d.outcome === 'require_approval') {
        throw new SafeFetchError('blocked_by_policy', d.message ?? 'The workspace guard does not let this message be sent.');
      }
      return d.outcome === 'redact' ? d.text : text;
    },
  };
}

export interface Sent {
  statusCode: number;
  reply: Reply | null;
}

/**
 * Sends one call. Throws `SafeFetchError` for a refusal, a non-2xx answer or a network failure (see `classifyFailure`). No database transaction is held
 * while the receiver is waited for: `inTx` opens the short ones the guard needs.
 */
export async function sendCall(
  ctx: PluginContext,
  inTx: InTx,
  target: HookTarget,
  payloadFor: (text: string) => OutgoingPayload,
  originalText: string,
  signingSecret: string | null,
): Promise<Sent> {
  // A hook that has a signing secret is never sent unsigned: when the secret could not be read (the callers turn a failed read into null) this is a retryable
  // internal failure, not a call without a signature that the receiver would have to guess at.
  if (target.signingSecretId !== null && signingSecret === null) throw new Error('the signing secret could not be read');
  const setup = await inTx((tx) => loadEgressSetup(tx, target.workspaceId));
  const guard = egress(ctx, inTx, { workspaceId: target.workspaceId, teamId: target.teamId, setup });
  let host: string;
  try {
    host = new URL(target.url).hostname;
  } catch {
    throw new SafeFetchError('bad_url', 'That is not a web address.');
  }
  const text = await guard.content(host, originalText);
  const body = JSON.stringify(payloadFor(text));
  const answer = await safeFetch(
    target.url,
    {
      method: 'POST',
      body: Buffer.from(body, 'utf8'),
      headers: callHeaders(body, signingSecret, ctx.runtime.now()),
      maxBytes: OUTGOING_MAX_REPLY_BYTES,
      timeoutMs: OUTGOING_TIMEOUT_MS,
      maxRedirects: 2,
      overflow: 'truncate',
      accept: 'application/json, text/plain;q=0.5, */*;q=0.1',
      userAgent: 'manythreads-webhook/1.0',
      check: guard.reach,
    },
    OUTGOING_DEPS.fetchDeps,
  );
  // a truncated answer is not valid JSON: it posts nothing
  return { statusCode: answer.status, reply: answer.truncated ? null : parseReply(answer.body) };
}

// ---- the job ---------------------------------------------------------------------------------------------------------------------------------------------

const Payload = z.object({ workspaceId: z.uuid(), webhookId: z.uuid(), messageId: z.uuid() });

async function emitDelivered(
  ctx: PluginContext,
  tx: PluginTx,
  target: HookTarget,
  messageId: string,
  e: { outcome: 'delivered' | 'retry' | 'dead'; statusCode: number | null; reason: string | null; replied: boolean; attempt: number },
): Promise<void> {
  await ctx.audit.emit(tx, {
    type: 'webhooks.outgoing.delivered',
    workspaceId: target.workspaceId,
    teamId: target.teamId,
    channelId: target.channelId,
    webhookId: target.id,
    messageId,
    outcome: e.outcome,
    statusCode: e.statusCode,
    reason: e.reason,
    replied: e.replied,
    attempt: Math.min(e.attempt, 20),
    at: ctx.runtime.now().toISOString(),
  });
}

/** Posts the receiver's reply as the integration: its own actor, never a person, mentioning nobody. Returns whether a message was written. */
async function postReply(ctx: PluginContext, tx: PluginTx, target: HookTarget, message: TriggerMessage, reply: Reply): Promise<boolean> {
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return false;
  try {
    await tx.query('SAVEPOINT outgoing_reply');
    await tx.query('SELECT app.webhooks_act_as($1::uuid)', [target.id]);
    const asHook: PluginTx = { actor: { kind: 'system', id: target.actorId, workspaceId: target.workspaceId }, query: (t, v) => tx.query(t, v) };
    await messages.post(asHook, {
      channelId: target.channelId,
      body: reply.text,
      threadRootId: message.threadRootId ?? (reply.inThread ? message.id : null),
      skipRefs: true,
    });
    await tx.query('RELEASE SAVEPOINT outgoing_reply');
    return true;
  } catch {
    // a reply that cannot be posted (the channel was archived meanwhile, the thread's root was deleted) does not undo the delivery
    await tx.query('ROLLBACK TO SAVEPOINT outgoing_reply').catch(() => undefined);
    return false;
  }
}

/** What running one delivery came to (for tests and logs). */
export type DeliveryResult = 'skipped' | 'delivered' | 'retry' | 'dead';

/**
 * One try of one delivery. Throws only to make the queue try again later (after recording the try); returns when the delivery is finished or skipped.
 * `attempt` is 1 on the first run.
 */
export async function runDelivery(ctx: PluginContext, inTx: InTx, input: z.infer<typeof Payload>, attempt: number): Promise<DeliveryResult> {
  // 1. look again at everything the delivery depends on, and take the once-only row
  const plan = await inTx(async (tx) => {
    const target = await loadTarget(tx, input.webhookId);
    if (!target || target.workspaceId !== input.workspaceId || target.revoked || !target.enabled || target.archived) return null;
    const message = await loadTriggerMessage(tx, input.workspaceId, input.messageId);
    // the loop guard: a person's message in the hook's own channel, still there, still saying a trigger word
    if (!message || message.deleted || message.authorKind !== 'person' || message.channelId !== target.channelId) return null;
    const trigger = matchTrigger(message.body, target.triggerWords, target.match);
    if (trigger === null) return null;
    const row = await tx.query<{ status: string }>(
      `INSERT INTO app.webhook_deliveries (webhook_id, message_id, workspace_id, status, attempts) VALUES ($1::uuid, $2::uuid, $3::uuid, 'retrying', $4)
       ON CONFLICT (webhook_id, message_id) DO UPDATE SET attempts = EXCLUDED.attempts, updated_at = now() WHERE app.webhook_deliveries.status = 'retrying'
       RETURNING status`,
      [target.id, message.id, target.workspaceId, attempt],
    );
    if (row.rows.length === 0) return null; // already delivered or given up: sent once
    const signing = target.signingSecretId ? await ctx.secrets.get(tx, target.signingSecretId).catch(() => null) : null;
    return { target, message, trigger, signing };
  });
  if (plan === null) return 'skipped';
  const { target, message, trigger, signing } = plan;

  // 2. send, with no transaction open
  let sent: Sent | null = null;
  let failure: Failure | null = null;
  try {
    sent = await sendCall(ctx, inTx, target, (text) => buildPayload(target, message, trigger, text), message.body, signing);
  } catch (err) {
    failure = classifyFailure(err);
  }

  // 3. record it, and post the reply in the same transaction that marks the delivery done
  if (sent !== null || failure?.deliveredAnyway === true) {
    const statusCode = sent?.statusCode ?? 200;
    await inTx(async (tx) => {
      const fresh = await loadTarget(tx, target.id);
      const replied = sent?.reply && fresh && !fresh.revoked && fresh.enabled && !fresh.archived ? await postReply(ctx, tx, fresh, message, sent.reply) : false;
      await tx.query(`UPDATE app.webhook_deliveries SET status = 'delivered', attempts = $3, reason = NULL, updated_at = now() WHERE webhook_id = $1::uuid AND message_id = $2::uuid`, [target.id, message.id, attempt]);
      await tx.query(
        `UPDATE app.webhook_outgoing SET delivered_count = delivered_count + 1, last_delivery_at = now(), last_delivery_status = 'delivered', last_error = NULL WHERE webhook_id = $1::uuid`,
        [target.id],
      );
      await emitDelivered(ctx, tx, target, message.id, { outcome: 'delivered', statusCode, reason: null, replied, attempt });
    });
    return 'delivered';
  }

  const f = failure as Failure;
  const final = !f.retry || attempt >= OUTGOING_MAX_ATTEMPTS;
  await inTx(async (tx) => {
    await tx.query(`UPDATE app.webhook_deliveries SET status = $3, attempts = $4, reason = $5, updated_at = now() WHERE webhook_id = $1::uuid AND message_id = $2::uuid`, [
      target.id,
      message.id,
      final ? 'dead' : 'retrying',
      attempt,
      f.reason,
    ]);
    await tx.query(
      `UPDATE app.webhook_outgoing SET failed_count = failed_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END, last_delivery_at = now(), last_delivery_status = $3, last_error = $4 WHERE webhook_id = $1::uuid`,
      [target.id, final, final ? 'dead' : 'retrying', f.reason],
    );
    await emitDelivered(ctx, tx, target, message.id, { outcome: final ? 'dead' : 'retry', statusCode: f.statusCode, reason: f.reason, replied: false, attempt });
  });
  // a try that can pass again is retried by the queue, with backoff; the row above already says "retrying"
  if (!final) throw new Error(`outgoing webhook: try ${attempt} failed (${f.reason})`);
  return 'dead';
}

// ---- the subscriber and the queues --------------------------------------------------------------------------------------------------------------------

interface CandidateRow extends Record<string, unknown> {
  webhook_id: string;
  trigger_words: string[];
  match_mode: 'starts' | 'contains';
  body: string;
}

export function registerOutgoing(ctx: PluginContext): void {
  const limiter = createWindowLimiter();
  const onceAMinute = createOncePer(60_000);
  const forTests = testReceiverDeps(process.env);
  if (forTests) OUTGOING_DEPS.fetchDeps = forTests;

  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const e = ChannelMessagePostedEvent.safeParse(raw);
    if (!e.success) return;
    // one indexed query: only a person's live message, in a channel that has an enabled, live outgoing hook
    const hooks = (
      await tx.query<CandidateRow>(
        `SELECT w.id AS webhook_id, o.trigger_words, o.match_mode, m.body
           FROM app.webhooks w
           JOIN app.webhook_outgoing o ON o.webhook_id = w.id AND o.enabled
           JOIN app.messages m ON m.id = $1::uuid AND m.channel_id = w.channel_id
           JOIN app.actors a ON a.id = m.author_id AND a.kind = 'person'
          WHERE w.channel_id = $2::uuid AND w.kind = 'outgoing' AND w.revoked_at IS NULL AND m.deleted_at IS NULL`,
        [e.data.messageId, e.data.channelId],
      )
    ).rows;
    for (const h of hooks) {
      if (matchTrigger(h.body, h.trigger_words, h.match_mode) === null) continue;
      const slot = limiter.hit(h.webhook_id, OUTGOING_PER_MINUTE, 60_000);
      if (!slot.allowed) {
        if (onceAMinute(`${h.webhook_id}:rate`)) {
          await tx.query(
            `UPDATE app.webhook_outgoing SET failed_count = failed_count + 1, last_delivery_at = now(), last_delivery_status = 'dead', last_error = 'rate_limited' WHERE webhook_id = $1::uuid`,
            [h.webhook_id],
          );
        }
        continue;
      }
      await ctx.jobs.enqueue(tx, OUTGOING_QUEUE, { workspaceId: e.data.workspaceId, webhookId: h.webhook_id, messageId: e.data.messageId }, { dedupeKey: `out:${h.webhook_id}:${e.data.messageId}` });
    }
  });

  // `detached`: the receiver is waited for with no transaction open. One delivery per workspace at a time, two in the process.
  ctx.jobs.register(
    OUTGOING_QUEUE,
    async (payload, _tx, job) => {
      const p = Payload.parse(payload);
      await runDelivery(ctx, (fn) => job.transaction(fn), p, job.attempt);
    },
    { concurrency: 2, maxAttempts: OUTGOING_MAX_ATTEMPTS, detached: true, serialKey: 'workspaceId' },
  );

  // Delivery records are kept two weeks: long enough to see a dead letter and why, short enough to hold nothing about old traffic.
  ctx.jobs.register(
    OUTGOING_PURGE_QUEUE,
    async (_payload, tx, job) => {
      const gone = await tx.query(`DELETE FROM app.webhook_deliveries WHERE updated_at < now() - interval '${DELIVERY_KEEP}' RETURNING message_id`);
      if (gone.rows.length > 0) job.log.info(`webhooks: removed ${gone.rows.length} delivery record(s) older than ${DELIVERY_KEEP}`);
    },
    { cron: PURGE_CRON, maxAttempts: 1 },
  );
}
