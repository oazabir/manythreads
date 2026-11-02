import { HttpError, createLockout, type HttpRequest, type HttpResponse, type MessageProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { API_TOKEN_RATE_PER_MINUTE, SLACK_METHODS, WEBHOOK_FAILURE_LOCK, addressKey, type SlackMethod } from '@manythreads/shared';
import { adaptSlackMessage } from './adapters/index.ts';
import { emojiFromSlackName } from './emoji.ts';
import { WEBHOOK_COLUMNS, type WebhookRow } from './hooks.ts';
import { createOncePer, createWindowLimiter, type WindowLimiter } from './limiter.ts';
import { readBody } from './routes-call.ts';
import { API_TOKEN_SHAPE, hashWebhookSecret, secretMatches } from './secrets.ts';
import { isTs, messageIdToTs, tsToIdRange } from './ts.ts';

// The Slack-shaped web API (PLAN P14-14): `POST /api/slack/chat.postMessage`, `chat.update`, `reactions.add`, `reactions.remove` and `auth.test`, so a script
// written for Slack's API works against a channel here by changing the address and the token. docs/plugins/webhooks.md has the full table.
//
//  - The caller presents an **integration token** (`Authorization: Bearer mtat_...`, or a `token` field). The token is one integration's, scoped to the
//    channels a lead picked and to the methods a lead allowed; everything it writes carries that integration's name and the Webhook mark.
//  - A body is JSON or a form, like Slack's. Answers are `{ ok: true, ... }` or `{ ok: false, error: "..." }` with HTTP 200 for every Slack-style error, so a
//    client library that reads `ok` works. The two exceptions are the ones Slack makes too: 429 with `Retry-After` when a limit is passed (a Slack client
//    library waits and retries on exactly that), and 413 for a body over a megabyte.
//  - A message is written and edited and reacted to through the channels plugin's own `messages` provider, as the integration's actor: the same events,
//    live push, unread counts and edit history as a person's message. Mentions are never recorded and `@name` / `@here` / `@channel` are broken in the
//    text, so a script cannot wake anybody (`skipRefs` plus the shared text cleaning).
//  - Every call made with a known token is one audit line (`webhooks.token.used`: method, channel, outcome, message id; never the text).

/** The most a call body may hold (Slack's own limit is a megabyte too). */
export const MAX_SLACK_BODY_BYTES = 1_048_576;
/** Slack's limit for the text of one message. */
export const MAX_SLACK_TEXT = 40_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Slack-style refusal: `code` goes out as `error`; `extra` is merged into the answer (`needed`, `provided`). */
export class SlackError extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}
const fail = (code: string, extra?: Record<string, unknown>): never => {
  throw new SlackError(code, extra);
};

interface ChannelInfo {
  id: string;
  name: string;
  archived: boolean;
}

/** The integration a token belongs to, with what the token may do. */
export interface Principal {
  hook: WebhookRow;
  scopes: readonly string[];
  channels: readonly ChannelInfo[];
  teamName: string;
}

interface PrincipalRow extends WebhookRow {
  secret_hash: Buffer | null;
  scopes: string[];
  team_name: string;
}

