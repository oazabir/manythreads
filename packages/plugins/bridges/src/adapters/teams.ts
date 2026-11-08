import { createHash } from 'node:crypto';
import type { BridgeAccountRef, BridgeAdapter, BridgeRequest, InboundMessage } from '../adapter.ts';
import { BridgeSendError, bridgeCall, failureOf, fakeBase, originFor, readJson } from '../door.ts';
import { cleanLabel } from '../text.ts';
import { textCommand } from './commands.ts';
import { createKeyCache, kidOf, parseKeySet, verifyJwt, type Jwk, type KeyCache } from './jwt.ts';

// The Microsoft Teams adapter (PLAN Bundle D, P16-09, B2, decision D30), through the Bot Framework.
//   Inbound: Teams calls the door with an activity and `Authorization: Bearer <JWT>`. The token is checked here, with node:crypto only (jwt.ts): RS256, a key id found in the keys the Bot Framework
//     publishes at login.botframework.com (kept 24 hours, looked up again for an id we have not seen but not more than once a minute), issuer `https://api.botframework.com`, audience the bot's
//     app id, not expired and not early (five minutes of clock difference), the token's `serviceurl` equal to the activity's, and the key endorsed for the activity's channel (`msteams`).
//   Outbound: the reply is POSTed to `<serviceUrl>/v3/conversations/<id>/activities` with an access token the app id and client secret get from login.microsoftonline.com. The service address
//     comes from the activity, so it is dialled ONLY when its host is on the Microsoft list (door.ts `BRIDGE_HOST_PATTERNS.teams`); any other address is never contacted.
//   A chat is named `<service address>|<conversation id>`: the address is part of the name because a reply needs it and a chat id is all the core keeps. A conversation id cut to its base (a reply
//     thread in a channel carries `;messageid=...`) joins the channel as a whole.

const ISSUER = 'https://api.botframework.com';
const CHANNEL = 'msteams';
const SKEW_MS = 5 * 60_000;
const KEYS_TTL_MS = 24 * 3_600_000;
const KEYS_MISS_MS = 60_000;
const KEYS_STALE_MS = 7 * 24 * 3_600_000;

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- the keys the Bot Framework signs with ---------------------------------------------------------------------------------------------------------------------------

const caches = new Map<string, KeyCache>();

function keyCache(): KeyCache {
  // one cache per place the keys come from (the real host or a stand-in), so a test and a stand-in never share keys
  const where = fakeBase('teams') ?? 'login.botframework.com';
  let cache = caches.get(where);
  if (!cache) {
    cache = createKeyCache({
      ttlMs: KEYS_TTL_MS,
      missRefreshMs: KEYS_MISS_MS,
      staleMs: KEYS_STALE_MS,
      async fetch(): Promise<Jwk[]> {
        const res = await bridgeCall({ provider: 'teams', aux: 'teams_keys', method: 'GET', path: '/v1/.well-known/keys' });
        if (res.status !== 200) throw failureOf(res.status, res.retryAfter, 'The Teams signing keys could not be read');
        return parseKeySet(readJson(res.text));
      },
    });
    caches.set(where, cache);
  }
  return cache;
}

/** Forgets the keys held (a test that rotates the stand-in's keys; an admin who removes the account). */
export function forgetTeamsKeys(): void {
  for (const c of caches.values()) c.clear();
  caches.clear();
}

const sameUrl = (a: string, b: string): boolean => {
  const norm = (u: string): string | null => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
};

const bearerOf = (req: BridgeRequest): string | null => /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(req.headers['authorization'] ?? '')?.[1] ?? null;

// --- the chat name ---------------------------------------------------------------------------------------------------------------------------------------------

/** Letters, digits and a few marks in at most three path pieces: the region a service address carries (`/emea/`). Nothing else is ever put in a request path. */
const SERVICE_PATH = /^(?:\/[A-Za-z0-9._-]{1,40}){0,3}\/?$/;

function serviceUrlOf(raw: string): { url: string; prefix: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.search !== '' || u.hash !== '' || !SERVICE_PATH.test(u.pathname)) return null;
  // the host list is checked here too, so a chat is never made for an address that can never be dialled
  if (originFor('teams', raw) === null) return null;
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, prefix: u.pathname.replace(/\/+$/, '') };
}

/** `<service address>|<conversation id>`; null when it would not fit (200 characters) or either part is odd. */
export function teamsChatId(serviceUrl: string, conversationId: string): string | null {
  const s = serviceUrlOf(serviceUrl);
  const base = conversationId.split(';')[0] ?? '';
  if (!s || base.length === 0 || /[|\s]/.test(base) || base.length > 160) return null;
  const id = `${s.url}|${base}`;
  return id.length <= 200 ? id : null;
}

