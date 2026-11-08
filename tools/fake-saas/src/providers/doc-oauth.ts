import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * The shared half of the three document stand-ins (PLAN Bundle D, P16-08: Confluence, Dropbox, Box): one small server with an OAuth consent address, a token address
 * (authorization code with or without PKCE, refresh with or without rotation), Bearer checking for the API, and the call log. What the API answers is the module's own
 * (`api`). Like every stand-in it holds no real secret, and `tools/fake-saas` refuses to start in production.
 *
 * What it never shows: a token, a code, a verifier or the client secret are not part of `apiCalls`, `tokenCalls` or `consents`.
 */

export interface DocApiRequest {
  method: string;
  /** The path without the query. */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
  /** The account the token belongs to. */
  account: string;
  scopes: string[];
  send(status: number, doc: unknown, headers?: Record<string, string>): void;
  sendBytes(status: number, bytes: Buffer, contentType: string, headers?: Record<string, string>): void;
  redirect(location: string): void;
}

export interface DocServerOptions {
  /** The provider id, as the connections plugin names it (`confluence`, `dropbox`, `box`). */
  id: string;
  host?: string;
  port?: number;
  publicHost?: string;
  clientId?: string;
  clientSecret?: string;
  authorizePath: string;
  tokenPath: string;
  /** Does the consent ask for (and the token call check) a PKCE proof. */
  pkce: boolean;
  /** Does a renewal hand back a new refresh token and kill the old one. */
  rotate: boolean;
  /** Seconds an access token lives. */
  accessTtl?: number;
  /** The paths (beyond the API of the module) that are answered without a token, e.g. none. */
  api(request: DocApiRequest): void | Promise<void>;
}

export interface DocApiCall {
  method: string;
  path: string;
  authorized: boolean;
}

export interface DocTokenCall {
  grant: string;
  ok: boolean;
  pkce: boolean | null;
}

export interface DocServer {
  url: string;
  clientId: string;
  clientSecret: string;
  apiCalls: DocApiCall[];
  tokenCalls: DocTokenCall[];
  consents: Array<{ scopes: string[]; hasChallenge: boolean }>;
  /** The account the next consent signs in as. */
  signInAs(email: string): void;
  /** A sign-in that already exists, as a seed makes it (no consent): the tokens it hands back are accepted by the API. */
  grant(email: string, scopes?: string[]): { accessToken: string; refreshToken: string };
  /** Every access token issued so far stops working (the API answers 401) while refresh tokens still work. */
  expireAccessTokens(): void;
  /** Every refresh token issued so far is refused with `invalid_grant`. */
  revokeRefreshTokens(): void;
  /** The next `count` API calls answer `status` before anything else. */
  failNextApi(status: number, count?: number): void;
  clearLogs(): void;
  stop(): Promise<void>;
}

interface Issued {
  account: string;
  scopes: string[];
}