/** The live API integration whose token has this hash, or null. Run as the system role: the public route has no session. */
export async function loadPrincipal(tx: PluginTx, tokenHash: Buffer, token: string): Promise<Principal | null> {
  const res = await tx.query<PrincipalRow>(
    `SELECT ${WEBHOOK_COLUMNS}, s.secret_hash, a.scopes, t.name AS team_name
       FROM app.webhook_secrets s
       JOIN app.webhooks w ON w.id = s.webhook_id AND w.kind = 'api' AND w.revoked_at IS NULL
       JOIN app.webhook_api a ON a.webhook_id = w.id
       JOIN app.teams t ON t.id = w.team_id
      WHERE s.secret_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  // the comparison is made again, in constant time, on the stored hash
  if (!row || !secretMatches(token, row.secret_hash)) return null;
  const channels = (
    await tx.query<{ id: string; name: string; archived: boolean }>(
      `SELECT c.id, c.name, (c.archived_at IS NOT NULL) AS archived
         FROM app.webhook_channels wc JOIN app.channels c ON c.id = wc.channel_id
        WHERE wc.webhook_id = $1::uuid ORDER BY wc.position, c.name`,
      [row.id],
    )
  ).rows;
  return { hook: row, scopes: row.scopes, channels, teamName: row.team_name };
}

/** Which of the token's channels a call means: an id, or a name (`#general` or `general`). Anything else is "not found"; a well-formed id of another channel is "not in channel". */
export function resolveChannel(p: Principal, raw: unknown): ChannelInfo {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('channel_not_found');
  const text = raw.trim();
  if (UUID.test(text)) {
    const own = p.channels.find((c) => c.id === text.toLowerCase());
    // the same answer whether the channel exists or not: a token learns nothing about channels it was not given
    return own ?? fail('not_in_channel');
  }
  const name = text.replace(/^#/, '').toLowerCase();
  return p.channels.find((c) => c.name.toLowerCase() === name) ?? fail('channel_not_found');
}

type Args = Record<string, unknown>;

const isObject = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a call carries, from the query string and the body (JSON or form). `bad` is the Slack error word when the body could not be read. */
export async function readArgs(req: HttpRequest): Promise<{ args: Args; bad: string | null }> {
  const args: Args = {};
  // `token` is never read from the query string: an address is written to access logs and proxies, a header or a body is not. The other fields may come from it.
  for (const [k, v] of Object.entries(req.query)) if (v !== undefined && k !== 'token') args[k] = v;
  const raw = (await readBody(req, MAX_SLACK_BODY_BYTES)).toString('utf8');
  if (raw.trim() === '') return { args, bad: null };
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  try {
    if (type.includes('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(raw)) args[k] = v;
      return { args, bad: null };
    }
    if (type.includes('json') || /^\s*\{/.test(raw)) {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) return { args, bad: 'invalid_json' };
      Object.assign(args, parsed);
      return { args, bad: null };
    }
  } catch {
    return { args, bad: 'invalid_json' };
  }
  return { args, bad: 'invalid_form_data' };
}

/** The token a call presents: the `Authorization: Bearer` header (as Slack's libraries send it), else a `token` field. */
function tokenOf(req: HttpRequest, args: Args): string | null {
  const header = req.headers['authorization'];
  if (header !== undefined) {
    const m = /^bearer\s+(\S+)\s*$/i.exec(header);
    return m ? (m[1] as string) : null;
  }
  return typeof args['token'] === 'string' && args['token'] !== '' ? args['token'] : null;
}

/** `blocks` and `attachments` arrive as JSON text in a form and as arrays in JSON. */
function listArg(raw: unknown, error: string): unknown[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return fail(error);
    }
  }
  return Array.isArray(value) ? value : fail(error);
}

/** The Markdown a call's `text`, `blocks` and `attachments` come to, and how many blocks were left out. */
export function readContent(args: Args): { body: string; skipped: number } {
  const text = args['text'];
  if (text !== undefined && text !== null && typeof text !== 'string') fail('invalid_arguments');
  if (typeof text === 'string' && text.length > MAX_SLACK_TEXT) fail('msg_too_long');
  const blocks = listArg(args['blocks'], 'invalid_blocks');
  const attachments = listArg(args['attachments'], 'invalid_attachments');
  const message: Args = {};
  if (typeof text === 'string') message['text'] = text;
  if (blocks) message['blocks'] = blocks;
  if (attachments) message['attachments'] = attachments;
  const adapted = adaptSlackMessage(message);
  if (adapted.kind !== 'post') return fail('no_text');
  return { body: adapted.text, skipped: adapted.skipped ?? 0 };
}

interface Outcome {
  /** The body of an ok answer (without `ok`). */
  data: Args;
  channelId: string | null;
  messageId: string | null;
  /** Whether a message was written (counted on the integration as a post). */
  posted: boolean;
}

export interface SlackApiDeps {
  limiter?: WindowLimiter;
  /** Calls per minute one token accepts. Default `API_TOKEN_RATE_PER_MINUTE`, or `MANYTHREADS_API_TOKEN_RATE_PER_MINUTE`. */
  perMinute?: number;
}

const perMinuteFromEnv = (): number => {
  const n = Number(process.env['MANYTHREADS_API_TOKEN_RATE_PER_MINUTE']);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : API_TOKEN_RATE_PER_MINUTE;
};

const slack = (body: Args, status = 200, headers?: Record<string, string>): HttpResponse => ({ status, body, ...(headers ? { headers } : {}) });

export function registerSlackApi(ctx: PluginContext, deps: SlackApiDeps = {}): void {
  const limiter = deps.limiter ?? createWindowLimiter();
  const perMinute = deps.perMinute ?? perMinuteFromEnv();
  const onceAMinute = createOncePer(60_000);
  // The route has NO per-address counter of its own (it is listed in ABUSE_ROUTES as 'failures', like /mcp): only calls with a token that names no live
  // integration count, per client address. 30 in 5 minutes lock the address for 5 minutes, and a locked address gets 429 for its failing calls. A call with
  // a right token is never refused by an address counter (senders share addresses), so junk from a shared address cannot shut out a valid caller; each
  // token has its own limit below.
  const strangers = createLockout({ now: ctx.runtime.now, ...WEBHOOK_FAILURE_LOCK });

  const messagesOrFail = (): MessageProvider => ctx.providers.get<MessageProvider>('messages') ?? fail('internal_error');

  /** Runs `fn` as the integration's own actor, in one system transaction scoped to its workspace. */
  const asIntegration = <T>(p: Principal, fn: (tx: PluginTx) => Promise<T>): Promise<T> =>
    ctx.db.system(
      async (sys) => {
        await sys.query('SELECT app.webhooks_act_as($1::uuid)', [p.hook.id]);
        return fn({ actor: { kind: 'system', id: p.hook.actor_id, workspaceId: p.hook.workspace_id }, query: (t, v) => sys.query(t, v) });
      },
      { workspaceId: p.hook.workspace_id },
    );

  /** A provider refusal (it carries an HTTP-like `status`) as the Slack word for it. */
  const mapProviderError = (err: unknown, words: { 403?: string; 404?: string; 409?: string; 400?: string }): never => {
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number') {
      const word = words[status as 403 | 404 | 409 | 400];
      if (word !== undefined) throw new SlackError(word);
    }
    throw err;
  };

  /** The message a `ts` names in a channel, preferring one of the integration's own (two messages in one microsecond share a `ts`). */
  const findByTs = async (tx: PluginTx, channelId: string, ts: unknown, actorId: string): Promise<{ id: string; author_id: string; deleted: boolean; thread_root_id: string | null } | null> => {
    if (!isTs(ts)) return null;
    const range = tsToIdRange(ts);
    if (!range) return null;
    const res = await tx.query<{ id: string; author_id: string; deleted: boolean; thread_root_id: string | null }>(
      `SELECT m.id, m.author_id, (m.deleted_at IS NOT NULL) AS deleted, m.thread_root_id
         FROM app.messages m
        WHERE m.channel_id = $1::uuid AND m.id BETWEEN $2::uuid AND $3::uuid
        ORDER BY (m.author_id = $4::uuid) DESC, m.id LIMIT 1`,
      [channelId, range.lo, range.hi, actorId],
    );
    return res.rows[0] ?? null;
  };

  const messageObject = (p: Principal, id: string, text: string, threadRootId: string | null): Args => ({
    type: 'message',
    subtype: 'bot_message',
    text,
    user: p.hook.id,
    bot_id: p.hook.id,
    username: p.hook.name,
    ts: messageIdToTs(id),
    ...(threadRootId ? { thread_ts: messageIdToTs(threadRootId) } : {}),
  });

  const warnings = (skipped: number): Args =>
    skipped > 0 ? { skipped_blocks: skipped, warning: 'skipped_blocks', response_metadata: { warnings: ['skipped_blocks'] } } : {};

  // ---- the methods ------------------------------------------------------------------------------------------------------------------------------------

  const postMessage = async (p: Principal, args: Args): Promise<Outcome> => {
    const channel = resolveChannel(p, args['channel']);
    if (channel.archived) fail('is_archived');
    const content = readContent(args);
    const provider = messagesOrFail();
    const posted = await asIntegration(p, async (tx) => {
      let threadRootId: string | null = null;
      const threadTs = args['thread_ts'];
      if (threadTs !== undefined && threadTs !== null && threadTs !== '') {
        const parent = await findByTs(tx, channel.id, threadTs, p.hook.actor_id);
        if (!parent || parent.deleted) fail('thread_not_found');
        threadRootId = parent?.thread_root_id ?? parent?.id ?? null;
      }
      try {
        return await provider.post(tx, { channelId: channel.id, body: content.body, threadRootId, skipRefs: true });
      } catch (err) {
        return mapProviderError(err, { 400: 'invalid_arguments', 403: 'channel_not_found', 404: 'channel_not_found', 409: threadRootId ? 'thread_not_found' : 'is_archived' });
      }
    });
    return {
      data: { channel: channel.id, ts: messageIdToTs(posted.id), message: messageObject(p, posted.id, content.body, posted.threadRootId), ...warnings(content.skipped) },
      channelId: channel.id,
      messageId: posted.id,
      posted: true,
    };
  };

  const update = async (p: Principal, args: Args): Promise<Outcome> => {
    const channel = resolveChannel(p, args['channel']);
    if (channel.archived) fail('is_archived');
    const content = readContent(args);
    const provider = messagesOrFail();
    const edited = await asIntegration(p, async (tx) => {
      const found = await findByTs(tx, channel.id, args['ts'], p.hook.actor_id);
      if (!found || found.deleted) return fail('message_not_found');
      // only what this integration wrote: another integration's, a person's and a bot's messages are not its to edit
      if (found.author_id !== p.hook.actor_id) return fail('cant_update_message');
      try {
        const done = await provider.edit(tx, { channelId: channel.id, messageId: found.id, body: content.body });
        return { id: done.id, threadRootId: found.thread_root_id };
      } catch (err) {
        return mapProviderError(err, { 400: 'invalid_arguments', 403: 'cant_update_message', 404: 'message_not_found', 409: 'cant_update_message' });
      }
    });
    return {
      data: { channel: channel.id, ts: messageIdToTs(edited.id), text: content.body, message: messageObject(p, edited.id, content.body, edited.threadRootId), ...warnings(content.skipped) },
      channelId: channel.id,
      messageId: edited.id,
      posted: false,
    };
  };

  const react = (add: boolean) => async (p: Principal, args: Args): Promise<Outcome> => {
    const channel = resolveChannel(p, args['channel']);
    if (add && channel.archived) fail('is_archived');
    const looked = emojiFromSlackName(args['name']);
    if (looked.kind === 'unknown') fail('invalid_name');
    const provider = messagesOrFail();
    const done = await asIntegration(p, async (tx) => {
      let emoji: string;
      if (looked.kind === 'unicode') emoji = looked.emoji;
      else {
        // a name that is not in the table must be a picture the workspace added
        const name = looked.kind === 'custom' ? looked.name : '';
        const own = await tx.query('SELECT 1 FROM app.custom_emoji WHERE workspace_id = $1::uuid AND name = $2', [p.hook.workspace_id, name]);
        if (own.rows.length === 0) return fail('invalid_name');
        emoji = `:${name}:`;
      }
      const found = await findByTs(tx, channel.id, args['timestamp'] ?? args['ts'], p.hook.actor_id);
      if (!found || found.deleted) return fail('message_not_found');
      try {
        const r = await provider.react(tx, { channelId: channel.id, messageId: found.id, emoji, add });
        if (!r.changed) fail(add ? 'already_reacted' : 'no_reaction');
        return { messageId: found.id };
      } catch (err) {
        return mapProviderError(err, { 400: 'invalid_name', 403: 'channel_not_found', 404: 'message_not_found', 409: add ? 'message_not_found' : 'is_archived' });
      }
    });
    return { data: {}, channelId: channel.id, messageId: done.messageId, posted: false };
  };

  const authTest = (p: Principal): Outcome => ({
    data: {
      url: `${ctx.runtime.publicUrl.replace(/\/+$/, '')}/`,
      team: p.teamName,
      team_id: p.hook.team_id,
      user: p.hook.name,
      user_id: p.hook.id,
      bot_id: p.hook.id,
      is_enterprise_install: false,
      // not Slack's, but what a script needs to start: the channels this token reaches
      channels: p.channels.map((c) => ({ id: c.id, name: c.name })),
    },
    channelId: p.channels[0]?.id ?? null,
    messageId: null,
    posted: false,
  });

  const METHODS: Record<SlackMethod, (p: Principal, args: Args) => Promise<Outcome>> = {
    'chat.postMessage': postMessage,
    'chat.update': update,
    'reactions.add': react(true),
    'reactions.remove': react(false),
  };

  // ---- one call -----------------------------------------------------------------------------------------------------------------------------------------

  /** What the call came to, kept on the integration ("last used") and in the audit trail. A failure to write it never changes the answer. */
  const note = async (p: Principal, method: SlackMethod | 'auth.test', outcome: string, out: { channelId: string | null; messageId: string | null; posted: boolean }): Promise<void> => {
    await ctx.db
      .system(
        async (sys) => {
          await sys.query(
            `UPDATE app.webhooks SET last_used_at = now(), last_status = $2, call_count = call_count + 1, posted_count = posted_count + CASE WHEN $3::boolean THEN 1 ELSE 0 END WHERE id = $1::uuid`,
            [p.hook.id, outcome === 'ok' ? 'posted' : 'failed', out.posted],
          );
          await ctx.audit.emit(sys, {
            type: 'webhooks.token.used',
            workspaceId: p.hook.workspace_id,
            teamId: p.hook.team_id,
            channelId: out.channelId ?? p.channels[0]?.id ?? p.hook.channel_id,
            webhookId: p.hook.id,
            method,
            outcome,
            messageId: out.messageId,
            at: ctx.runtime.now().toISOString(),
          });
        },
        { workspaceId: p.hook.workspace_id },
      )
      .catch(() => undefined);
  };

  const limited = (retryAfterMs: number): HttpResponse =>
    slack({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });

  const handle = async (method: SlackMethod | 'auth.test', req: HttpRequest): Promise<HttpResponse> => {
    const strangerKey = `slack\n${addressKey(req.ip)}`;
    const barred = strangers.check(strangerKey);
    let read: { args: Args; bad: string | null };
    try {
      read = await readArgs(req);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      read = { args: {}, bad: 'invalid_json' };
    }
    const token = tokenOf(req, read.args);
    if (token === null) return slack({ ok: false, error: 'not_authed' });
    const principal = API_TOKEN_SHAPE.test(token) ? await ctx.db.system((sys) => loadPrincipal(sys, hashWebhookSecret(token), token)) : null;
    if (principal === null) {
      if (barred.locked) return limited(barred.retryAfterMs);
      strangers.fail(strangerKey);
      return slack({ ok: false, error: 'invalid_auth' });
    }

    const none = { channelId: null, messageId: null, posted: false };
    const refuse = async (error: string, extra: Record<string, unknown> = {}): Promise<HttpResponse> => {
      await note(principal, method, error, none);
      return slack({ ok: false, error, ...extra });
    };

    const slot = limiter.hit(`token:${principal.hook.id}`, perMinute, 60_000);
    if (!slot.allowed) {
      if (onceAMinute(`${principal.hook.id}:rate_limited`)) await note(principal, method, 'rate_limited', none);
      return limited(slot.retryAfterMs);
    }
    if (method !== 'auth.test' && !principal.scopes.includes(method)) return refuse('missing_scope', { needed: method, provided: principal.scopes.join(',') });
    if (read.bad !== null) return refuse(read.bad);

    try {
      const out = method === 'auth.test' ? authTest(principal) : await METHODS[method](principal, read.args);
      await note(principal, method, 'ok', out);
      return slack({ ok: true, ...out.data });
    } catch (err) {
      if (err instanceof SlackError) {
        const channelId = principal.channels.find((c) => c.id === (typeof read.args['channel'] === 'string' ? read.args['channel'].toLowerCase() : ''))?.id ?? null;
        await note(principal, method, err.code, { channelId, messageId: null, posted: false });
        return slack({ ok: false, error: err.code, ...err.extra });
      }
      throw err;
    }
  };

  for (const method of [...SLACK_METHODS, 'auth.test'] as const) {
    const path = `/api/slack/${method}`;
    const verbs = method === 'auth.test' ? (['POST', 'GET'] as const) : (['POST'] as const);
    for (const verb of verbs) {
      ctx.http.route({
        method: verb,
        path,
        public: true,
        // a call carries no cookie, so there is nothing for a forged page to ride on
        csrfExempt: true,
        rawBody: true,
        // no per-address counter here on purpose: see `strangers` above; the entry in ABUSE_ROUTES (docs/deploy/rate-limits.md) says 'failures'
        handler: (req) => handle(method, req),
      });
    }
  }
}
