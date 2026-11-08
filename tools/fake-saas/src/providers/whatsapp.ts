import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StandInContext, StandInHandle, StandInModule } from './types.ts';

/*
 * A WhatsApp Business (Cloud API) stand-in (PLAN Bundle D, D29). Answers the two calls the chat bridge makes at Meta's Graph API and checks what Meta checks:
 *   - `GET /v21.0/<phone number id>?fields=display_phone_number` with `Authorization: Bearer <access token>`: the number, or 401 `OAuthException` for a wrong token;
 *   - `POST /v21.0/<phone number id>/messages`: needs the token, `messaging_product: "whatsapp"`, a `to` of digits and a text body of at most 4096 characters. A text to a person who has
 *     not written to the number in the last 24 hours is refused (400, code 131047), as at Meta.
 * The other side, a person writing to the number, is `whatsappSend`: it POSTs the Cloud API's webhook payload to the callback address with `X-Hub-Signature-256: sha256=<hmac of the
 * body with the app secret>`. `whatsappVerify` does Meta's one-time GET check (`hub.mode`, `hub.verify_token`, `hub.challenge`). Neither the access token nor the app secret is ever shown
 * by the state.
 */

export interface FakeWhatsappNumber {
  /** The phone number id the bridge is given. */
  phoneNumberId: string;
  /** The number as people read it. */
  displayNumber: string;
  /** The access token the bridge is given. */
  token: string;
}

export interface FakeWhatsappOptions {
  numbers?: Array<Partial<FakeWhatsappNumber>>;
  /** The secret Meta signs calls with (the app secret). */
  appSecret?: string;
  /** The word Meta sends back in its URL check. */
  verifyToken?: string;
  /** Refuse a text outside the 24-hour window (default true). */
  enforceWindow?: boolean;
}

export interface WhatsappSentMessage {
  id: string;
  phoneNumberId: string;
  to: string;
  text: string;
  at: string;
}

export interface WhatsappApiCall {
  phoneNumberId: string | null;
  method: string;
  path: string;
  authorized: boolean;
  status: number;
}

export interface WhatsappDelivery {
  phoneNumberId: string;
  messageId: string;
  status: number | null;
  signature: 'right' | 'wrong' | 'missing';
}

export interface WhatsappSendInput {
  fromNumber: string;
  text: string;
  name?: string;
  /** Which number is written to (its phone number id); default the first. */
  phoneNumberId?: string;
  /** Default: random. Send the same id twice to play a replay. */
  messageId?: string;
  /** `wrong`: signed with another secret; `missing`: no signature header. Default: the right one. */
  signature?: 'wrong' | 'missing';
  /** Post the same call this many times (default 1). */
  repeat?: number;
  /** Seconds since the epoch; default now. */
  timestamp?: number;
}

export interface WhatsappSendResult {
  messageId: string;
  responses: Array<{ status: number | null; body: string }>;
}

