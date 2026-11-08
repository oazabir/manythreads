import { timingSafeEqual } from 'node:crypto';
import type { BridgeAccountRef, BridgeAdapter, BridgeRequest, InboundMessage } from '../adapter.ts';
import { BridgeSendError, bridgeCall, failureOf, readJson } from '../door.ts';
import { cleanLabel } from '../text.ts';

// The Telegram adapter (PLAN Bundle D, P16-09). Telegram calls the door with the secret word we gave `setWebhook` in the header `X-Telegram-Bot-Api-Secret-Token`; that header is the only proof.
// A message is an `Update` with a `message` (private chat, group or supergroup); channel posts, edits, joins and the rest are not read.

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' && /^-?[0-9]{1,20}$/.test(v) ? v : null);

const COMMAND = /^\/(start|connect|unlink|bot)(?:@[A-Za-z0-9_]{1,64})?(?:[ \t]+([\s\S]*))?$/;

/** The base address of a call: `/bot<token>/<method>`. The token is part of the path Telegram defines; it never appears in an error. */
const method = (token: string, name: string): string => `/bot${encodeURIComponent(token)}/${name}`;

function tokenOf(account: BridgeAccountRef): string {
  const t = account.secrets.bot_token;
  if (!t) throw new BridgeSendError('This chat app has no bot token', { retry: false, attention: true });
  return t;
}

/** Telegram answers `{ok, result}` or `{ok: false, error_code, description, parameters: {retry_after}}`. */
async function call(account: BridgeAccountRef, name: string, json: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await bridgeCall({ provider: 'telegram', path: method(tokenOf(account), name), json });
  const doc = readJson(res.text);
  if (res.status === 200 && doc?.['ok'] === true) return rec(doc['result']);
  const retryAfter = Number(rec(doc?.['parameters'])['retry_after']);
  throw failureOf(res.status, Number.isFinite(retryAfter) ? retryAfter : null, `Telegram refused ${name}`);
}

export const telegramAdapter: BridgeAdapter = {
  provider: 'telegram',

  verify(account, req: BridgeRequest) {
    const expected = account.secrets.inbound_secret;
    const sent = req.headers[SECRET_HEADER];
    // one comparison whether or not either side is there, so the time says nothing
    const ok = typeof expected === 'string' && expected.length > 0 && typeof sent === 'string' && same(sent, expected);
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },

  parse(_account, body): InboundMessage[] {
    const update = rec(body);
    const updateId = idOf(update['update_id']);
    const message = rec(update['message']);
    if (updateId === null || Object.keys(message).length === 0) return [];
    const chat = rec(message['chat']);
    const from = rec(message['from']);
    const chatId = idOf(chat['id']);
    const senderId = idOf(from['id']);
    const type = str(chat['type']);
    if (chatId === null || senderId === null || from['is_bot'] === true) return [];
    if (type !== 'private' && type !== 'group' && type !== 'supergroup') return [];
    const raw = str(message['text']) ?? str(message['caption']);
    if (raw === null) return [];
    const m = COMMAND.exec(raw.trim());
    const username = str(from['username']);
    const first = [str(from['first_name']), str(from['last_name'])].filter((x): x is string => x !== null && x !== '').join(' ');
    const label = cleanLabel(username ? `@${username}` : first || 'Telegram user');
    const date = Number(message['date']);
    return [
      {
        updateId,
        externalId: idOf(message['message_id']),
        chat: { id: chatId, kind: type === 'private' ? 'private' : 'group', title: type === 'private' ? null : cleanLabel(str(chat['title']) ?? '') || null },
        sender: { id: senderId, label },
        text: raw,
        command: m ? { name: m[1] as 'start' | 'connect' | 'unlink' | 'bot', argument: (m[2] ?? '').trim() } : null,
        at: Number.isFinite(date) && date > 0 ? date * 1000 : null,
      },
    ];
  },

  async send(account, chat, text) {
    const sent = await call(account, 'sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
    const id = idOf(sent['message_id']);
    if (id === null) throw new BridgeSendError('Telegram did not say which message it sent', { retry: false });
    return id;
  },

  async connect(account, callbackUrl) {
    const me = await call(account, 'getMe', {});
    const secret = account.secrets.inbound_secret;
    if (!secret) throw new BridgeSendError('This chat app has no secret word for Telegram to send back', { retry: false });
    // only messages are asked for: nothing else is read, so nothing else is sent
    await call(account, 'setWebhook', { url: callbackUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
    const username = str(me['username']);
    return { handle: username ? `@${username}` : null, externalAppId: idOf(me['id']) };
  },

  async disconnect(account) {
    await call(account, 'deleteWebhook', {});
  },
};
