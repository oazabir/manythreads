import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StandInContext, StandInHandle, StandInModule } from './types.ts';

/*
 * A Slack stand-in (PLAN Bundle D, P16-09, B2). Answers the two Web API calls the chat bridge makes and checks what Slack checks:
 *   - `POST /api/auth.test` and `POST /api/chat.postMessage` with `Authorization: Bearer <bot token>`. A wrong token is HTTP 200 `{ok: false, error: "invalid_auth"}`, as at Slack. A post needs a
 *     channel id, text of at most 40000 characters, and (with `strictChannels`) a channel the bot was added to or that has written to it, else `not_in_channel`. The text is kept exactly as sent so a
 *     test sees whether `&`, `<` and `>` were escaped.
 *   - `failNext(status)` makes the next calls answer that HTTP status (429 carries `Retry-After`); `failNextOk(error)` makes them answer `{ok: false, error}`.
 * The other side, a person writing in Slack, is `slackSend`: it POSTs an Events API `event_callback` to the callback address with `X-Slack-Request-Timestamp` and `X-Slack-Signature`
 * (`v0=` and the HMAC-SHA256 of `v0:<timestamp>:<body>` with the signing secret). `slackVerify` does Slack's `url_verification` call. Neither the bot token nor the signing secret is ever shown
 * by the state.
 */

export interface FakeSlackOptions {
  /** The bot token the bridge is given. */
  botToken?: string;
  /** The secret Slack signs calls with. */
  signingSecret?: string;
  appId?: string;
  teamId?: string;
  botUserId?: string;
  botUserName?: string;
  /** A bot may only post in a channel it was added to (default false). */
  strictChannels?: boolean;
}

export interface SlackSentMessage {
  ts: string;
  channel: string;
  text: string;
  at: string;
}

export interface SlackApiCall {
  method: string;
  authorized: boolean;
  ok: boolean;
  error: string | null;
}

export interface SlackDelivery {
  eventId: string;
  status: number | null;
  signature: 'right' | 'wrong' | 'missing' | 'stale' | 'future';
}

export interface SlackSendInput {
  /** The Slack user id of the person (`U...`). */
  user: string;
  /** The channel or conversation id (`C...` public channel, `G...` private, `D...` a direct chat). */
  channel: string;
  channelType?: 'channel' | 'group' | 'im' | 'mpim';
  text: string;
  /** Default: random. Send the same id twice to play a retry. */
  eventId?: string;
  ts?: string;
  /** `wrong`: signed with another secret; `missing`: no signature; `stale` / `future`: right signature over a timestamp ten minutes off. Default: the right one. */
  signature?: 'wrong' | 'missing' | 'stale' | 'future';
  /** Set `bot_id`, as on a post by a bot (the bridge's own posts come back this way). */
  botId?: string;
  /** A message subtype (`message_changed`, `channel_join`, ...). */
  subtype?: string;
  appId?: string;
  repeat?: number;
}

export interface SlackSendResult {
  eventId: string;
  responses: Array<{ status: number | null; body: string }>;
}

export interface FakeSlack {
  url: string;
  botToken: string;
  botUserId: string;
  appId: string;
  sent: SlackSentMessage[];
  calls: SlackApiCall[];
  deliveries: SlackDelivery[];
  setCallback(url: string | null): void;
  callback(): string | null;
  /** The bot was added to this channel (matters with `strictChannels`). */
  addToChannel(channel: string): void;
  slackSend(input: SlackSendInput): Promise<SlackSendResult>;
  /** Slack's `url_verification` call. `signature` as for `slackSend`. */
  slackVerify(options?: { challenge?: string; signature?: SlackSendInput['signature'] }): Promise<{ status: number | null; body: string }>;
  failNext(status: number, count?: number, retryAfter?: number): void;
  failNextOk(error: string, count?: number): void;
  reset(): void;
  stop(): Promise<void>;
}

export const FAKE_SLACK_BOT_TOKEN = 'xoxb-fake-slack-bot-token-for-tests-0001';
export const FAKE_SLACK_SIGNING_SECRET = 'fake-slack-signing-secret-0001';
export const FAKE_SLACK_APP_ID = 'A0FAKE00001';

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