const sha256url = (value: string): string => createHash('sha256').update(value).digest('base64url');
const fresh = (prefix: string): string => `${prefix}-${randomBytes(18).toString('base64url')}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startDocServer(options: DocServerOptions): Promise<DocServer> {
  const clientId = options.clientId ?? `fake-${options.id}-client-id`;
  const clientSecret = options.clientSecret ?? `fake-${options.id}-client-secret`;
  const accessTtl = options.accessTtl ?? 3600;
  let signedInAs = 'person@kahf.example';
  let apiFailure: { status: number; left: number } | null = null;
  const codes = new Map<string, Issued & { redirectUri: string; challenge: string | null }>();
  const accessTokens = new Map<string, Issued & { expired: boolean }>();
  const refreshTokens = new Map<string, Issued & { dead: boolean }>();
  const apiCalls: DocApiCall[] = [];
  const tokenCalls: DocTokenCall[] = [];
  const consents: DocServer['consents'] = [];
  let baseUrl = '';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const send = (status: number, doc: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(doc));
    };

    // ---- the consent address ----
    if (method === 'GET' && path === options.authorizePath) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== clientId || !redirectUri || q.get('response_type') !== 'code') return send(400, { error: 'invalid_request' });
      const scopes = (q.get('scope') ?? '').split(/[\s,]+/).filter((x) => x !== '');
      consents.push({ scopes, hasChallenge: q.has('code_challenge') });
      const code = fresh('code');
      codes.set(code, { account: signedInAs, scopes, redirectUri, challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    // ---- the token address ----
    if (method === 'POST' && path === options.tokenPath) {
      const form: Record<string, string> = body.trim().startsWith('{') ? (JSON.parse(body) as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
      const grant = String(form['grant_type'] ?? '');
      const basic = /^Basic (.+)$/.exec(String(req.headers['authorization'] ?? ''))?.[1];
      const [basicId, basicSecret] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':') : [undefined, undefined];
      const givenId = form['client_id'] ?? basicId;
      const givenSecret = form['client_secret'] ?? basicSecret;
      const fail = (status: number, error: string, pkce: boolean | null = null): void => {
        tokenCalls.push({ grant, ok: false, pkce });
        return send(status, { error });
      };
      if (givenId !== clientId || givenSecret !== clientSecret) return fail(401, 'invalid_client');
      let issued: Issued;
      let pkce: boolean | null = null;
      let refresh: string;
      if (grant === 'authorization_code') {
        const code = codes.get(String(form['code'] ?? ''));
        codes.delete(String(form['code'] ?? ''));
        if (!code || code.redirectUri !== form['redirect_uri']) return fail(400, 'invalid_grant');
        if (options.pkce) {
          pkce = code.challenge !== null && sha256url(String(form['code_verifier'] ?? '')) === code.challenge;
          if (!pkce) return fail(400, 'invalid_grant', false);
        }
        issued = { account: code.account, scopes: code.scopes };
        refresh = fresh('refresh');
        refreshTokens.set(refresh, { ...issued, dead: false });
      } else if (grant === 'refresh_token') {
        const old = refreshTokens.get(String(form['refresh_token'] ?? ''));
        if (!old || old.dead) return fail(400, 'invalid_grant');
        issued = old;
        refresh = String(form['refresh_token']);
        if (options.rotate) {
          old.dead = true;
          refresh = fresh('refresh');
          refreshTokens.set(refresh, { ...issued, dead: false });
        }
      } else return fail(400, 'unsupported_grant_type');
      const access = fresh('access');
      accessTokens.set(access, { ...issued, expired: false });
      tokenCalls.push({ grant, ok: true, pkce });
      return send(200, {
        access_token: access,
        token_type: 'bearer',
        expires_in: accessTtl,
        scope: issued.scopes.join(' '),
        // a renewal hands the refresh token back only when it rotates
        ...(grant === 'authorization_code' || options.rotate ? { refresh_token: refresh } : {}),
      });
    }

    // ---- the API ----
    const bearer = /^Bearer (.+)$/.exec(String(req.headers['authorization'] ?? ''))?.[1];
    const token = bearer ? accessTokens.get(bearer) : undefined;
    const authorized = token !== undefined && !token.expired;
    apiCalls.push({ method, path, authorized });
    if (!authorized || !token) return send(401, { error: 'invalid_token' });
    if (apiFailure && apiFailure.left > 0) {
      apiFailure.left -= 1;
      return send(apiFailure.status, { error: 'forced failure' });
    }
    await options.api({
      method,
      path,
      query: url.searchParams,
      headers: req.headers,
      body,
      account: token.account,
      scopes: token.scopes,
      send,
      sendBytes: (status, bytes, contentType, headers = {}) => {
        res.writeHead(status, { 'content-type': contentType, 'content-length': String(bytes.length), ...headers });
        res.end(bytes);
      },
      redirect: (location) => {
        res.writeHead(302, { location });
        res.end();
      },
    });
    if (!res.headersSent) send(404, { error: 'not_found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"fake_failed"}');
    });
  });
  const listenHost = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, listenHost, resolve));
  baseUrl = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${String((server.address() as AddressInfo).port)}`;

  return {
    url: baseUrl,
    clientId,
    clientSecret,
    apiCalls,
    tokenCalls,
    consents,
    signInAs: (email) => void (signedInAs = email),
    grant(email, scopes = []) {
      const access = fresh('access');
      const refresh = fresh('refresh');
      accessTokens.set(access, { account: email, scopes, expired: false });
      refreshTokens.set(refresh, { account: email, scopes, dead: false });
      return { accessToken: access, refreshToken: refresh };
    },
    expireAccessTokens: () => void [...accessTokens.values()].forEach((t) => void (t.expired = true)),
    revokeRefreshTokens: () => void [...refreshTokens.values()].forEach((t) => void (t.dead = true)),
    failNextApi: (status, count = 1) => void (apiFailure = { status, left: count }),
    clearLogs() {
      apiCalls.length = 0;
      tokenCalls.length = 0;
      consents.length = 0;
      apiFailure = null;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The variables that make the connections plugin use a stand-in at `url`. */
export const oauthEnv = (id: string, server: Pick<DocServer, 'url' | 'clientId' | 'clientSecret'>): Record<string, string> => ({
  [`MANYTHREADS_OAUTH_${id.toUpperCase()}_CLIENT_ID`]: server.clientId,
  [`MANYTHREADS_OAUTH_${id.toUpperCase()}_CLIENT_SECRET`]: server.clientSecret,
  [`MANYTHREADS_OAUTH_${id.toUpperCase()}_FAKE_BASE`]: server.url,
});
