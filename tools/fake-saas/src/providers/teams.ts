import { createHmac, generateKeyPairSync, randomBytes, sign as signBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StandInContext, StandInHandle, StandInModule } from './types.ts';

/*
 * A Microsoft Teams (Bot Framework) stand-in (PLAN Bundle D, P16-09, B2, D30). One server answers, at the paths the real hosts use:
 *   - `GET /v1/.well-known/openidconfiguration` and `GET /v1/.well-known/keys` (login.botframework.com): the signing keys as a JWK set, each with `endorsements` (the channels it may sign for);
 *   - `POST /botframework.com/oauth2/v2.0/token` (login.microsoftonline.com): `client_credentials` for the right app id and client secret, `401 invalid_client` otherwise;
 *   - `POST <service address>/v3/conversations/<id>/activities` (the Connector service): needs a token this stand-in issued; the service address of every activity it sends is
 *     `<url>/emea/`, so the region path of the real `smba.trafficmanager.net/emea/` is exercised.
 * The other side, Teams calling the bot, is `teamsSend`: it POSTs an activity to the callback address with `Authorization: Bearer <JWT>` signed (RS256) the way the Bot Framework signs
 * (issuer `https://api.botframework.com`, audience the app id, a `serviceurl` claim, five minutes of life). `jwt` picks a deliberately broken token: the wrong issuer or audience, expired, not yet
 * valid, a key id nobody published, a bad signature, `alg: none`, an HMAC token made with the public key's bytes, a `serviceurl` that differs, a key not endorsed for Teams. Neither the client
 * secret nor an access token is ever shown by the state.
 */

export interface FakeTeamsOptions {
  /** The bot's application (client) id: the audience of every call. */
  appId?: string;
  /** The client secret the bridge is given. */
  clientSecret?: string;
}

export type TeamsJwtMode =
  | 'right'
  | 'missing'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet'
  | 'unknown-kid'
  | 'bad-signature'
  | 'alg-none'
  | 'hmac'
  | 'wrong-service-url'
  | 'unendorsed'
  | 'no-service-url';

export interface TeamsSendInput {
  fromId?: string;
  fromName?: string;
  text: string;
  /** `personal` (a chat with the bot), `channel` (a channel of a team), `groupChat`. Default `personal`. */
  conversation?: 'personal' | 'channel' | 'groupChat';
  /** Default: one per kind, stable. */
  conversationId?: string;
  /** Put the bot's `<at>` mention first and the matching entity (a channel only delivers messages that mention the bot). Default: true for channel and groupChat. */
  mention?: boolean;
  /** Default: random. Send the same id twice to play a retry. */
  activityId?: string;
  jwt?: TeamsJwtMode;
  /** The service address the activity (and its token) names; default this stand-in's own. Play an address outside the Microsoft list. */
  serviceUrl?: string;
  repeat?: number;
}

export interface TeamsSendResult {
  activityId: string;
  responses: Array<{ status: number | null; body: string }>;
}

export interface TeamsSentActivity {
  id: string;
  conversationId: string;
  text: string;
  textFormat: string | null;
  at: string;
}

export interface TeamsApiCall {
  method: string;
  path: string;
  authorized: boolean;
  status: number;
}

export interface TeamsDelivery {
  activityId: string;
  status: number | null;
  jwt: TeamsJwtMode;
}

export interface FakeTeams {
  url: string;
  appId: string;
  botId: string;
  /** The key id the keys are published under now. */
  kid(): string;
  sent: TeamsSentActivity[];
  calls: TeamsApiCall[];
  deliveries: TeamsDelivery[];
  tokenRequests(): number;
  setCallback(url: string | null): void;
  callback(): string | null;
  teamsSend(input: TeamsSendInput): Promise<TeamsSendResult>;
  /** Publish a new key and withdraw the old one (the Bot Framework rotates its keys). */
  rotateKeys(): void;
  failNext(status: number, count?: number, retryAfter?: number): void;
  reset(): void;
  stop(): Promise<void>;
}

export const FAKE_TEAMS_APP_ID = '5b2d9c3e-7a41-4c1b-9d57-0f3a6e8b1c24';
export const FAKE_TEAMS_CLIENT_SECRET = 'fake-teams-client-secret-0001';
export const TEAMS_ISSUER = 'https://api.botframework.com';

const b64 = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

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

interface Pair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}
const newPair = (kid: string): Pair => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
};
const jwkOf = (p: Pair, endorsements: string[]): Record<string, unknown> => ({ kty: 'RSA', use: 'sig', kid: p.kid, x5t: p.kid, ...p.publicKey.export({ format: 'jwk' }), endorsements });