export async function startFakeSlack(options: FakeSlackOptions & { host?: string; port?: number; publicHost?: string } = {}): Promise<FakeSlack> {
  const botToken = options.botToken ?? FAKE_SLACK_BOT_TOKEN;
  const signingSecret = options.signingSecret ?? FAKE_SLACK_SIGNING_SECRET;
  const appId = options.appId ?? FAKE_SLACK_APP_ID;
  const teamId = options.teamId ?? 'T0FAKE0001';
  const botUserId = options.botUserId ?? 'U0FAKEBOT1';
  const botUserName = options.botUserName ?? 'manythreads_fake_bot';
  const strict = options.strictChannels === true;
  const sent: SlackSentMessage[] = [];
  const calls: SlackApiCall[] = [];
  const deliveries: SlackDelivery[] = [];
  const member = new Set<string>();
  let callback: string | null = null;
  let httpFailure: { status: number; left: number; retryAfter: number | null } | null = null;
  let okFailure: { error: string; left: number } | null = null;
  let counter = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    const method = /^\/api\/([a-zA-Z.]+)$/.exec(url.pathname)?.[1] ?? null;
    let ok = false;
    let error: string | null = null;
    const reply = (status: number, doc: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(doc));
    };
    const fail = (code: string): void => {
      error = code;
      reply(200, { ok: false, error: code });
    };
    const authorized = req.headers.authorization === `Bearer ${botToken}`;
    const done = (): void => void calls.push({ method: method ?? url.pathname, authorized, ok, error });

    if (method === null || req.method !== 'POST') {
      reply(404, { ok: false, error: 'unknown_method' });
      return done();
    }
    if (httpFailure && httpFailure.left > 0) {
      httpFailure.left--;
      reply(httpFailure.status, { ok: false, error: httpFailure.status === 429 ? 'ratelimited' : 'internal_error' }, httpFailure.retryAfter !== null ? { 'retry-after': String(httpFailure.retryAfter) } : {});
      return done();
    }
    if (!authorized) {
      fail('invalid_auth');
      return done();
    }
    if (okFailure && okFailure.left > 0) {
      okFailure.left--;
      fail(okFailure.error);
      return done();
    }
    if (method === 'auth.test') {
      ok = true;
      reply(200, { ok: true, url: 'https://fake.slack.example/', team: 'Fake workspace', user: botUserName, team_id: teamId, user_id: botUserId, bot_id: 'B0FAKE0001' });
      return done();
    }
    if (method !== 'chat.postMessage') {
      fail('unknown_method');
      return done();
    }
    let doc: Record<string, unknown>;
    try {
      doc = asRecord(JSON.parse(body));
    } catch {
      fail('invalid_json');
      return done();
    }
    const channel = String(doc['channel'] ?? '');
    const text = typeof doc['text'] === 'string' ? doc['text'] : '';
    if (!/^[CDG][A-Z0-9]{2,40}$/.test(channel)) fail('channel_not_found');
    else if (text === '') fail('no_text');
    else if (text.length > 40_000) fail('msg_too_long');
    else if (strict && !member.has(channel)) fail('not_in_channel');
    else {
      const ts = `${String(1_700_000_000 + ++counter)}.000100`;
      sent.push({ ts, channel, text, at: new Date().toISOString() });
      ok = true;
      reply(200, { ok: true, channel, ts, message: { type: 'message', user: botUserId, bot_id: 'B0FAKE0001', text } });
    }
    done();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'fatal_error' }));
    });
  });
  const listenHost = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, listenHost, resolve));
  const url = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${String((server.address() as AddressInfo).port)}`;

  const post = async (payload: string, signature: SlackSendInput['signature'], eventId: string): Promise<{ status: number | null; body: string }> => {
    if (callback === null) throw new Error('no callback address is set');
    const skew = signature === 'stale' ? -600 : signature === 'future' ? 600 : 0;
    const stamp = String(Math.floor(Date.now() / 1000) + skew);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== 'missing') {
      headers['x-slack-request-timestamp'] = stamp;
      headers['x-slack-signature'] = `v0=${createHmac('sha256', signature === 'wrong' ? `${signingSecret}x` : signingSecret).update(`v0:${stamp}:${payload}`).digest('hex')}`;
    }
    try {
      const r = await fetch(callback, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      const out = { status: r.status, body: (await r.text()).slice(0, 2048) };
      deliveries.push({ eventId, status: r.status, signature: signature ?? 'right' });
      return out;
    } catch {
      deliveries.push({ eventId, status: null, signature: signature ?? 'right' });
      return { status: null, body: '' };
    }
  };

  return {
    url,
    botToken,
    botUserId,
    appId,
    sent,
    calls,
    deliveries,
    setCallback(next) {
      callback = next;
    },
    callback: () => callback,
    addToChannel: (channel) => void member.add(channel),
    async slackSend(input) {
      const eventId = input.eventId ?? `Ev${randomBytes(8).toString('hex').toUpperCase()}`;
      const ts = input.ts ?? `${String(Math.floor(Date.now() / 1000))}.${String(++counter).padStart(6, '0')}`;
      member.add(input.channel);
      const payload = JSON.stringify({
        token: 'deprecated-verification-token',
        team_id: teamId,
        api_app_id: input.appId ?? appId,
        type: 'event_callback',
        event_id: eventId,
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: 'message',
          user: input.user,
          channel: input.channel,
          channel_type: input.channelType ?? (input.channel.startsWith('D') ? 'im' : input.channel.startsWith('G') ? 'group' : 'channel'),
          text: input.text,
          ts,
          ...(input.botId !== undefined ? { bot_id: input.botId } : {}),
          ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
        },
      });
      const responses: SlackSendResult['responses'] = [];
      for (let i = 0; i < Math.max(1, input.repeat ?? 1); i++) responses.push(await post(payload, input.signature, eventId));
      return { eventId, responses };
    },
    slackVerify(opts = {}) {
      return post(JSON.stringify({ token: 'deprecated-verification-token', challenge: opts.challenge ?? '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P', type: 'url_verification' }), opts.signature, 'url_verification');
    },
    failNext(status, count = 1, retryAfter) {
      httpFailure = { status, left: count, retryAfter: retryAfter ?? (status === 429 ? 1 : null) };
    },
    failNextOk(error, count = 1) {
      okFailure = { error, left: count };
    },
    reset() {
      sent.length = 0;
      calls.length = 0;
      deliveries.length = 0;
      member.clear();
      callback = null;
      httpFailure = null;
      okFailure = null;
      counter = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const slackModule: StandInModule = {
  id: 'slack',
  async start(ctx: StandInContext): Promise<StandInHandle<FakeSlack>> {
    const opts = asRecord(ctx.options) as FakeSlackOptions;
    const slack = await startFakeSlack({ ...opts, host: ctx.host, port: ctx.port, publicHost: ctx.publicHost });
    return {
      id: 'slack',
      api: slack,
      urls: { url: slack.url },
      // the bridge dials `<base>/api/chat.postMessage` here instead of slack.com (honoured outside production only)
      env: () => ({ MANYTHREADS_BRIDGE_SLACK_FAKE_BASE: slack.url }),
      state: () => ({ appId: slack.appId, botUserId: slack.botUserId, sent: slack.sent, calls: slack.calls, deliveries: slack.deliveries, callback: slack.callback() }),
      reset: () => slack.reset(),
      async control(request) {
        const b = asRecord(request.body);
        if (request.method === 'POST' && request.path === '/callback') {
          slack.setCallback(typeof b['url'] === 'string' ? b['url'] : null);
          return { status: 200, body: { ok: true } };
        }
        if (request.method === 'POST' && request.path === '/send') return { status: 200, body: await slack.slackSend(b as unknown as SlackSendInput) };
        if (request.method === 'POST' && request.path === '/verify') return { status: 200, body: await slack.slackVerify(b as { challenge?: string; signature?: SlackSendInput['signature'] }) };
        if (request.method === 'POST' && request.path === '/fail-next') {
          if (typeof b['error'] === 'string') slack.failNextOk(b['error'], Number(b['count'] ?? 1));
          else slack.failNext(Number(b['status'] ?? 500), Number(b['count'] ?? 1), b['retryAfter'] === undefined ? undefined : Number(b['retryAfter']));
          return { status: 200, body: { ok: true } };
        }
        return null;
      },
      stop: () => slack.stop(),
    };
  },
};
