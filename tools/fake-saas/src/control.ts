import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeAccountData, FakeFile, FakePermission } from '../../../packages/test-utils/src/fake-providers-data.ts';
import { timingSafeEqual } from 'node:crypto';
import { TAMPERS, WEBHOOK_PROVIDERS, type SendWebhookOptions, type SendWebhookResult, type Tamper, type WebhookProvider } from './providers/sender.ts';
import type { FakeSaas } from './server.ts';

/*
 * The control port (`/__fake/*`): how a spec, a probe or the CLI user changes the world of the stand-ins and reads what they saw. It answers JSON only, takes bodies up
 * to 5 MB, and with a control key set refuses every call that does not carry it in `x-fake-saas-key`.
 *
 *   GET   /__fake/health
 *   GET   /__fake/state                          what the stand-ins saw (calls, writes, sent Telegram messages) - never a token
 *   GET   /__fake/env                            the variables for the server under test
 *   POST  /__fake/reset                          forget everything recorded, put the data back as at the start
 *   POST  /__fake/send-webhook                   { provider, url, secret, kind, tamper?, title?, ref?, actor?, now?, deliveryId?, body?, padBytes? }
 *   POST  /__fake/telegram/send                  { fromUserId, chatId?, chatType?, text, username?, secretHeader?, updateId?, repeat? }
 *   POST  /__fake/telegram/fail-next             { status, count?, method?, retryAfter? }
 *   PATCH /__fake/accounts/:email                { files?, removeFiles?, trashFiles?, events?, pages?, mails?, shareCalendar? }
 *   PUT   /__fake/drive/:fileId/permissions      { account?, permissions: [{ type: 'anyone' } | { type: 'domain', domain } | { type: 'user'|'group', email }] }
 *   POST  /__fake/sign-in-as                     { email }              the account the next consent signs in as
 *   POST  /__fake/deny-next-consent
 *   POST  /__fake/expire-tokens                  every access token stops working
 *   POST  /__fake/revoke-refresh-tokens
 *   POST  /__fake/fail-next                      { service: 'workspace'|'trackers'|'support', status, count? }
 *   *     /__fake/<module>/...                   a module's own actions
 */

export interface Control {
  url: string;
  stop(): Promise<void>;
}

const MAX_BODY = 5_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'the body is too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'the body is not JSON');
  }
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `${name} is required`);
  return v;
};