function splitChat(chat: string): { serviceUrl: string; prefix: string; conversationId: string } | null {
  const bar = chat.indexOf('|');
  if (bar <= 0) return null;
  const s = serviceUrlOf(chat.slice(0, bar));
  const conversationId = chat.slice(bar + 1);
  return s && conversationId.length > 0 ? { serviceUrl: s.url, prefix: s.prefix, conversationId } : null;
}

// --- text ------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Teams text is plain with `<at>Name</at>` where someone was mentioned. The bot's own mention is removed (it only says who was spoken to); another person's becomes their name, without an @;
 * the few other tags that can appear are dropped. Bounded patterns throughout.
 */
export function teamsPlain(raw: string, botNames: readonly string[]): string {
  const mine = new Set(botNames.map((n) => n.trim().toLowerCase()).filter((n) => n !== ''));
  const noAt = raw.replace(/<at>([^<>]{0,200})<\/at>/gi, (_all, name: string) => (mine.has(name.trim().toLowerCase()) ? '' : name.trim()));
  const breaks = noAt.replace(/<br\s{0,4}\/?>|<\/p>|<\/div>/gi, '\n');
  const bare = breaks.replace(/<\/?[A-Za-z][^<>]{0,200}>/g, '');
  const entities: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
  return bare
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_all, e: string) => entities[e] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// --- the access token for replies -------------------------------------------------------------------------------------------------------------------------------

const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (a: BridgeAccountRef): string => `${a.id}:${createHash('sha256').update(`${a.externalAppId ?? ''}\n${a.secrets.bot_token ?? ''}`).digest('hex').slice(0, 16)}`;

async function accessToken(account: BridgeAccountRef, fresh = false): Promise<string> {
  const secret = account.secrets.bot_token;
  const appId = account.externalAppId;
  if (!secret || !appId || !GUID.test(appId)) throw new BridgeSendError('This chat app has no application id or client secret', { retry: false, attention: true });
  const key = tokenKey(account);
  const held = tokens.get(key);
  if (!fresh && held && held.until > Date.now()) return held.token;
  const res = await bridgeCall({
    provider: 'teams',
    aux: 'teams_token',
    path: '/botframework.com/oauth2/v2.0/token',
    form: { grant_type: 'client_credentials', client_id: appId, client_secret: secret, scope: 'https://api.botframework.com/.default' },
  });
  const doc = readJson(res.text);
  const token = str(doc?.['access_token']);
  if (res.status !== 200 || token === null || token.length === 0 || token.length > 8192) {
    // a refused id or secret is the account's own fault; anything else can be tried again
    if (res.status === 400 || res.status === 401) throw new BridgeSendError('Microsoft did not accept the application id and client secret', { retry: false, attention: true, status: res.status });
    throw failureOf(res.status, res.retryAfter, 'Microsoft would not give an access token');
  }
  const lifetime = Number(doc?.['expires_in']);
  const seconds = Number.isFinite(lifetime) ? Math.min(Math.max(lifetime, 120), 86_400) : 600;
  tokens.set(key, { token, until: Date.now() + (seconds - 60) * 1000 });
  return token;
}

// --- the adapter -----------------------------------------------------------------------------------------------------------------------------------------------

