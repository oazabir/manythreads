import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StandInContext, StandInHandle, StandInModule } from './types.ts';

/*
 * A Telegram Bot API stand-in (PLAN Bundle D, D23-D25). It answers the methods the chat bridge uses at `/bot<token>/<method>`, answers in Telegram's own envelope
 * (`{ok, result}` or `{ok: false, error_code, description}`) and checks what Telegram checks:
 *   - a wrong bot token is 401 `Unauthorized`; an unknown method is 404 `Not Found`;
 *   - `setWebhook` needs a url and keeps it with the `secret_token` (1-256 characters of A-Z a-z 0-9 _ -); the secret is never shown by `getWebhookInfo`;
 *   - while a webhook is set `getUpdates` is 409 `Conflict`, as at Telegram;
 *   - `sendMessage` needs a chat and a text of at most 4096 characters, and with `strictChats` a bot may only write to a chat that wrote to it first (403 `Forbidden`).
 * The other side, a person writing to the bot, is `telegramSend`: it POSTs an Update to the webhook with the header `X-Telegram-Bot-Api-Secret-Token`, or queues it
 * for `getUpdates` when no webhook is set. It never records the bot token; the state shows the bot's id and the messages it sent.
 */

export interface FakeTelegramBot {
  /** The token the bridge is given (BotFather's `<id>:<secret>`). */
  token: string;
  id: number;
  username: string;
  name: string;
}

export interface FakeTelegramOptions {
  bots?: Array<Partial<FakeTelegramBot>>;
  /** A bot may only write to a chat that has written to it (default false). */
  strictChats?: boolean;
}

export interface TelegramSentMessage {
  messageId: number;
  botId: number;
  chatId: string;
  text: string;
  parseMode: string | null;
  replyToMessageId: number | null;
  at: string;
}

export interface TelegramApiCall {
  botId: number | null;
  method: string;
  authorized: boolean;
  ok: boolean;
}

export interface TelegramWebhookInfo {
  botId: number;
  url: string;
  hasSecret: boolean;
  allowedUpdates: string[];
}

export interface TelegramDelivery {
  botId: number;
  updateId: number;
  /** The HTTP status the bridge answered; null when the bridge could not be reached. */
  status: number | null;
  /** Whether the secret header went out, and whether it was the right one. */
  secretHeader: 'right' | 'wrong' | 'missing' | 'none-set';
}

export interface TelegramSendInput {
  fromUserId: number;
  /** Default: the sender (a private chat). A group or supergroup needs its own id (negative). */
  chatId?: number | string;
  chatType?: 'private' | 'group' | 'supergroup';
  chatTitle?: string;
  text: string;
  username?: string;
  firstName?: string;
  /** Which bot is written to (its token); default the first. */
  botToken?: string;
  /** Default: counts up from 1000. Send the same number twice to play a replay. */
  updateId?: number;
  messageId?: number;
  /** `wrong`: a secret that is not the one set; `missing`: no header at all. Default: the right one. */
  secretHeader?: 'wrong' | 'missing';
  /** Post the same update this many times (default 1). */
  repeat?: number;
}

export interface TelegramSendResult {
  updateId: number;
  /** False when the update was queued for `getUpdates` because no webhook is set. */
  delivered: boolean;
  queued: boolean;
  responses: Array<{ status: number | null; body: string }>;
}

export interface FakeTelegram {
  url: string;
  bots: FakeTelegramBot[];
  sent: TelegramSentMessage[];
  calls: TelegramApiCall[];
  deliveries: TelegramDelivery[];
  /** The webhook of a bot including the secret it set: for a test that checks the header; never part of `state`. */
  webhook(botToken?: string): { url: string; secretToken: string | null } | null;
  telegramSend(input: TelegramSendInput): Promise<TelegramSendResult>;
  /** The next `count` calls of `method` (any method when omitted) answer `status`; 429 carries `retry_after`. */
  failNext(status: number, count?: number, options?: { method?: string; retryAfter?: number }): void;
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_TOKEN = '4242424242:FAKE-telegram-bot-token-for-tests-0001';

interface Webhook {
  url: string;
  secret: string | null;
  allowedUpdates: string[];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Telegram takes the parameters as a query, a form or JSON. */
function parameters(req: IncomingMessage, url: URL, body: string): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (body === '') return out;
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('json')) {
    try {
      return { ...out, ...asRecord(JSON.parse(body)) };
    } catch {
      return { ...out, __badJson: true };
    }
  }
  return { ...out, ...Object.fromEntries(new URLSearchParams(body)) };
}