const sameKey = (given: string | undefined, key: string): boolean => {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function startControl(options: {
  host: string;
  publicHost: string;
  port: number;
  key?: string;
  saas: FakeSaas;
  record: (options: SendWebhookOptions) => Promise<SendWebhookResult>;
}): Promise<Control> {
  const { saas } = options;

  const route = async (req: IncomingMessage, url: URL): Promise<{ status: number; body: unknown }> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const ok = { status: 200, body: { ok: true } };
    if (!path.startsWith('/__fake/')) return { status: 404, body: { error: 'not_found' } };
    const sub = path.slice('/__fake'.length);

    if (method === 'GET' && sub === '/health') return ok;
    if (method === 'GET' && sub === '/state') return { status: 200, body: saas.control.state() };
    if (method === 'GET' && sub === '/env') return { status: 200, body: saas.env() };
    if (method === 'POST' && sub === '/reset') {
      saas.control.reset();
      return ok;
    }

    if (method === 'POST' && sub === '/send-webhook') {
      const b = rec(await readJson(req));
      const provider = str(b['provider'], 'provider') as WebhookProvider;
      if (!WEBHOOK_PROVIDERS.includes(provider)) throw new HttpError(400, `unknown provider "${provider}"`);
      const tamper = (b['tamper'] ?? 'none') as Tamper;
      if (!TAMPERS.includes(tamper)) throw new HttpError(400, `unknown tamper "${String(tamper)}"`);
      const send: SendWebhookOptions = {
        provider,
        url: str(b['url'], 'url'),
        secret: str(b['secret'], 'secret'),
        kind: str(b['kind'], 'kind'),
        tamper,
        ...(typeof b['title'] === 'string' ? { title: b['title'] } : {}),
        ...(typeof b['ref'] === 'string' || typeof b['ref'] === 'number' ? { ref: b['ref'] } : {}),
        ...(typeof b['actor'] === 'string' ? { actor: b['actor'] } : {}),
        ...(typeof b['now'] === 'string' ? { now: b['now'] } : {}),
        ...(typeof b['deliveryId'] === 'string' ? { deliveryId: b['deliveryId'] } : {}),
        ...(typeof b['body'] === 'string' ? { body: b['body'] } : {}),
        ...(typeof b['padBytes'] === 'number' ? { padBytes: b['padBytes'] } : {}),
      };
      try {
        return { status: 200, body: await options.record(send) };
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'the webhook could not be sent');
      }
    }

    if (method === 'POST' && sub === '/sign-in-as') {
      const email = str(rec(await readJson(req))['email'], 'email');
      saas.workspace.signInAs(email);
      saas.trackers.signInAs(email);
      saas.support.signInAs(email);
      return ok;
    }
    if (method === 'POST' && sub === '/deny-next-consent') {
      saas.workspace.denyNextConsent();
      saas.support.denyNextConsent();
      return ok;
    }
    if (method === 'POST' && sub === '/expire-tokens') {
      saas.workspace.expireAccessTokens();
      saas.trackers.expireAccessTokens();
      saas.support.expireAccessTokens();
      return ok;
    }
    if (method === 'POST' && sub === '/revoke-refresh-tokens') {
      saas.workspace.revokeRefreshTokens();
      saas.support.revokeRefreshTokens();
      return ok;
    }
    if (method === 'POST' && sub === '/fail-next') {
      const b = rec(await readJson(req));
      const service = str(b['service'], 'service');
      const status = Number(b['status'] ?? 500);
      const count = Number(b['count'] ?? 1);
      if (service === 'workspace') saas.workspace.failNextApi(status, count);
      else if (service === 'trackers') saas.trackers.failNextApi(status, count);
      else if (service === 'support') saas.support.failNextApi(status, count);
      else throw new HttpError(400, `unknown service "${service}"`);
      return ok;
    }

    const account = /^\/accounts\/([^/]+)$/.exec(sub);
    if (method === 'PATCH' && account) {
      const email = decodeURIComponent(account[1]!);
      const b = rec(await readJson(req));
      const w = saas.workspace;
      const data: FakeAccountData = w.account(email);
      for (const f of Array.isArray(b['files']) ? (b['files'] as FakeFile[]) : []) w.putFile(email, f);
      for (const id of Array.isArray(b['removeFiles']) ? (b['removeFiles'] as string[]) : []) w.removeFile(email, id);
      for (const id of Array.isArray(b['trashFiles']) ? (b['trashFiles'] as string[]) : []) w.trashFile(email, id);
      for (const e of Array.isArray(b['events']) ? (b['events'] as FakeAccountData['events']) : []) w.putEvent(email, e);
      for (const pg of Array.isArray(b['pages']) ? (b['pages'] as FakeAccountData['pages']) : []) w.putPage(email, pg);
      for (const m of Array.isArray(b['mails']) ? (b['mails'] as FakeAccountData['mails']) : []) {
        const at = data.mails.findIndex((x) => x.id === m.id);
        if (at >= 0) data.mails[at] = m;
        else data.mails.push(m);
      }
      if (typeof b['shareCalendar'] === 'boolean') data.shareCalendar = b['shareCalendar'];
      return { status: 200, body: { ok: true, files: data.files.length, events: data.events.length, pages: data.pages.length, mails: data.mails.length, shareCalendar: data.shareCalendar !== false } };
    }

    const permissions = /^\/drive\/([^/]+)\/permissions$/.exec(sub);
    if (method === 'PUT' && permissions) {
      const fileId = decodeURIComponent(permissions[1]!);
      const b = rec(await readJson(req));
      const list = b['permissions'];
      if (!Array.isArray(list)) throw new HttpError(400, 'permissions must be a list');
      for (const p of list) {
        const t = rec(p)['type'];
        if (t !== 'anyone' && t !== 'domain' && t !== 'user' && t !== 'group') throw new HttpError(400, 'a permission is anyone, domain, user or group');
      }
      const email = typeof b['account'] === 'string' ? b['account'] : undefined;
      const holder = email ?? saas.workspace.accountEmails().find((e) => saas.workspace.account(e).files.some((f) => f.id === fileId));
      if (!holder || !saas.workspace.account(holder).files.some((f) => f.id === fileId)) throw new HttpError(404, 'no such file');
      saas.workspace.setFilePermissions(holder, fileId, list as FakePermission[]);
      return ok;
    }

    // a module's own actions: /__fake/<id>/...
    const own = /^\/([a-z0-9-]+)(\/.*)?$/.exec(sub);
    const handle = own ? saas.standIns[own[1]!] : undefined;
    if (handle?.control) {
      const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
      const answer = await handle.control({ method, path: own![2] ?? '/', query: url.searchParams, body });
      if (answer) return answer;
    }
    return { status: 404, body: { error: 'not_found' } };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const finish = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (options.key !== undefined && !sameKey(req.headers['x-fake-saas-key'] as string | undefined, options.key)) return finish(401, { error: 'unauthorized' });
    route(req, url).then(
      (answer) => finish(answer.status, answer.body),
      (error: unknown) => (error instanceof HttpError ? finish(error.status, { error: error.message }) : finish(500, { error: 'control failure' })),
    );
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return {
    url: `http://${options.publicHost}:${String((server.address() as AddressInfo).port)}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
