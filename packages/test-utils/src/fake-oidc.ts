import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/**
 * A small in-process OpenID Connect issuer for vitest and API tests: discovery, JWKS, an authorize endpoint that
 * redirects straight back (no login form), and a token endpoint that checks the client secret, the redirect URI and
 * PKCE S256 and returns a signed id_token. Several issuers (`google`, `microsoft`, `any`, ...) live on one port at
 * `<baseUrl>/<issuerId>`, the same layout as navikt/mock-oauth2-server (tools/mock-oidc), which Playwright uses.
 *
 * The claims of a sign-in are set per test with `nextLogin`; options let a test break one thing at a time (wrong nonce,
 * wrong signing key, wrong audience, expired token).
 */

export interface FakeLoginClaims {
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Google Workspace hosted domain. */
  hd?: string;
  /** Microsoft tenant id. */
  tid?: string;
  sub?: string;
  [claim: string]: unknown;
}

export interface FakeLoginOptions {
  /** Put this nonce in the id_token instead of the one the client sent. */
  nonce?: string;
  /** Sign with a key that is not in the JWKS. */
  badSignature?: boolean;
  /** Put this audience in the id_token instead of the client id. */
  audience?: string;
  /** Issue an id_token that expired an hour ago. */
  expired?: boolean;
  /** Leave the id_token out of the token response. */
  omitIdToken?: boolean;
}

export interface FakeOidcRequest {
  issuerId: string;
  method: string;
  path: string;
}

export interface FakeOidc {
  /** `http://127.0.0.1:<port>` */
  readonly baseUrl: string;
  /** The issuer URL of an issuer id: `<baseUrl>/<id>`. */
  issuer(issuerId: string): string;
  /** Registers the client (id and secret) that may use this issuer. */
  addClient(issuerId: string, client: { clientId: string; clientSecret: string }): void;
  /** The claims of the next sign-in at this issuer (used by the next `authorize` call, then forgotten). */
  nextLogin(issuerId: string, claims: FakeLoginClaims, options?: FakeLoginOptions): void;
  /** Make discovery answer 500 for this issuer (or stop doing so). */
  failDiscovery(issuerId: string, fail?: boolean): void;
  /** Every request the issuer received, in order. */
  readonly requests: readonly FakeOidcRequest[];
  close(): Promise<void>;
}

interface PendingLogin {
  claims: FakeLoginClaims;
  options: FakeLoginOptions;
}

interface IssuedCode {
  issuerId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  login: PendingLogin;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startFakeOidc(options: { port?: number } = {}): Promise<FakeOidc> {
  const good = await generateKeyPair('RS256', { extractable: true });
  const evil = await generateKeyPair('RS256', { extractable: true });
  const kid = `fake-${randomBytes(4).toString('hex')}`;
  const publicJwk: JWK = { ...(await exportJWK(good.publicKey)), kid, alg: 'RS256', use: 'sig' };

  const clients = new Map<string, { clientId: string; clientSecret: string }>();
  const logins = new Map<string, PendingLogin>();
  const failing = new Set<string>();
  const codes = new Map<string, IssuedCode>();
  const requests: FakeOidcRequest[] = [];
  let baseUrl = '';

  const issuerUrl = (id: string): string => `${baseUrl}/${id}`;

  const signIdToken = async (issuer: string, code: IssuedCode): Promise<string> => {
    const { claims, options: o } = code.login;
    const email = claims.email;
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      email_verified: true,
      ...(email ? { sub: `fake|${email}` } : {}),
      ...claims,
      nonce: o.nonce ?? code.nonce,
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: o.badSignature ? 'unknown-key' : kid })
      .setIssuer(issuer)
      .setAudience(o.audience ?? code.clientId)
      .setIssuedAt(o.expired ? now - 7200 : now)
      .setExpirationTime(o.expired ? now - 3600 : now + 3600)
      .sign((o.badSignature ? evil.privateKey : good.privateKey));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', baseUrl);
    const [, issuerId = '', ...rest] = url.pathname.split('/');
    const endpoint = rest.join('/');
    requests.push({ issuerId, method: req.method ?? 'GET', path: url.pathname });
    const issuer = issuerUrl(issuerId);

    if (endpoint === '.well-known/openid-configuration' && req.method === 'GET') {
      if (failing.has(issuerId)) return json(res, 500, { error: 'server_error' });
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
        claims_supported: ['sub', 'email', 'email_verified', 'name', 'hd', 'tid'],
      });
    }
    if (endpoint === 'jwks' && req.method === 'GET') return json(res, 200, { keys: [publicJwk] });

    if (endpoint === 'authorize' && req.method === 'GET') {
      const p = url.searchParams;
      const client = clients.get(issuerId);
      const redirectUri = p.get('redirect_uri');
      if (!client || p.get('client_id') !== client.clientId) return json(res, 400, { error: 'unauthorized_client' });
      if (!redirectUri) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri missing' });
      const back = new URL(redirectUri);
      if (p.get('state')) back.searchParams.set('state', p.get('state') as string);
      const login = logins.get(issuerId);
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('nonce')) {
        back.searchParams.set('error', 'invalid_request');
        res.writeHead(302, { location: back.href });
        return void res.end();
      }
      if (!login) {
        back.searchParams.set('error', 'access_denied');
        res.writeHead(302, { location: back.href });
        return void res.end();
      }
      logins.delete(issuerId);
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        issuerId,
        clientId: client.clientId,
        redirectUri,
        challenge: p.get('code_challenge') as string,
        nonce: p.get('nonce') as string,
        login,
      });
      back.searchParams.set('code', code);
      res.writeHead(302, { location: back.href });
      return void res.end();
    }

    if (endpoint === 'token' && req.method === 'POST') {
      const form = await readForm(req);
      const client = clients.get(issuerId);
      let id = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (basic) {
        const [u = '', ...s] = Buffer.from(basic, 'base64').toString('utf8').split(':');
        id = decodeURIComponent(u);
        secret = decodeURIComponent(s.join(':'));
      }
      if (!client || id !== client.clientId || secret !== client.clientSecret) return json(res, 401, { error: 'invalid_client' });
      const issued = codes.get(form.get('code') ?? '');
      if (form.get('grant_type') !== 'authorization_code' || !issued || issued.issuerId !== issuerId) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      codes.delete(form.get('code') as string);
      if (form.get('redirect_uri') !== issued.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return json(res, 200, {
        access_token: randomBytes(16).toString('hex'),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
        ...(issued.login.options.omitIdToken ? {} : { id_token: await signIdToken(issuer, issued) }),
      });
    }

    json(res, 404, { error: 'not_found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => json(res, 500, { error: 'server_error', error_description: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    issuer: issuerUrl,
    addClient: (issuerId, client) => void clients.set(issuerId, client),
    nextLogin: (issuerId, claims, loginOptions = {}) => void logins.set(issuerId, { claims, options: loginOptions }),
    failDiscovery: (issuerId, fail = true) => void (fail ? failing.add(issuerId) : failing.delete(issuerId)),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