export const teamsAdapter: BridgeAdapter = {
  provider: 'teams',

  async prepare(account, req) {
    const token = bearerOf(req);
    const kid = account.externalAppId && token ? kidOf(token) : null;
    if (kid !== null) await keyCache().get(kid, req.now).catch(() => undefined);
  },

  verify(account, req: BridgeRequest) {
    const bad = { ok: false, reason: 'bad_signature' } as const;
    const appId = account.externalAppId;
    const token = bearerOf(req);
    if (!appId || !token) return bad;
    const kid = kidOf(token);
    if (kid === null) return bad;
    // the keys were fetched by `prepare`; what is held is all that is trusted here
    const jwk = keyCache().peek(kid, req.now);
    const checked = verifyJwt(token, { keyFor: (k) => (k === kid ? jwk : undefined), issuer: ISSUER, audience: appId, now: req.now, skewMs: SKEW_MS });
    if (!checked.ok) return bad;
    // the token was made for this very service address (a token for one address cannot be replayed with another), and the key may sign for Teams
    let activity: Record<string, unknown>;
    try {
      activity = rec(JSON.parse(Buffer.from(req.rawBody).toString('utf8')));
    } catch {
      return bad;
    }
    const claim = str(checked.claims['serviceurl']);
    const address = str(activity['serviceUrl']);
    if (claim === null || address === null || !sameUrl(claim, address)) return bad;
    // This bridge is for Teams only. The Bot Framework signs calls for every channel the bot is registered on (Web Chat, Direct Line, ...), and on some of them the sender picks their own
    // user id, so an activity of another channel is refused here: it must not be read as a Teams user (it could name a linked person's Teams id).
    const channel = str(activity['channelId']) ?? CHANNEL;
    if (channel !== CHANNEL || !checked.key.endorsements?.includes(channel)) return bad;
    return { ok: true };
  },

  parse(_account, body): InboundMessage[] {
    const a = rec(body);
    if (a['type'] !== 'message') return [];
    const from = rec(a['from']);
    const recipient = rec(a['recipient']);
    const conversation = rec(a['conversation']);
    const activityId = str(a['id']);
    const serviceUrl = str(a['serviceUrl']);
    const conversationId = str(conversation['id']);
    const senderId = str(from['id']);
    const raw = str(a['text']);
    if (activityId === null || serviceUrl === null || conversationId === null || senderId === null || raw === null || activityId.length === 0 || activityId.length > 120) return [];
    // our own words and other bots' are not read
    if (from['role'] === 'bot' || (str(recipient['id']) !== null && senderId === recipient['id'])) return [];
    const chat = teamsChatId(serviceUrl, conversationId);
    if (chat === null || senderId.length > 200) return [];
    const kind: 'private' | 'group' = conversation['conversationType'] === 'personal' || (conversation['conversationType'] === undefined && conversation['isGroup'] !== true) ? 'private' : 'group';
    const botNames = [str(recipient['name']) ?? ''];
    for (const e of arr(a['entities'])) {
      const entity = rec(e);
      if (entity['type'] === 'mention' && rec(entity['mentioned'])['id'] === recipient['id']) botNames.push(str(rec(entity['mentioned'])['name']) ?? '');
    }
    const text = teamsPlain(raw, botNames);
    const channelData = rec(a['channelData']);
    const title = str(conversation['name']) ?? str(rec(channelData['channel'])['name']) ?? str(rec(channelData['team'])['name']);
    const when = Date.parse(str(a['timestamp']) ?? '');
    return [
      {
        // an activity id is unique inside its conversation only
        updateId: `${activityId}@${createHash('sha256').update(chat).digest('hex').slice(0, 16)}`,
        externalId: activityId,
        chat: { id: chat, kind, title: kind === 'private' || title === null ? null : cleanLabel(title) || null },
        sender: { id: senderId, label: cleanLabel(str(from['name']) ?? '') || 'Teams user' },
        text,
        command: textCommand(text, kind),
        at: Number.isFinite(when) ? when : null,
      },
    ];
  },

  async send(account, chat, text) {
    const to = splitChat(chat);
    if (!to) throw new BridgeSendError('That Teams chat is not valid', { retry: false });
    // the address must be on the list before a token is asked for or anything is sent
    if (originFor('teams', to.serviceUrl) === null) throw new BridgeSendError('That chat app address is not on the list of addresses manythreads talks to', { retry: false });
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(account, attempt > 0);
      const res = await bridgeCall({
        provider: 'teams',
        serviceUrl: to.serviceUrl,
        path: `${to.prefix}/v3/conversations/${encodeURIComponent(to.conversationId)}/activities`,
        headers: { authorization: `Bearer ${token}` },
        json: { type: 'message', text, textFormat: 'plain' },
      });
      if (res.status >= 200 && res.status < 300) {
        const id = str(readJson(res.text)?.['id']);
        if (id === null) throw new BridgeSendError('Teams did not say which message it sent', { retry: false });
        return id;
      }
      // a token that expired early: forget it and ask once more
      if (res.status === 401 && attempt === 0) {
        tokens.delete(tokenKey(account));
        continue;
      }
      if (res.status === 403 || res.status === 404) throw new BridgeSendError(`Teams would not take the message (${String(res.status)}). The bot may have been removed from that chat.`, { retry: false, status: res.status });
      throw failureOf(res.status, res.retryAfter, 'Teams refused the message');
    }
  },

  async connect(account) {
    // the callback address is entered in the Azure bot by hand: here the application id and the client secret are only checked, by asking Microsoft for a token
    await accessToken(account, true);
    return { handle: null, externalAppId: account.externalAppId };
  },

  async disconnect(account) {
    tokens.delete(tokenKey(account));
  },
};