export async function startFakeTeams(options: FakeTeamsOptions & { host?: string; port?: number; publicHost?: string } = {}): Promise<FakeTeams> {
  const appId = options.appId ?? FAKE_TEAMS_APP_ID;
  const clientSecret = options.clientSecret ?? FAKE_TEAMS_CLIENT_SECRET;
  const botId = `28:${appId}`;
  let generation = 1;
  let main = newPair(`fake-teams-key-${String(generation)}`);
  // published, but only for another channel
  const other = newPair('fake-teams-key-other-channel');
  // never published
  const foreign = newPair('fake-teams-key-unpublished');
  const sent: TeamsSentActivity[] = [];
  const calls: TeamsApiCall[] = [];
  const deliveries: TeamsDelivery[] = [];
  const issued = new Set<string>();
  let tokenCount = 0;
  let callback: string | null = null;
  let failure: { status: number; left: number; retryAfter: number | null } | null = null;
  let counter = 0;
  let base = '';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    let status = 200;
    const reply = (code: number, doc: unknown, headers: Record<string, string> = {}): void => {
      status = code;
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(doc));
    };
    const done = (authorized: boolean): void => void calls.push({ method, path: url.pathname, authorized, status });

    if (method === 'GET' && url.pathname === '/v1/.well-known/openidconfiguration') {
      reply(200, { issuer: TEAMS_ISSUER, authorization_endpoint: `${base}/authorize`, jwks_uri: `${base}/v1/.well-known/keys`, id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['private_key_jwt'] });
      return done(true);
    }
    if (method === 'GET' && url.pathname === '/v1/.well-known/keys') {
      reply(200, { keys: [jwkOf(main, ['msteams', 'webchat', 'directline']), jwkOf(other, ['webchat'])] });
      return done(true);
    }
    if (method === 'POST' && url.pathname === '/botframework.com/oauth2/v2.0/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'client_credentials' && form.get('client_id') === appId && form.get('client_secret') === clientSecret && form.get('scope') === 'https://api.botframework.com/.default') {
        const token = `fake-teams-access-${randomBytes(12).toString('hex')}`;
        issued.add(token);
        tokenCount++;
        reply(200, { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: token });
        return done(true);
      }
      reply(401, { error: 'invalid_client', error_description: 'The application id or the client secret is not right.' });
      return done(false);
    }
    const act = /^(?:\/[A-Za-z0-9._-]+)?\/v3\/conversations\/([^/]+)\/activities$/.exec(url.pathname);
    if (method === 'POST' && act) {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
      const authorized = issued.has(bearer);
      if (!authorized) {
        reply(401, { error: { code: 'BotNotAuthorized', message: 'Authorization has been denied for this request.' } });
        return done(false);
      }
      if (failure && failure.left > 0) {
        failure.left--;
        reply(failure.status, { error: { code: failure.status === 429 ? 'TooManyRequests' : 'ServiceError', message: 'The service could not take the activity.' } }, failure.retryAfter !== null ? { 'retry-after': String(failure.retryAfter) } : {});
        return done(true);
      }
      let doc: Record<string, unknown>;
      try {
        doc = asRecord(JSON.parse(body));
      } catch {
        reply(400, { error: { code: 'BadArgument', message: 'The body is not JSON.' } });
        return done(true);
      }
      const text = typeof doc['text'] === 'string' ? doc['text'] : '';
      if (doc['type'] !== 'message' || text === '') reply(400, { error: { code: 'BadArgument', message: 'A message activity needs text.' } });
      else if (text.length > 28_000) reply(413, { error: { code: 'MessageSizeTooBig', message: 'The message is too long.' } });
      else {
        const id = `fake-activity-${String(++counter).padStart(6, '0')}`;
        sent.push({ id, conversationId: decodeURIComponent(act[1]!), text, textFormat: typeof doc['textFormat'] === 'string' ? doc['textFormat'] : null, at: new Date().toISOString() });
        reply(201, { id });
      }
      return done(true);
    }
    reply(404, { error: { code: 'NotFound', message: 'Unsupported request.' } });
    done(false);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ServiceError', message: 'An unexpected error has occurred.' } }));
    });
  });
  const listenHost = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, listenHost, resolve));
  const url = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${String((server.address() as AddressInfo).port)}`;
  base = url;
  const serviceUrl = `${url}/emea/`;

  /** A compact RS256 token for an activity, broken as `mode` says. */
  const tokenFor = (mode: TeamsJwtMode, address: string): string | null => {
    if (mode === 'missing') return null;
    const now = Math.floor(Date.now() / 1000);
    const pair = mode === 'unknown-kid' || mode === 'bad-signature' ? foreign : mode === 'unendorsed' ? other : main;
    const kid = mode === 'bad-signature' ? main.kid : pair.kid;
    const claims = {
      iss: mode === 'wrong-issuer' ? 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/' : TEAMS_ISSUER,
      aud: mode === 'wrong-audience' ? '00000000-0000-4000-8000-000000000000' : appId,
      ...(mode === 'no-service-url' ? {} : { serviceurl: mode === 'wrong-service-url' ? 'https://smba.trafficmanager.net/amer/' : address }),
      iat: now - 60,
      nbf: mode === 'not-yet' ? now + 3600 : now - 60,
      exp: mode === 'expired' ? now - 3600 : now + 300,
    };
    if (mode === 'alg-none') return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    if (mode === 'hmac') {
      // the classic confusion attack: HS256 with the public key's bytes as the secret
      const head = b64({ alg: 'HS256', typ: 'JWT', kid: main.kid });
      const input = `${head}.${b64(claims)}`;
      return `${input}.${createHmac('sha256', main.publicKey.export({ type: 'spki', format: 'pem' })).update(input).digest('base64url')}`;
    }
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
    return `${input}.${signBytes('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
  };

  return {
    url,
    appId,
    botId,
    kid: () => main.kid,
    sent,
    calls,
    deliveries,
    tokenRequests: () => tokenCount,
    setCallback(next) {
      callback = next;
    },
    callback: () => callback,
    async teamsSend(input) {
      if (callback === null) throw new Error('no callback address is set');
      const kind = input.conversation ?? 'personal';
      const address = input.serviceUrl ?? serviceUrl;
      const conversationId = input.conversationId ?? (kind === 'personal' ? 'a:1fake-personal-conversation' : kind === 'channel' ? '19:fakechannel@thread.tacv2' : '19:fakegroupchat@thread.v2');
      const activityId = input.activityId ?? `${String(Date.now())}${String(++counter).padStart(3, '0')}`;
      const mention = input.mention ?? kind !== 'personal';
      const text = mention ? `<at>Fake Bot</at> ${input.text}` : input.text;
      const activity = JSON.stringify({
        type: 'message',
        id: activityId,
        timestamp: new Date().toISOString(),
        serviceUrl: address,
        channelId: 'msteams',
        from: { id: input.fromId ?? '29:1fake-user', name: input.fromName ?? 'Fake Person', aadObjectId: '00000000-0000-4000-8000-0000000000aa' },
        conversation: { id: conversationId, conversationType: kind, tenantId: '00000000-0000-4000-8000-0000000000bb', ...(kind === 'channel' ? { name: 'General' } : {}), isGroup: kind !== 'personal' },
        recipient: { id: botId, name: 'Fake Bot' },
        textFormat: 'plain',
        text,
        entities: mention ? [{ type: 'mention', mentioned: { id: botId, name: 'Fake Bot' }, text: '<at>Fake Bot</at>' }] : [],
        channelData: { tenant: { id: '00000000-0000-4000-8000-0000000000bb' } },
      });
      const mode = input.jwt ?? 'right';
      const responses: TeamsSendResult['responses'] = [];
      for (let i = 0; i < Math.max(1, input.repeat ?? 1); i++) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const token = tokenFor(mode, address);
        if (token !== null) headers['authorization'] = `Bearer ${token}`;
        try {
          const r = await fetch(callback, { method: 'POST', headers, body: activity, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
          responses.push({ status: r.status, body: (await r.text()).slice(0, 2048) });
          deliveries.push({ activityId, status: r.status, jwt: mode });
        } catch {
          responses.push({ status: null, body: '' });
          deliveries.push({ activityId, status: null, jwt: mode });
        }
      }
      return { activityId, responses };
    },
    rotateKeys() {
      generation++;
      main = newPair(`fake-teams-key-${String(generation)}`);
    },
    failNext(status, count = 1, retryAfter) {
      failure = { status, left: count, retryAfter: retryAfter ?? (status === 429 ? 1 : null) };
    },
    reset() {
      sent.length = 0;
      calls.length = 0;
      deliveries.length = 0;
      issued.clear();
      tokenCount = 0;
      callback = null;
      failure = null;
      counter = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const teamsModule: StandInModule = {
  id: 'teams',
  async start(ctx: StandInContext): Promise<StandInHandle<FakeTeams>> {
    const opts = asRecord(ctx.options) as FakeTeamsOptions;
    const teams = await startFakeTeams({ ...opts, host: ctx.host, port: ctx.port, publicHost: ctx.publicHost });
    return {
      id: 'teams',
      api: teams,
      urls: { url: teams.url },
      // the bridge reads the signing keys, asks for its access token and sends its replies here instead of the Microsoft hosts (honoured outside production only)
      env: () => ({ MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE: teams.url }),
      state: () => ({ appId: teams.appId, kid: teams.kid(), tokenRequests: teams.tokenRequests(), sent: teams.sent, calls: teams.calls, deliveries: teams.deliveries, callback: teams.callback() }),
      reset: () => teams.reset(),
      async control(request) {
        const b = asRecord(request.body);
        if (request.method === 'POST' && request.path === '/callback') {
          teams.setCallback(typeof b['url'] === 'string' ? b['url'] : null);
          return { status: 200, body: { ok: true } };
        }
        if (request.method === 'POST' && request.path === '/send') return { status: 200, body: await teams.teamsSend(b as unknown as TeamsSendInput) };
        if (request.method === 'POST' && request.path === '/rotate-keys') {
          teams.rotateKeys();
          return { status: 200, body: { kid: teams.kid() } };
        }
        if (request.method === 'POST' && request.path === '/fail-next') {
          teams.failNext(Number(b['status'] ?? 500), Number(b['count'] ?? 1), b['retryAfter'] === undefined ? undefined : Number(b['retryAfter']));
          return { status: 200, body: { ok: true } };
        }
        return null;
      },
      stop: () => teams.stop(),
    };
  },
};
