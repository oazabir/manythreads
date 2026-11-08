import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BridgeAccountRef, BridgeAdapter, BridgeRequest, InboundMessage } from '../adapter.ts';
import { BridgeSendError, bridgeCall, failureOf, readJson } from '../door.ts';
import { cleanLabel } from '../text.ts';
import { textCommand } from './commands.ts';

// The Slack adapter (PLAN Bundle D, P16-09, B2). Slack calls the door with its Events API: every call carries `X-Slack-Request-Timestamp` and `X-Slack-Signature` (`v0=` and the HMAC-SHA256 of
// `v0:<timestamp>:<raw body>` with the app's signing secret). A call older or newer than five minutes is refused, which is Slack's own replay rule. The first call Slack makes is a
// `url_verification` that wants its `challenge` back. Messages are `event_callback` bodies with a `message` event; the bot's own posts (they carry a `bot_id`), edits, joins and every other
// subtype are not read, which is also what stops a message the bridge sent from coming back as a new one. `event_id` is the dedupe key.
// The bot token sends with `chat.postMessage`; the text is escaped first, so a name or a message from manythreads can never become a Slack mention or a link.

const WINDOW_MS = 5 * 60_000;

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const SLACK_ID = /^[A-Z0-9]{2,40}$/;

/**
 * What Slack puts in a message: `&`, `<` and `>` are escaped, and a mention, a link or a channel is `<...>`. Turned into plain words, bounded: every tag is cut at 2000 characters and none
 * can run into the next. A Slack user is never turned into an `@name` (that could ping a manythreads person who has the same name).
 */
export function slackPlain(raw: string): string {
  const tags = raw.replace(/<([^<>]{1,2000})>/g, (_all, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? '' : inner.slice(bar + 1);
    if (target.startsWith('@')) return '(a Slack user)';
    if (target.startsWith('#')) return label !== '' ? label : 'a Slack channel';
    if (target.startsWith('!')) return label !== '' ? label.replace(/^@/, '') : target.slice(1).split('^')[0]!;
    if (/^(https?:|mailto:|tel:)/i.test(target)) return label !== '' && label !== target ? `${label} (${target})` : target;
    return label !== '' ? label : '';
  });
  return tags.replace(/&(lt|gt|amp);/g, (_all, e: string) => (e === 'lt' ? '<' : e === 'gt' ? '>' : '&'));
}

/** Outgoing text for `chat.postMessage`: the three characters Slack reads as markup are escaped. */
export const slackEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// `/connect` is a Slack slash command and never reaches a bot as a message, so in Slack a command is the plain word (`connect 12345678`), with or without a leading mention of the bot (commands.ts).
const MENTION_FIRST = /^(?:\(a Slack user\)[\s,:]*)/;

function tokenOf(account: BridgeAccountRef): string {
  const t = account.secrets.bot_token;
  if (!t) throw new BridgeSendError('This chat app has no bot token', { retry: false, attention: true });
  return t;
}

/** Slack answers HTTP 200 with `{ok: false, error}` for most refusals, and 429 with `Retry-After` when it is rate limiting. */
async function call(account: BridgeAccountRef, method: string, json: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await bridgeCall({ provider: 'slack', path: `/api/${method}`, headers: { authorization: `Bearer ${tokenOf(account)}` }, json });
  const doc = readJson(res.text);
  if (res.status === 200 && doc?.['ok'] === true) return doc;
  if (res.status !== 200) throw failureOf(res.status, res.retryAfter, `Slack refused ${method}`);
  const code = str(doc?.['error']);
  const word = code !== null && /^[a-z_]{1,40}$/.test(code) ? code : 'unknown_error';
  // the token itself is refused: the account needs attention. A busy Slack can be asked again. The rest (the bot is not in the channel, the channel is archived) is final.
  const attention = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope'].includes(word);
  const retry = ['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(word);
  throw new BridgeSendError(`Slack refused ${method} (${word})`, { retry, attention, retryAfterMs: word === 'ratelimited' ? Math.min(Math.max(res.retryAfter ?? 5, 1), 300) * 1000 : null });
}

export const slackAdapter: BridgeAdapter = {
  provider: 'slack',

  verify(account, req: BridgeRequest) {
    const secret = account.secrets.signing_secret;
    const stamp = req.headers['x-slack-request-timestamp'] ?? '';
    const sent = req.headers['x-slack-signature'] ?? '';
    const seconds = /^[0-9]{9,12}$/.test(stamp) ? Number(stamp) : Number.NaN;
    const fresh = Number.isFinite(seconds) && Math.abs(req.now - seconds * 1000) <= WINDOW_MS;
    // computed and compared whatever is missing, so the time says nothing
    const expected = `v0=${createHmac('sha256', secret ?? '').update(`v0:${stamp}:`).update(req.rawBody).digest('hex')}`;
    const ok = secret !== undefined && secret.length > 0 && fresh && sent.length > 0 && same(sent, expected);
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },

  handshake(_account, body) {
    const doc = rec(body);
    if (doc['type'] !== 'url_verification') return null;
    const challenge = str(doc['challenge']);
    // Slack sends a short random word; only that is echoed (never markup)
    return challenge !== null && /^[A-Za-z0-9._-]{1,200}$/.test(challenge) ? challenge : null;
  },

  parse(account, body): InboundMessage[] {
    const doc = rec(body);
    if (doc['type'] !== 'event_callback') return [];
    const eventId = str(doc['event_id']);
    const appId = str(doc['api_app_id']);
    // a call made for another app is not ours
    if (eventId === null || eventId.length === 0 || (account.externalAppId !== null && appId !== account.externalAppId)) return [];
    const event = rec(doc['event']);
    // `bot_id` is set on every post by a bot, ours included; a `subtype` marks edits, joins, file shares and the rest
    if (event['type'] !== 'message' || event['bot_id'] !== undefined || event['subtype'] !== undefined) return [];
    const user = str(event['user']);
    const channel = str(event['channel']);
    const raw = str(event['text']);
    if (user === null || channel === null || raw === null || !SLACK_ID.test(user) || !SLACK_ID.test(channel)) return [];
    const type = str(event['channel_type']);
    const kind: 'private' | 'group' = type === 'im' || (type === null && channel.startsWith('D')) ? 'private' : 'group';
    const plain = slackPlain(raw);
    // addressing the bot first (`@bot connect 12345678`) is allowed for a command; the posted text keeps what was said
    const text = plain;
    const ts = str(event['ts']);
    const at = ts !== null && /^[0-9]{9,12}(\.[0-9]{1,6})?$/.test(ts) ? Math.round(Number(ts) * 1000) : null;
    return [
      {
        updateId: eventId,
        externalId: ts !== null && /^[0-9.]{1,40}$/.test(ts) ? ts : null,
        chat: { id: channel, kind, title: null },
        sender: { id: user, label: cleanLabel(`Slack member ${user}`) },
        text,
        command: textCommand(plain.replace(MENTION_FIRST, ''), kind),
        at,
      },
    ];
  },

  async send(account, chat, text) {
    if (!SLACK_ID.test(chat)) throw new BridgeSendError('That Slack chat is not valid', { retry: false });
    const sent = await call(account, 'chat.postMessage', { channel: chat, text: slackEscape(text), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false });
    const ts = str(sent['ts']);
    if (ts === null) throw new BridgeSendError('Slack did not say which message it sent', { retry: false });
    return ts;
  },

  async connect(account) {
    const me = await call(account, 'auth.test', {});
    const user = str(me['user']);
    return { handle: user !== null && user !== '' ? `@${cleanLabel(user, 60)}` : null, externalAppId: account.externalAppId };
  },
};