export interface FakeWhatsapp {
  url: string;
  numbers: FakeWhatsappNumber[];
  sent: WhatsappSentMessage[];
  calls: WhatsappApiCall[];
  deliveries: WhatsappDelivery[];
  /** Where Meta sends events (the bridge's address). */
  setCallback(url: string | null): void;
  callback(): string | null;
  whatsappSend(input: WhatsappSendInput): Promise<WhatsappSendResult>;
  /** Meta's one-time GET check of the callback address. `token` default: the right verify word. */
  whatsappVerify(options?: { token?: string; challenge?: string }): Promise<{ status: number | null; body: string }>;
  /** Forget that these people (or everyone) wrote to the numbers: the 24-hour window is closed again. */
  closeWindow(fromNumber?: string): void;
  failNext(status: number, count?: number): void;
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_TOKEN = 'FAKE-whatsapp-access-token-for-tests-0001';
export const FAKE_WHATSAPP_APP_SECRET = 'fake-whatsapp-app-secret-0001';
export const FAKE_WHATSAPP_VERIFY_TOKEN = 'fake-whatsapp-verify-word-0001';
const WINDOW_MS = 24 * 3_600_000;

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

export async function startFakeWhatsapp(options: FakeWhatsappOptions & { host?: string; port?: number; publicHost?: string } = {}): Promise<FakeWhatsapp> {
  const numbers: FakeWhatsappNumber[] = (options.numbers?.length ? options.numbers : [{}]).map((n, i) => ({
    phoneNumberId: n.phoneNumberId ?? String(104_000_000_000_000 + i),
    displayNumber: n.displayNumber ?? `+1 555 01${String(i).padStart(2, '0')}`,
    token: n.token ?? (i === 0 ? DEFAULT_TOKEN : `FAKE-whatsapp-access-token-for-tests-${String(i + 1).padStart(4, '0')}`),
  }));
  const appSecret = options.appSecret ?? FAKE_WHATSAPP_APP_SECRET;
  const verifyToken = options.verifyToken ?? FAKE_WHATSAPP_VERIFY_TOKEN;
  const enforceWindow = options.enforceWindow !== false;
  const sent: WhatsappSentMessage[] = [];
  const calls: WhatsappApiCall[] = [];
  const deliveries: WhatsappDelivery[] = [];
  /** `<phone number id>/<person>` to when the person last wrote. */
  const lastWrote = new Map<string, number>();
  let callback: string | null = null;
  let failure: { status: number; left: number } | null = null;
  let counter = 0;

  const numberOf = (id: string | undefined): FakeWhatsappNumber | undefined => (id === undefined ? numbers[0] : numbers.find((n) => n.phoneNumberId === id));

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    const method = req.method ?? 'GET';
    const match = /^\/v\d+\.\d+\/([0-9]+)(\/messages)?$/.exec(url.pathname);
    const number = numberOf(match?.[1]);
    let status = 200;
    const send = (code: number, doc: unknown): void => {
      status = code;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    };
    const error = (code: number, message: string, subcode?: number): void =>
      send(code, { error: { message, type: code === 401 ? 'OAuthException' : 'GraphMethodException', code: subcode ?? code, fbtrace_id: randomBytes(6).toString('hex') } });
    const done = (): void => void calls.push({ phoneNumberId: match?.[1] ?? null, method, path: url.pathname, authorized: req.headers.authorization === `Bearer ${number?.token ?? ''}`, status });

    if (!match || !number) {
      error(404, 'Unsupported request');
      return done();
    }
    if (req.headers.authorization !== `Bearer ${number.token}`) {
      error(401, 'Invalid OAuth access token.', 190);
      return done();
    }
    if (failure && failure.left > 0) {
      failure.left--;
      error(failure.status, 'An unexpected error has occurred.', 2);
      return done();
    }
    if (match[2] === undefined) {
      if (method !== 'GET') error(400, 'Unsupported request');
      else send(200, { display_phone_number: number.displayNumber, id: number.phoneNumberId });
      return done();
    }
    if (method !== 'POST') {
      error(400, 'Unsupported request');
      return done();
    }
    let doc: Record<string, unknown>;
    try {
      doc = asRecord(JSON.parse(body));
    } catch {
      error(400, 'Invalid JSON', 100);
      return done();
    }
    const to = String(doc['to'] ?? '');
    const text = String(asRecord(doc['text'])['body'] ?? '');
    if (doc['messaging_product'] !== 'whatsapp') error(400, 'The parameter messaging_product is required.', 100);
    else if (!/^[0-9]{5,20}$/.test(to)) error(400, 'Invalid parameter', 100);
    else if (doc['type'] !== 'text' || text === '') error(400, 'The parameter text[body] is required.', 100);
    else if (text.length > 4096) error(400, 'Param text[body] must be at most 4096 characters long.', 100);
    else if (enforceWindow && Date.now() - (lastWrote.get(`${number.phoneNumberId}/${to}`) ?? 0) > WINDOW_MS) {
      error(400, 'Re-engagement message: more than 24 hours have passed since the customer last replied to this number.', 131047);
    } else {
      const id = `wamid.FAKE${String(++counter).padStart(6, '0')}`;
      sent.push({ id, phoneNumberId: number.phoneNumberId, to, text, at: new Date().toISOString() });
      send(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] });
    }
    done();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'An unexpected error has occurred.', code: 2 } }));
    });
  });
  const listenHost = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, listenHost, resolve));
  const url = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${String((server.address() as AddressInfo).port)}`;

  return {
    url,
    numbers,
    sent,
    calls,
    deliveries,
    setCallback(next) {
      callback = next;
    },
    callback: () => callback,
    async whatsappSend(input) {
      const number = numberOf(input.phoneNumberId);
      if (!number) throw new Error('no such number');
      if (callback === null) throw new Error('no callback address is set');
      const messageId = input.messageId ?? `wamid.IN${randomBytes(8).toString('hex')}`;
      lastWrote.set(`${number.phoneNumberId}/${input.fromNumber}`, Date.now());
      const payload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '100000000000001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: number.displayNumber.replace(/\D/g, ''), phone_number_id: number.phoneNumberId },
                  contacts: [{ profile: { name: input.name ?? 'Person' }, wa_id: input.fromNumber }],
                  messages: [{ from: input.fromNumber, id: messageId, timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)), text: { body: input.text }, type: 'text' }],
                },
              },
            ],
          },
        ],
      });
      const responses: WhatsappSendResult['responses'] = [];
      for (let i = 0; i < Math.max(1, input.repeat ?? 1); i++) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        let signature: WhatsappDelivery['signature'] = 'right';
        if (input.signature === 'missing') signature = 'missing';
        else if (input.signature === 'wrong') {
          headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', `${appSecret}x`).update(payload).digest('hex')}`;
          signature = 'wrong';
        } else headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;
        try {
          const r = await fetch(callback, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
          responses.push({ status: r.status, body: (await r.text()).slice(0, 2048) });
          deliveries.push({ phoneNumberId: number.phoneNumberId, messageId, status: r.status, signature });
        } catch {
          responses.push({ status: null, body: '' });
          deliveries.push({ phoneNumberId: number.phoneNumberId, messageId, status: null, signature });
        }
      }
      return { messageId, responses };
    },
    async whatsappVerify(opts = {}) {
      if (callback === null) throw new Error('no callback address is set');
      const target = new URL(callback);
      target.searchParams.set('hub.mode', 'subscribe');
      target.searchParams.set('hub.verify_token', opts.token ?? verifyToken);
      target.searchParams.set('hub.challenge', opts.challenge ?? String(1_158_201_444));
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        return { status: r.status, body: (await r.text()).slice(0, 2048) };
      } catch {
        return { status: null, body: '' };
      }
    },
    closeWindow(fromNumber) {
      for (const key of [...lastWrote.keys()]) if (fromNumber === undefined || key.endsWith(`/${fromNumber}`)) lastWrote.delete(key);
    },
    failNext(status, count = 1) {
      failure = { status, left: count };
    },
    reset() {
      sent.length = 0;
      calls.length = 0;
      deliveries.length = 0;
      lastWrote.clear();
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

export const whatsappModule: StandInModule = {
  id: 'whatsapp',
  async start(ctx: StandInContext): Promise<StandInHandle<FakeWhatsapp>> {
    const opts = asRecord(ctx.options) as FakeWhatsappOptions;
    const whatsapp = await startFakeWhatsapp({ ...opts, host: ctx.host, port: ctx.port, publicHost: ctx.publicHost });
    return {
      id: 'whatsapp',
      api: whatsapp,
      urls: { url: whatsapp.url },
      // the bridge dials `<base>/v21.0/<phone number id>/messages` here instead of graph.facebook.com (honoured outside production only)
      env: () => ({ MANYTHREADS_BRIDGE_WHATSAPP_FAKE_BASE: whatsapp.url }),
      state: () => ({
        numbers: whatsapp.numbers.map((n) => ({ phoneNumberId: n.phoneNumberId, displayNumber: n.displayNumber })),
        sent: whatsapp.sent,
        calls: whatsapp.calls,
        deliveries: whatsapp.deliveries,
        callback: whatsapp.callback(),
      }),
      reset: () => whatsapp.reset(),
      async control(request) {
        if (request.method === 'POST' && request.path === '/callback') {
          const b = asRecord(request.body);
          whatsapp.setCallback(typeof b['url'] === 'string' ? b['url'] : null);
          return { status: 200, body: { ok: true } };
        }
        if (request.method === 'POST' && request.path === '/send') return { status: 200, body: await whatsapp.whatsappSend(asRecord(request.body) as unknown as WhatsappSendInput) };
        if (request.method === 'POST' && request.path === '/verify') return { status: 200, body: await whatsapp.whatsappVerify(asRecord(request.body) as { token?: string; challenge?: string }) };
        if (request.method === 'POST' && request.path === '/close-window') {
          const b = asRecord(request.body);
          whatsapp.closeWindow(typeof b['fromNumber'] === 'string' ? b['fromNumber'] : undefined);
          return { status: 200, body: { ok: true } };
        }
        if (request.method === 'POST' && request.path === '/fail-next') {
          const b = asRecord(request.body);
          whatsapp.failNext(Number(b['status'] ?? 500), Number(b['count'] ?? 1));
          return { status: 200, body: { ok: true } };
        }
        return null;
      },
      stop: () => whatsapp.stop(),
    };
  },
};