export async function startFakeTelegram(options: FakeTelegramOptions & { host?: string; port?: number; publicHost?: string } = {}): Promise<FakeTelegram> {
  const initialBots: FakeTelegramBot[] = (options.bots?.length ? options.bots : [{}]).map((b, i) => ({
    token: b.token ?? (i === 0 ? DEFAULT_TOKEN : `${4242424242 + i}:FAKE-telegram-bot-token-for-tests-${String(i + 1).padStart(4, '0')}`),
    id: b.id ?? 4242424242 + i,
    username: b.username ?? (i === 0 ? 'manythreads_fake_bot' : `manythreads_fake_${i + 1}_bot`),
    name: b.name ?? 'manythreads',
  }));
  const bots = initialBots;
  const webhooks = new Map<number, Webhook>();
  const queues = new Map<number, Array<Record<string, unknown>>>();
  const knownChats = new Set<string>();
  const sent: TelegramSentMessage[] = [];
  const calls: TelegramApiCall[] = [];
  const deliveries: TelegramDelivery[] = [];
  let failure: { status: number; left: number; method: string | undefined; retryAfter: number } | null = null;
  let nextUpdateId = 1000;
  let nextMessageId = 1;

  const botOf = (token: string | undefined): FakeTelegramBot | undefined => (token === undefined ? bots[0] : bots.find((b) => b.token === token));
  const queueOf = (botId: number): Array<Record<string, unknown>> => {
    let q = queues.get(botId);
    if (!q) {
      q = [];
      queues.set(botId, q);
    }
    return q;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    const send = (status: number, doc: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    };
    const fail = (code: number, description: string, extra: Record<string, unknown> = {}): void => send(code, { ok: false, error_code: code, description, ...extra });
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!match) return fail(404, 'Not Found');
    const bot = botOf(decodeURIComponent(match[1]!));
    const method = match[2]!;
    const record = (authorized: boolean, ok: boolean): void => void calls.push({ botId: bot?.id ?? null, method, authorized, ok });
    if (!bot) {
      record(false, false);
      return fail(401, 'Unauthorized');
    }
    if (failure && failure.left > 0 && (failure.method === undefined || failure.method === method)) {
      failure.left--;
      record(true, false);
      return failure.status === 429
        ? fail(429, `Too Many Requests: retry after ${failure.retryAfter}`, { parameters: { retry_after: failure.retryAfter } })
        : fail(failure.status, 'Internal Server Error');
    }
    const p = parameters(req, url, body);
    if (p['__badJson'] === true) {
      record(true, false);
      return fail(400, 'Bad Request: can\'t parse JSON object');
    }
    const ok = (result: unknown, extra: Record<string, unknown> = {}): void => {
      record(true, true);
      send(200, { ok: true, result, ...extra });
    };
    const bad = (description: string, code = 400): void => {
      record(true, false);
      fail(code, description);
    };

    switch (method) {
      case 'getMe':
        return ok({ id: bot.id, is_bot: true, first_name: bot.name, username: bot.username, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false });
      case 'setWebhook': {
        const target = String(p['url'] ?? '');
        if (target === '') {
          // an empty url removes the webhook, as at Telegram
          webhooks.delete(bot.id);
          return ok(true, { description: 'Webhook is already deleted' });
        }
        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return bad('Bad Request: bad webhook: Invalid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return bad('Bad Request: bad webhook: HTTPS url must be provided for webhook');
        const secret = p['secret_token'] === undefined ? null : String(p['secret_token']);
        if (secret !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return bad('Bad Request: secret token contains unallowed characters');
        const allowed = typeof p['allowed_updates'] === 'string' ? (JSON.parse(p['allowed_updates']) as string[]) : Array.isArray(p['allowed_updates']) ? (p['allowed_updates'] as string[]) : [];
        webhooks.set(bot.id, { url: target, secret, allowedUpdates: allowed });
        if (p['drop_pending_updates'] === true || p['drop_pending_updates'] === 'true') queueOf(bot.id).length = 0;
        return ok(true, { description: 'Webhook was set' });
      }
      case 'deleteWebhook': {
        const had = webhooks.delete(bot.id);
        if (p['drop_pending_updates'] === true || p['drop_pending_updates'] === 'true') queueOf(bot.id).length = 0;
        return ok(true, { description: had ? 'Webhook was deleted' : 'Webhook is already deleted' });
      }
      case 'getWebhookInfo': {
        const w = webhooks.get(bot.id);
        return ok({ url: w?.url ?? '', has_custom_certificate: false, pending_update_count: queueOf(bot.id).length, max_connections: 40, ...(w && w.allowedUpdates.length > 0 ? { allowed_updates: w.allowedUpdates } : {}) });
      }
      case 'getUpdates': {
        if (webhooks.has(bot.id)) return bad("Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first", 409);
        const q = queueOf(bot.id);
        const offset = Number(p['offset'] ?? 0) || 0;
        // an offset confirms everything before it
        if (offset !== 0) q.splice(0, q.length, ...q.filter((u) => Number(u['update_id']) >= offset));
        const limit = Math.max(1, Math.min(100, Number(p['limit'] ?? 100) || 100));
        return ok(q.slice(0, limit));
      }
      case 'sendMessage': {
        const chat = p['chat_id'];
        if (chat === undefined || String(chat) === '') return bad('Bad Request: chat_id is empty');
        const text = typeof p['text'] === 'string' ? p['text'] : '';
        if (text === '') return bad('Bad Request: message text is empty');
        if (text.length > 4096) return bad('Bad Request: message is too long');
        if (options.strictChats === true && !knownChats.has(String(chat))) return bad("Forbidden: bot can't initiate conversation with a user", 403);
        const reply = p['reply_to_message_id'] ?? asRecord(typeof p['reply_parameters'] === 'string' ? safeJson(p['reply_parameters']) : p['reply_parameters'])['message_id'];
        const message: TelegramSentMessage = {
          messageId: nextMessageId++,
          botId: bot.id,
          chatId: String(chat),
          text,
          parseMode: typeof p['parse_mode'] === 'string' ? p['parse_mode'] : null,
          replyToMessageId: reply === undefined ? null : Number(reply),
          at: new Date().toISOString(),
        };
        sent.push(message);
        return ok({
          message_id: message.messageId,
          from: { id: bot.id, is_bot: true, first_name: bot.name, username: bot.username },
          chat: { id: Number.isNaN(Number(chat)) ? chat : Number(chat), type: Number(chat) < 0 ? 'supergroup' : 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
        });
      }
      default:
        record(true, false);
        return fail(404, 'Not Found');
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }));
    });
  });
  const listenHost = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, listenHost, resolve));
  const url = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${String((server.address() as AddressInfo).port)}`;

  return {
    url,
    bots,
    sent,
    calls,
    deliveries,
    webhook(botToken) {
      const bot = botOf(botToken);
      const w = bot ? webhooks.get(bot.id) : undefined;
      return w ? { url: w.url, secretToken: w.secret } : null;
    },
    async telegramSend(input) {
      const bot = botOf(input.botToken);
      if (!bot) throw new Error('no such bot');
      const chatType = input.chatType ?? 'private';
      const chatId = input.chatId ?? (chatType === 'private' ? input.fromUserId : -1_000_000_000_000 - input.fromUserId);
      knownChats.add(String(chatId));
      const updateId = input.updateId ?? nextUpdateId++;
      const text = input.text;
      const command = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(text);
      const update = {
        update_id: updateId,
        message: {
          message_id: input.messageId ?? nextMessageId++ + 5000,
          from: { id: input.fromUserId, is_bot: false, first_name: input.firstName ?? 'Person', ...(input.username ? { username: input.username } : {}), language_code: 'en' },
          chat: { id: Number(chatId), type: chatType, ...(chatType === 'private' ? { first_name: input.firstName ?? 'Person', ...(input.username ? { username: input.username } : {}) } : { title: input.chatTitle ?? 'Group' }) },
          date: Math.floor(Date.now() / 1000),
          text,
          ...(command ? { entities: [{ offset: 0, length: command[0].length, type: 'bot_command' }] } : {}),
        },
      };
      const w = webhooks.get(bot.id);
      if (!w) {
        queueOf(bot.id).push(update);
        return { updateId, delivered: false, queued: true, responses: [] };
      }
      const responses: TelegramSendResult['responses'] = [];
      for (let i = 0; i < Math.max(1, input.repeat ?? 1); i++) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        let secretHeader: TelegramDelivery['secretHeader'] = 'none-set';
        if (w.secret !== null) {
          if (input.secretHeader === 'missing') secretHeader = 'missing';
          else if (input.secretHeader === 'wrong') {
            headers['x-telegram-bot-api-secret-token'] = `${w.secret}x`;
            secretHeader = 'wrong';
          } else {
            headers['x-telegram-bot-api-secret-token'] = w.secret;
            secretHeader = 'right';
          }
        }
        try {
          const r = await fetch(w.url, { method: 'POST', headers, body: JSON.stringify(update), signal: AbortSignal.timeout(10_000), redirect: 'manual' });
          responses.push({ status: r.status, body: (await r.text()).slice(0, 2048) });
          deliveries.push({ botId: bot.id, updateId, status: r.status, secretHeader });
        } catch {
          responses.push({ status: null, body: '' });
          deliveries.push({ botId: bot.id, updateId, status: null, secretHeader });
        }
      }
      return { updateId, delivered: true, queued: false, responses };
    },
    failNext(status, count = 1, opts = {}) {
      failure = { status, left: count, method: opts.method, retryAfter: opts.retryAfter ?? 1 };
    },
    reset() {
      sent.length = 0;
      calls.length = 0;
      deliveries.length = 0;
      webhooks.clear();
      queues.clear();
      knownChats.clear();
      failure = null;
      nextUpdateId = 1000;
      nextMessageId = 1;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function safeJson(v: unknown): unknown {
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

export const telegramModule: StandInModule = {
  id: 'telegram',
  async start(ctx: StandInContext): Promise<StandInHandle<FakeTelegram>> {
    const opts = asRecord(ctx.options) as FakeTelegramOptions;
    const telegram = await startFakeTelegram({ ...opts, host: ctx.host, port: ctx.port, publicHost: ctx.publicHost });
    return {
      id: 'telegram',
      api: telegram,
      urls: { url: telegram.url },
      // the bridge dials `<base>/bot<token>/<method>` here instead of api.telegram.org (honoured outside production only)
      env: () => ({ MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE: telegram.url }),
      state: () => ({
        bots: telegram.bots.map((b) => ({ id: b.id, username: b.username })),
        sent: telegram.sent,
        calls: telegram.calls,
        deliveries: telegram.deliveries,
        webhooks: telegram.bots.flatMap((b): TelegramWebhookInfo[] => {
          const w = telegram.webhook(b.token);
          return w ? [{ botId: b.id, url: w.url, hasSecret: w.secretToken !== null, allowedUpdates: [] }] : [];
        }),
      }),
      reset: () => telegram.reset(),
      async control(request) {
        if (request.method === 'POST' && request.path === '/send') return { status: 200, body: await telegram.telegramSend(asRecord(request.body) as unknown as TelegramSendInput) };
        if (request.method === 'POST' && request.path === '/fail-next') {
          const b = asRecord(request.body);
          telegram.failNext(Number(b['status'] ?? 500), Number(b['count'] ?? 1), {
            ...(typeof b['method'] === 'string' ? { method: b['method'] } : {}),
            ...(b['retryAfter'] === undefined ? {} : { retryAfter: Number(b['retryAfter']) }),
          });
          return { status: 200, body: { ok: true } };
        }
        return null;
      },
      stop: () => telegram.stop(),
    };
  },
};
