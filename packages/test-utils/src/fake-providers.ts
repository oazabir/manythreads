import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultAccount, type FakeAccountData, type FakeFile } from './fake-providers-data.ts';

export type { FakeAccountData, FakeCategory, FakeEvent, FakeFile, FakeLabel, FakeMail, FakeNotionPage } from './fake-providers-data.ts';
export { defaultAccount } from './fake-providers-data.ts';

// A local double of Google, Microsoft 365 and Notion, for the connections plugin's tests and for the e2e fixtures (PLAN P8-02 and P8-12). One small HTTP server stands
// for all three: the paths do not collide, so one address serves as the base of every provider (`env()` gives the variables that point the plugin at it).
//
//   * The sign-in is real OAuth as far as the plugin can see: the consent address answers at once with a redirect carrying a one-time code and the state the caller sent
//     (the person "says yes"); the token address checks the app's id and secret (in the body or as Basic credentials, as each provider wants), the redirect address, and
//     for Google and Microsoft the PKCE proof (S256 of the verifier must equal the challenge sent at the start). A code works once. A refresh token renews the access
//     token; Microsoft and Notion style rotation (a new refresh token each time, the old one dead) is on by default for Microsoft.
//   * The APIs answer the tools' calls from per-account data (fake-providers-data.ts), and only for an access token it issued and has not been told to expire.
//   * It never records a token, a code, a verifier or a client secret: `calls` holds the method, the path and whether the call was authorized; `tokenCalls` holds the
//     grant, whether the PKCE proof held and how the app proved itself. Writes a tool makes (`drafts`, `sentMails`, `labelChanges`, `createdEvents`, `updatedEvents`, `createdPages`) are kept as plain data.

export type FakeProviderId = 'google' | 'microsoft' | 'notion';

export interface FakeApiCall {
  provider: FakeProviderId;
  method: string;
  /** The path only; the query is left out. */
  path: string;
  authorized: boolean;
}

export interface FakeTokenCall {
  provider: FakeProviderId;
  grant: string;
  ok: boolean;
  /** The provider's short error code when it refused. */
  error: string | null;
  /** The PKCE proof matched the challenge of the start; null when the provider has none (Notion) or the grant is not a code exchange. */
  pkce: boolean | null;
  clientAuth: 'body' | 'basic' | 'none';
}

export interface FakeProviders {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** The app credentials every provider here accepts. */
  clientId: string;
  clientSecret: string;
  /** The variables that make the connections plugin use this server: the app ids and secrets, and the fake base of each provider. */
  env(): Record<string, string>;
  apiCalls: FakeApiCall[];
  tokenCalls: FakeTokenCall[];
  /** Every consent address that was opened, as the scopes asked for (no state or challenge). */
  consents: Array<{ provider: FakeProviderId; scopes: string[]; offline: boolean; hasChallenge: boolean }>;
  /** Every revoke call: which provider, and what kind of token it named (`unknown`: one this server did not issue). Never the token itself. */
  revoked: Array<{ provider: FakeProviderId; kind: 'refresh' | 'access' | 'unknown' }>;
  drafts: Array<{ provider: FakeProviderId; account: string; to: string[]; subject: string; body: string }>;
  /** Messages Gmail was asked to send (the MIME is parsed back into plain fields). */
  sentMails: Array<{ account: string; to: string[]; cc: string[]; subject: string; body: string; threadId: string | null; inReplyTo: string | null }>;
  /** Every Gmail label change that was asked for: the message and the label ids added and removed. */
  labelChanges: Array<{ account: string; messageId: string; add: string[]; remove: string[] }>;
  createdEvents: Array<{ provider: FakeProviderId; account: string; title: string; start: string; end: string; guests: string[] }>;
  /** Every change to a Google Calendar event, as the fields that were sent. */
  updatedEvents: Array<{ account: string; eventId: string; fields: Record<string, unknown> }>;
  createdPages: Array<{ account: string; parent: string; title: string }>;
  /** Messages Outlook was asked to send (P16-04): straight through `sendMail`, or as a reply draft that was sent (`viaReply`, with the id of the message it answers). */
  outlookSent: Array<{ account: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; subject: string; body: string; viaReply: boolean; inReplyTo: string | null }>;
  /** Every change of the categories of an Outlook message: the message and the whole list after the change. */
  categoryChanges: Array<{ account: string; messageId: string; categories: string[] }>;
  /** Every change to an Outlook calendar event, as the fields that were sent. */
  outlookEventUpdates: Array<{ account: string; eventId: string; fields: Record<string, unknown> }>;
  /** Every free/busy question put to Outlook: the addresses asked about. */
  scheduleRequests: Array<{ account: string; schedules: string[] }>;
  /** The data of one account; replace or edit it to change what the APIs answer. */
  account(email: string): FakeAccountData;
  /** The account the next consent signs in as (the "person at the provider"). */
  signInAs(email: string): void;
  /** The next consent is refused by the person (the redirect carries `error=access_denied`). */
  denyNextConsent(): void;
  /** Every access token issued so far stops working (the API answers 401) while refresh tokens still work. */
  expireAccessTokens(): void;
  /** Every refresh token issued so far is refused with `invalid_grant` (the person took the access away). */
  revokeRefreshTokens(): void;
  /** Access tokens live this long, in seconds (default 3600). Under the plugin's 60 s skew a token is renewed before every use. */
  setAccessTtl(seconds: number): void;
  /** Whether a refresh gives a new refresh token and kills the old one (Microsoft's default is true, Google's false). */
  setRotation(provider: FakeProviderId, rotate: boolean): void;
  /** The next `count` API calls answer `status` before anything else. */
  failNextApi(status: number, count?: number): void;
  /** The next `count` token calls answer `status`. */
  failNextToken(status: number, count?: number): void;
  stop(): Promise<void>;
}

export interface FakeProvidersOptions {
  clientId?: string;
  clientSecret?: string;
  /** Accounts by address; the first one is the account consents sign in as until `signInAs`. Default: one account with the default data. */
  accounts?: FakeAccountData[];
}

interface IssuedCode {
  provider: FakeProviderId;
  account: string;
  redirectUri: string;
  challenge: string | null;
  scopes: string[];
  offline: boolean;
  clientId: string;
}

interface Issued {
  provider: FakeProviderId;
  account: string;
  scopes: string[];
}

const sha256url = (value: string): string => createHash('sha256').update(value).digest('base64url');
const fresh = (prefix: string): string => `${prefix}-${randomBytes(18).toString('base64url')}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const matches = (haystack: string, words: string): boolean => haystack.toLowerCase().includes(words.toLowerCase());

export async function startFakeProviders(options: FakeProvidersOptions = {}): Promise<FakeProviders> {
  const clientId = options.clientId ?? 'fake-client-id';
  const clientSecret = options.clientSecret ?? 'fake-client-secret';
  const accounts = new Map<string, FakeAccountData>((options.accounts ?? [defaultAccount()]).map((a) => [a.email, a]));
  let signedInAs = [...accounts.keys()][0]!;
  let denyNext = false;
  let accessTtl = 3600;
  const rotation: Record<FakeProviderId, boolean> = { google: false, microsoft: true, notion: false };
  let apiFailure: { status: number; left: number } | null = null;
  let tokenFailure: { status: number; left: number } | null = null;

  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, Issued & { expired: boolean }>();
  const refreshTokens = new Map<string, Issued & { dead: boolean }>();
  /** What each account already agreed to at each provider, for Google's `include_granted_scopes`. */
  const granted = new Map<string, Set<string>>();

  const apiCalls: FakeApiCall[] = [];
  const tokenCalls: FakeTokenCall[] = [];
  const consents: FakeProviders['consents'] = [];
  const revoked: FakeProviders['revoked'] = [];
  const drafts: FakeProviders['drafts'] = [];
  const createdEvents: FakeProviders['createdEvents'] = [];
  const sentMails: FakeProviders['sentMails'] = [];
  const labelChanges: FakeProviders['labelChanges'] = [];
  const updatedEvents: FakeProviders['updatedEvents'] = [];
  const createdPages: FakeProviders['createdPages'] = [];
  const outlookSent: FakeProviders['outlookSent'] = [];
  const categoryChanges: FakeProviders['categoryChanges'] = [];
  const outlookEventUpdates: FakeProviders['outlookEventUpdates'] = [];
  const scheduleRequests: FakeProviders['scheduleRequests'] = [];
  /** Reply drafts Outlook made (`createReply`) and not yet sent, by id. */
  const replyDrafts = new Map<string, { account: string; original: string; fields: Record<string, unknown> }>();
  let nextId = 1;

  const providerOfPath = (path: string): FakeProviderId | null => {
    if (path.startsWith('/v1.0/') || path.startsWith('/oauth2/v2.0/')) return 'microsoft';
    if (path.startsWith('/v1/')) return 'notion';
    if (path === '/token' || path === '/revoke' || path.startsWith('/o/oauth2/') || path.startsWith('/oauth2/v3/') || /^\/(drive|gmail|calendar)\//.test(path)) return 'google';
    return null;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const provider = providerOfPath(path);
    const send = (status: number, doc: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(doc));
    };
    const text = (status: number, value: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(value);
    };
    if (!provider) return send(404, { error: 'not_found' });

    // ---- the consent address: the person says yes at once ----
    if (method === 'GET' && /^\/(o\/oauth2\/v2\/auth|oauth2\/v2\.0\/authorize|v1\/oauth\/authorize)$/.test(path)) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== clientId || !redirectUri || q.get('response_type') !== 'code') return send(400, { error: 'invalid_request' });
      const state = q.get('state') ?? '';
      const target = new URL(redirectUri);
      if (denyNext) {
        denyNext = false;
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('state', state);
        res.writeHead(302, { location: target.toString() });
        return void res.end();
      }
      const scopes = (q.get('scope') ?? '').split(' ').filter((s) => s !== '');
      const key = `${provider}:${signedInAs}`;
      // Google adds what was agreed before when asked to (`include_granted_scopes`); Microsoft always does, as a token carries every permission the person gave the app
      const union = new Set(q.get('include_granted_scopes') === 'true' || provider === 'microsoft' ? (granted.get(key) ?? []) : []);
      for (const s of scopes) union.add(s);
      granted.set(key, union);
      const offline = provider === 'google' ? q.get('access_type') === 'offline' : provider === 'microsoft' ? scopes.includes('offline_access') : false;
      consents.push({ provider, scopes, offline, hasChallenge: q.has('code_challenge') });
      const code = fresh('code');
      codes.set(code, {
        provider,
        account: signedInAs,
        redirectUri,
        challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null,
        scopes: [...union],
        offline,
        clientId,
      });
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    // ---- the token address ----
    if (method === 'POST' && /^\/(token|oauth2\/v2\.0\/token|v1\/oauth\/token)$/.test(path)) {
      const json = (req.headers['content-type'] ?? '').includes('json');
      const fields: Record<string, string> = json ? (JSON.parse(body || '{}') as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
      const grant = fields['grant_type'] ?? '';
      const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
      const [basicId, basicSecret] = basic ? Buffer.from(basic[1]!, 'base64').toString('utf8').split(':') : [];
      const clientAuth: FakeTokenCall['clientAuth'] = basic ? 'basic' : fields['client_id'] ? 'body' : 'none';
      const idGiven = basic ? basicId : fields['client_id'];
      const secretGiven = basic ? basicSecret : fields['client_secret'];
      const record = (ok: boolean, error: string | null, pkce: boolean | null): void => void tokenCalls.push({ provider, grant, ok, error, pkce, clientAuth });
      const refuse = (status: number, error: string, pkce: boolean | null = null): void => {
        record(false, error, pkce);
        send(status, { error });
      };
      if (tokenFailure && tokenFailure.left > 0) {
        tokenFailure.left--;
        record(false, 'forced', null);
        return send(tokenFailure.status, { error: 'temporarily_unavailable' });
      }
      if (idGiven !== clientId || secretGiven !== clientSecret) return refuse(401, 'invalid_client');
      // Notion wants Basic and a JSON body; Google and Microsoft want the credentials in the form
      if ((provider === 'notion') !== (clientAuth === 'basic')) return refuse(400, 'invalid_client');

      if (grant === 'authorization_code') {
        const issued = codes.get(fields['code'] ?? '');
        codes.delete(fields['code'] ?? '');
        if (!issued || issued.provider !== provider || issued.clientId !== clientId) return refuse(400, 'invalid_grant');
        if (issued.redirectUri !== fields['redirect_uri']) return refuse(400, 'invalid_grant');
        let pkce: boolean | null = null;
        if (provider !== 'notion') {
          pkce = issued.challenge !== null && typeof fields['code_verifier'] === 'string' && sha256url(fields['code_verifier']) === issued.challenge;
          if (!pkce) return refuse(400, 'invalid_grant', pkce);
        }
        const out: Record<string, unknown> = { token_type: 'Bearer' };
        const access = fresh('access');
        accessTokens.set(access, { provider, account: issued.account, scopes: issued.scopes, expired: false });
        out['access_token'] = access;
        if (provider !== 'notion') {
          out['expires_in'] = accessTtl;
          out['scope'] = issued.scopes.join(' ');
        } else {
          out['workspace_name'] = `${issued.account.split('@')[0]}'s workspace`;
        }
        if (provider !== 'notion' && issued.offline) {
          const refresh = fresh('refresh');
          refreshTokens.set(refresh, { provider, account: issued.account, scopes: issued.scopes, dead: false });
          out['refresh_token'] = refresh;
        }
        record(true, null, pkce);
        return send(200, out);
      }

      if (grant === 'refresh_token') {
        const old = refreshTokens.get(fields['refresh_token'] ?? '');
        if (!old || old.dead || old.provider !== provider) return refuse(400, 'invalid_grant');
        const access = fresh('access');
        accessTokens.set(access, { provider, account: old.account, scopes: old.scopes, expired: false });
        const out: Record<string, unknown> = { token_type: 'Bearer', access_token: access, expires_in: accessTtl, scope: old.scopes.join(' ') };
        if (rotation[provider]) {
          old.dead = true;
          const next = fresh('refresh');
          refreshTokens.set(next, { provider, account: old.account, scopes: old.scopes, dead: false });
          out['refresh_token'] = next;
        }
        record(true, null, null);
        return send(200, out);
      }
      return refuse(400, 'unsupported_grant_type');
    }

    // ---- revoke ----
    if (method === 'POST' && (path === '/revoke' || path === '/v1/oauth/revoke')) {
      const fields: Record<string, string> = (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(body || '{}') as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
      const token = fields['token'] ?? '';
      const refresh = refreshTokens.get(token);
      if (refresh) refresh.dead = true;
      const access = accessTokens.get(token);
      if (access) access.expired = true;
      revoked.push({ provider, kind: refresh ? 'refresh' : access ? 'access' : 'unknown' });
      return send(200, {});
    }

    // ---- the APIs: only for an access token this server issued ----
    const given = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const token = given ? accessTokens.get(given) : undefined;
    const authorized = !!token && !token.expired && token.provider === provider;
    apiCalls.push({ provider, method, path, authorized });
    if (apiFailure && apiFailure.left > 0) {
      apiFailure.left--;
      return send(apiFailure.status, { error: 'forced failure' });
    }
    if (!authorized || !token) return send(401, { error: 'invalid_token' });
    const data = accounts.get(token.account);
    if (!data) return send(404, { error: 'no such account' });
    const need = (scope: string): boolean => {
      if (token.scopes.some((s) => s === scope || s.endsWith(`/${scope}`))) return true;
      send(403, { error: 'insufficient_scope' });
      return false;
    };
    const q = url.searchParams;

    if (provider === 'google') {
      if (path === '/oauth2/v3/userinfo') return send(200, { email: data.email, sub: data.email });
      if (method === 'GET' && path === '/drive/v3/files') {
        if (!need('drive.readonly')) return;
        const words = /fullText contains '((?:[^'\\]|\\.)*)'/.exec(q.get('q') ?? '')?.[1]?.replaceAll("\\'", "'").replaceAll('\\\\', '\\') ?? '';
        const files = data.files.filter((f) => matches(f.name, words) || matches(f.text, words));
        return send(200, { files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modified, webViewLink: `https://drive.example/${f.id}` })) });
      }
      const file = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
      if (method === 'GET' && file) {
        if (!need('drive.readonly')) return;
        const f = data.files.find((x) => x.id === decodeURIComponent(file[1]!));
        if (!f) return send(404, { error: 'not_found' });
        if (file[2] || q.get('alt') === 'media') return text(200, f.text);
        return send(200, { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modified, webViewLink: `https://drive.example/${f.id}` });
      }
      // Gmail reads work with the read-only scope or the wider modify scope, as at Google
      const needMailRead = (): boolean => {
        if (token.scopes.some((s) => s.endsWith('/gmail.readonly') || s.endsWith('/gmail.modify'))) return true;
        send(403, { error: 'insufficient_scope' });
        return false;
      };
      const labelsOf = (m: FakeAccountData['mails'][number]): string[] => m.labels ?? ['INBOX'];
      if (method === 'GET' && path === '/gmail/v1/users/me/labels') {
        if (!needMailRead()) return;
        const builtIn = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'SENT', 'DRAFT'].map((id) => ({ id, name: id, type: 'system' }));
        return send(200, { labels: [...builtIn, ...(data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: 'user' }))] });
      }
      if (method === 'GET' && path === '/gmail/v1/users/me/messages') {
        if (!needMailRead()) return;
        const words = q.get('q') ?? '';
        const wanted = q.getAll('labelIds');
        const max = Number(q.get('maxResults') ?? 100);
        const found = data.mails.filter((m) => matches(`${m.subject} ${m.from} ${m.text}`, words) && wanted.every((l) => labelsOf(m).includes(l))).slice(0, max);
        return send(200, { messages: found.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })) });
      }
      const mail = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
      if (method === 'GET' && mail) {
        if (!needMailRead()) return;
        const m = data.mails.find((x) => x.id === decodeURIComponent(mail[1]!));
        if (!m) return send(404, { error: 'not_found' });
        const headers = [
          { name: 'From', value: m.from },
          { name: 'To', value: m.to },
          { name: 'Subject', value: m.subject },
          { name: 'Date', value: m.date },
          { name: 'Message-ID', value: `<${m.id}@mail.example>` },
        ];
        // as at Google, a metadata read answers only the headers that were asked for
        const wantedHeaders = q.getAll('metadataHeaders').map((h) => h.toLowerCase());
        const shown = q.get('format') === 'metadata' && wantedHeaders.length > 0 ? headers.filter((h) => wantedHeaders.includes(h.name.toLowerCase())) : headers;
        return send(200, {
          id: m.id,
          threadId: m.threadId ?? m.id,
          labelIds: labelsOf(m),
          snippet: m.text.slice(0, 120),
          payload: q.get('format') === 'full' ? { mimeType: 'text/plain', headers, body: { data: Buffer.from(m.text, 'utf8').toString('base64url') } } : { headers: shown },
        });
      }
      const modify = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(path);
      if (method === 'POST' && modify) {
        if (!need('gmail.modify')) return;
        const m = data.mails.find((x) => x.id === decodeURIComponent(modify[1]!));
        if (!m) return send(404, { error: 'not_found' });
        const b = JSON.parse(body || '{}') as { addLabelIds?: string[]; removeLabelIds?: string[] };
        const add = b.addLabelIds ?? [];
        const remove = b.removeLabelIds ?? [];
        m.labels = [...new Set([...labelsOf(m).filter((l) => !remove.includes(l)), ...add])];
        labelChanges.push({ account: data.email, messageId: m.id, add, remove });
        return send(200, { id: m.id, threadId: m.threadId ?? m.id, labelIds: m.labels });
      }
      if (method === 'POST' && path === '/gmail/v1/users/me/messages/send') {
        if (!need('gmail.send')) return;
        const b = JSON.parse(body || '{}') as { raw?: string; threadId?: string };
        const mime = Buffer.from(b.raw ?? '', 'base64url').toString('utf8');
        const list = (name: string): string[] => new RegExp(`^${name}: (.*)$`, 'm').exec(mime)?.[1]?.split(',').map((x) => x.trim()) ?? [];
        const encoded = /^Subject: =\?UTF-8\?B\?(.*)\?=\s*$/m.exec(mime)?.[1] ?? '';
        const content = mime.split('\r\n\r\n')[1] ?? '';
        const id = `sent-${nextId++}`;
        sentMails.push({
          account: data.email,
          to: list('To'),
          cc: list('Cc'),
          subject: Buffer.from(encoded, 'base64').toString('utf8'),
          body: Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8'),
          threadId: b.threadId ?? null,
          inReplyTo: /^In-Reply-To: (.*)$/m.exec(mime)?.[1]?.trim() ?? null,
        });
        return send(200, { id, threadId: b.threadId ?? id, labelIds: ['SENT'] });
      }
      if (method === 'POST' && path === '/gmail/v1/users/me/drafts') {
        if (!need('gmail.compose')) return;
        const raw = (JSON.parse(body || '{}') as { message?: { raw?: string } }).message?.raw ?? '';
        const mime = Buffer.from(raw, 'base64url').toString('utf8');
        const to = /^To: (.*)$/m.exec(mime)?.[1]?.split(',').map((s) => s.trim()) ?? [];
        const encoded = /^Subject: =\?UTF-8\?B\?(.*)\?=\s*$/m.exec(mime)?.[1] ?? '';
        const content = mime.split('\r\n\r\n')[1] ?? '';
        drafts.push({ provider, account: data.email, to, subject: Buffer.from(encoded, 'base64').toString('utf8'), body: Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8') });
        return send(200, { id: `draft-${nextId++}` });
      }
      if (method === 'POST' && path === '/calendar/v3/freeBusy') {
        if (!token.scopes.some((sc) => sc.endsWith('/calendar.freebusy') || sc.endsWith('/calendar.readonly'))) {
          send(403, { error: 'insufficient_scope' });
          return;
        }
        const b = JSON.parse(body || '{}') as { timeMin: string; timeMax: string; items?: Array<{ id: string }> };
        const calendars: Record<string, unknown> = {};
        for (const { id } of b.items ?? []) {
          // 'primary' is the signed-in account; another address answers only when the fake knows the account (its calendar is "shared"); the rest is "not found", as at Google
          const owner = id === 'primary' ? data : accounts.get(id);
          calendars[id] = owner
            ? { busy: owner.events.filter((e) => e.end > b.timeMin && e.start < b.timeMax).map((e) => ({ start: e.start, end: e.end })) }
            : { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] };
        }
        return send(200, { kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars });
      }
      const patched = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && patched) {
        if (!need('calendar.events')) return;
        const e = data.events.find((x) => x.id === decodeURIComponent(patched[1]!));
        if (!e) return send(404, { error: 'not_found' });
        const b = JSON.parse(body || '{}') as { summary?: string; start?: { dateTime: string }; end?: { dateTime: string }; attendees?: Array<{ email: string }>; description?: string };
        if (b.summary !== undefined) e.title = b.summary;
        if (b.start) e.start = b.start.dateTime;
        if (b.end) e.end = b.end.dateTime;
        if (b.attendees) e.guests = b.attendees.map((a) => a.email);
        updatedEvents.push({ account: data.email, eventId: e.id, fields: b as Record<string, unknown> });
        return send(200, { id: e.id, htmlLink: `https://calendar.example/${e.id}` });
      }
      if (path === '/calendar/v3/calendars/primary/events') {
        if (method === 'GET') {
          if (!need('calendar.events.readonly')) return;
          const from = q.get('timeMin') ?? '0000';
          const to = q.get('timeMax') ?? '9999';
          const items = data.events.filter((e) => e.end > from && e.start < to).sort((a, b) => a.start.localeCompare(b.start));
          return send(200, {
            items: items.map((e) => ({
              id: e.id,
              summary: e.title,
              start: { dateTime: e.start },
              end: { dateTime: e.end },
              location: e.location,
              attendees: (e.guests ?? []).map((email) => ({ email })),
              htmlLink: `https://calendar.example/${e.id}`,
            })),
          });
        }
        if (method === 'POST') {
          if (!need('calendar.events')) return;
          const b = JSON.parse(body || '{}') as { summary: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ email: string }> };
          createdEvents.push({ provider, account: data.email, title: b.summary, start: b.start.dateTime, end: b.end.dateTime, guests: (b.attendees ?? []).map((a) => a.email) });
          const id = `event-new-${nextId++}`;
          return send(200, { id, htmlLink: `https://calendar.example/${id}` });
        }
      }
    }

    if (provider === 'microsoft') {
      const p = path.slice('/v1.0'.length);
      if (p === '/me') return send(200, { mail: data.email, userPrincipalName: data.email });
      const search = /^\/me\/drive\/root\/search\(q='((?:[^']|'')*)'\)$/.exec(decodeURIComponent(p));
      if (method === 'GET' && search) {
        if (!need('Files.Read')) return;
        const words = search[1]!.replaceAll("''", "'");
        return send(200, {
          value: data.files
            .filter((f) => matches(f.name, words) || matches(f.text, words))
            .map((f) => ({ id: f.id, name: f.name, file: { mimeType: f.mimeType.startsWith('application/vnd.google') ? 'text/plain' : f.mimeType }, lastModifiedDateTime: f.modified, webUrl: `https://onedrive.example/${f.id}` })),
        });
      }
      const item = /^\/me\/drive\/items\/([^/]+)(\/content)?$/.exec(p);
      if (method === 'GET' && item) {
        if (!need('Files.Read')) return;
        const f = data.files.find((x) => x.id === decodeURIComponent(item[1]!));
        if (!f) return send(404, { error: 'not_found' });
        if (item[2]) return text(200, f.text);
        return send(200, { id: f.id, name: f.name, file: { mimeType: f.mimeType.startsWith('application/vnd.google') ? 'text/plain' : f.mimeType }, lastModifiedDateTime: f.modified, webUrl: `https://onedrive.example/${f.id}` });
      }
      const sendDriveItem = (f: FakeFile, tail: string | undefined, sheetId: string | undefined, lastCol: string | undefined, lastRow: string | undefined): void => {
        if (!tail) return send(200, { id: f.id, name: f.name, size: f.text.length, file: { mimeType: f.mimeType }, lastModifiedDateTime: f.modified, webUrl: `https://sharepoint.example/${f.id}` });
        if (tail === '/content') return text(200, f.text);
        // a workbook: one sheet, whose cells are the CSV text of the file, on a grid of the size asked for
        if (!sheetId) return send(200, { value: [{ id: '{00000000-0001-0000-0000-000000000000}', name: 'Sheet1' }] });
        const rows = f.text.split('\n').filter((l) => l !== '').map((l) => l.split(',').map((c) => (c !== '' && !Number.isNaN(Number(c)) ? Number(c) : c)));
        const cols = (lastCol ?? 'A').charCodeAt(0) - 64;
        return send(200, { values: Array.from({ length: Number(lastRow ?? 1) }, (_, r) => Array.from({ length: cols }, (_, c) => rows[r]?.[c] ?? '')) });
      };
      // Outlook mail reads work with Mail.Read or the wider Mail.ReadWrite, as at Microsoft
      const needAny = (...scopes: string[]): boolean => {
        if (token.scopes.some((sc) => scopes.some((want) => sc === want || sc.endsWith(`/${want}`)))) return true;
        send(403, { error: 'insufficient_scope' });
        return false;
      };
      const msMail = (m: FakeAccountData['mails'][number]): Record<string, unknown> => ({
        id: m.id,
        subject: m.subject,
        from: { emailAddress: { address: m.from } },
        toRecipients: [{ emailAddress: { address: m.to } }],
        ccRecipients: [],
        receivedDateTime: m.date,
        bodyPreview: m.text.slice(0, 120),
        categories: m.categories ?? [],
        isRead: m.isRead ?? false,
        conversationId: m.threadId ?? m.id,
        parentFolderId: m.folder ?? 'inbox',
        body: { contentType: 'text', content: m.text },
      });
      const addrsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((r) => String(((r as { emailAddress?: { address?: string } }).emailAddress ?? {}).address ?? '')) : []);
      const folderMail = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p);
      if (method === 'GET' && (p === '/me/messages' || folderMail)) {
        if (!needAny('Mail.Read', 'Mail.ReadWrite')) return;
        const search = q.get('$search');
        const filter = q.get('$filter');
        // as at Microsoft: the two cannot be asked together
        if (search !== null && filter !== null) return send(400, { error: { code: 'ErrorInvalidRequest', message: '$filter cannot be combined with $search' } });
        const words = (search ?? '').replaceAll('"', '');
        let found = data.mails.filter((m) => matches(`${m.subject} ${m.from} ${m.text}`, words));
        if (folderMail) found = found.filter((m) => (m.folder ?? 'inbox') === decodeURIComponent(folderMail[1]!).toLowerCase());
        for (const clause of filter === null ? [] : filter.split(' and ')) {
          const date = /^receivedDateTime (gt|lt) (\S+)$/.exec(clause);
          const sender = /^from\/emailAddress\/address eq '((?:[^']|'')*)'$/.exec(clause);
          const subject = /^contains\(subject,'((?:[^']|'')*)'\)$/.exec(clause);
          const category = /^categories\/any\(c:c eq '((?:[^']|'')*)'\)$/.exec(clause);
          if (date) {
            const edge = Date.parse(date[2]!);
            found = found.filter((m) => (date[1] === 'gt' ? Date.parse(m.date) > edge : Date.parse(m.date) < edge));
          } else if (sender) {
            const who = sender[1]!.replaceAll("''", "'").toLowerCase();
            found = found.filter((m) => m.from.toLowerCase() === who);
          } else if (subject) {
            const part = subject[1]!.replaceAll("''", "'");
            found = found.filter((m) => matches(m.subject, part));
          } else if (category) {
            const cat = category[1]!.replaceAll("''", "'").toLowerCase();
            found = found.filter((m) => (m.categories ?? []).some((x) => x.toLowerCase() === cat));
          } else if (clause === 'isRead eq false') {
            found = found.filter((m) => !(m.isRead ?? false));
          } else return send(400, { error: { code: 'ErrorInvalidRequest', message: 'unsupported filter' } });
        }
        const top = Number(q.get('$top') ?? 10);
        return send(200, { value: found.slice(0, top).map(msMail).map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'body' && k !== 'toRecipients'))) });
      }
      if (method === 'GET' && p === '/me/mailFolders') {
        if (!needAny('Mail.Read', 'Mail.ReadWrite')) return;
        const folders: Array<[string, string]> = [
          ['inbox', 'Inbox'],
          ['sentitems', 'Sent Items'],
          ['drafts', 'Drafts'],
          ['archive', 'Archive'],
        ];
        return send(200, {
          value: folders.map(([id, displayName]) => {
            const inside = data.mails.filter((m) => (m.folder ?? 'inbox') === id);
            return { id, displayName, totalItemCount: inside.length, unreadItemCount: inside.filter((m) => !(m.isRead ?? false)).length };
          }),
        });
      }
      if (method === 'GET' && p === '/me/outlook/masterCategories') {
        if (!needAny('MailboxSettings.Read', 'MailboxSettings.ReadWrite')) return;
        const own = data.categories ?? [
          { name: 'Customer', color: 'preset0' },
          { name: 'Urgent', color: 'preset1' },
          { name: 'Offsite', color: 'preset4' },
        ];
        return send(200, { value: own.map((c, i) => ({ id: `cat-${i}`, displayName: c.name, color: c.color })) });
      }
      const mail = /^\/me\/messages\/([^/]+)$/.exec(p);
      if (method === 'GET' && mail) {
        if (!needAny('Mail.Read', 'Mail.ReadWrite')) return;
        const m = data.mails.find((x) => x.id === decodeURIComponent(mail[1]!));
        if (!m) return send(404, { error: 'not_found' });
        return send(200, msMail(m));
      }
      if (method === 'PATCH' && mail) {
        if (!need('Mail.ReadWrite')) return;
        const id = decodeURIComponent(mail[1]!);
        const b = JSON.parse(body || '{}') as Record<string, unknown>;
        const draft = replyDrafts.get(id);
        if (draft) {
          draft.fields = { ...draft.fields, ...b };
          return send(200, { id, isDraft: true });
        }
        const m = data.mails.find((x) => x.id === id);
        if (!m) return send(404, { error: 'not_found' });
        if (Array.isArray(b['categories'])) {
          m.categories = (b['categories'] as unknown[]).map(String);
          categoryChanges.push({ account: data.email, messageId: m.id, categories: m.categories });
        }
        return send(200, { id: m.id, categories: m.categories ?? [] });
      }
      const reply = /^\/me\/messages\/([^/]+)\/createReply$/.exec(p);
      if (method === 'POST' && reply) {
        if (!need('Mail.ReadWrite')) return;
        const original = data.mails.find((x) => x.id === decodeURIComponent(reply[1]!));
        if (!original) return send(404, { error: 'not_found' });
        const id = `reply-draft-${nextId++}`;
        // as at Microsoft, the draft starts out addressed to the sender of the original
        replyDrafts.set(id, {
          account: data.email,
          original: original.id,
          fields: { subject: `RE: ${original.subject}`, toRecipients: [{ emailAddress: { address: original.from } }], ccRecipients: [], bccRecipients: [], replyTo: [], body: { contentType: 'text', content: '' } },
        });
        return send(201, { id, isDraft: true });
      }
      const sendDraft = /^\/me\/messages\/([^/]+)\/send$/.exec(p);
      if (method === 'POST' && sendDraft) {
        if (!need('Mail.Send')) return;
        const draft = replyDrafts.get(decodeURIComponent(sendDraft[1]!));
        if (!draft) return send(404, { error: 'not_found' });
        replyDrafts.delete(decodeURIComponent(sendDraft[1]!));
        const f = draft.fields;
        outlookSent.push({
          account: data.email,
          to: addrsOf(f['toRecipients']),
          cc: addrsOf(f['ccRecipients']),
          bcc: addrsOf(f['bccRecipients']),
          replyTo: addrsOf(f['replyTo']),
          subject: String(f['subject'] ?? ''),
          body: String(((f['body'] ?? {}) as { content?: string }).content ?? ''),
          viaReply: true,
          inReplyTo: draft.original,
        });
        res.writeHead(202);
        return void res.end();
      }
      if (method === 'POST' && p === '/me/sendMail') {
        if (!need('Mail.Send')) return;
        const f = (JSON.parse(body || '{}') as { message?: Record<string, unknown> }).message ?? {};
        outlookSent.push({
          account: data.email,
          to: addrsOf(f['toRecipients']),
          cc: addrsOf(f['ccRecipients']),
          bcc: addrsOf(f['bccRecipients']),
          replyTo: addrsOf(f['replyTo']),
          subject: String(f['subject'] ?? ''),
          body: String(((f['body'] ?? {}) as { content?: string }).content ?? ''),
          viaReply: false,
          inReplyTo: null,
        });
        res.writeHead(202);
        return void res.end();
      }
      if (method === 'POST' && p === '/me/messages') {
        if (!need('Mail.ReadWrite')) return;
        const b = JSON.parse(body || '{}') as { subject: string; body: { content: string }; toRecipients: Array<{ emailAddress: { address: string } }> };
        drafts.push({ provider, account: data.email, to: b.toRecipients.map((r) => r.emailAddress.address), subject: b.subject, body: b.body.content });
        return send(201, { id: `draft-${nextId++}` });
      }
      if (method === 'GET' && p === '/me/calendarView') {
        if (!need('Calendars.Read')) return;
        const from = q.get('startDateTime') ?? '0000';
        const to = q.get('endDateTime') ?? '9999';
        const items = data.events.filter((e) => e.end > from && e.start < to).sort((a, b) => a.start.localeCompare(b.start));
        return send(200, {
          value: items.map((e) => ({ id: e.id, subject: e.title, start: { dateTime: e.start }, end: { dateTime: e.end }, location: { displayName: e.location ?? '' }, attendees: (e.guests ?? []).map((a) => ({ emailAddress: { address: a } })), webLink: `https://outlook.example/${e.id}` })),
        });
      }
      if (method === 'POST' && p === '/me/events') {
        if (!need('Calendars.ReadWrite')) return;
        const b = JSON.parse(body || '{}') as { subject: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ emailAddress: { address: string } }> };
        createdEvents.push({ provider, account: data.email, title: b.subject, start: b.start.dateTime, end: b.end.dateTime, guests: (b.attendees ?? []).map((a) => a.emailAddress.address) });
        const id = `event-new-${nextId++}`;
        return send(201, { id, webLink: `https://outlook.example/${id}` });
      }
      if (method === 'PATCH' && /^\/me\/events\/[^/]+$/.test(p)) {
        if (!need('Calendars.ReadWrite')) return;
        const e = data.events.find((x) => x.id === decodeURIComponent(p.split('/')[3]!));
        if (!e) return send(404, { error: 'not_found' });
        const b = JSON.parse(body || '{}') as { subject?: string; start?: { dateTime: string }; end?: { dateTime: string }; attendees?: Array<{ emailAddress: { address: string } }> };
        if (b.subject !== undefined) e.title = b.subject;
        // a time without an offset is UTC here, as the tools say so
        if (b.start) e.start = new Date(`${b.start.dateTime}Z`).toISOString();
        if (b.end) e.end = new Date(`${b.end.dateTime}Z`).toISOString();
        if (b.attendees) e.guests = b.attendees.map((a) => a.emailAddress.address);
        outlookEventUpdates.push({ account: data.email, eventId: e.id, fields: b as Record<string, unknown> });
        return send(200, { id: e.id, webLink: `https://outlook.example/${e.id}` });
      }
      if (method === 'POST' && p === '/me/calendar/getSchedule') {
        if (!needAny('Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite')) return;
        const b = JSON.parse(body || '{}') as { schedules?: string[]; startTime: { dateTime: string }; endTime: { dateTime: string } };
        const from = `${b.startTime.dateTime}Z`;
        const to = `${b.endTime.dateTime}Z`;
        scheduleRequests.push({ account: data.email, schedules: b.schedules ?? [] });
        // Microsoft writes a time as `2026-11-03T09:00:00.0000000` with the zone beside it, and may add the subject of an item
        const stamp = (iso: string): { dateTime: string; timeZone: string } => ({ dateTime: `${iso.slice(0, 19)}.0000000`, timeZone: 'UTC' });
        return send(200, {
          value: (b.schedules ?? []).map((id) => {
            const owner = id.toLowerCase() === data.email.toLowerCase() ? data : accounts.get(id);
            if (!owner) return { scheduleId: id, scheduleItems: [], error: { message: `There is no mailbox for ${id}: SECRET-MAILBOX-TEXT`, responseCode: 'ErrorMailRecipientNotFound' } };
            return {
              scheduleId: id,
              availabilityView: '',
              scheduleItems: [
                ...owner.events.filter((e) => e.end > from && e.start < to).map((e) => ({ status: 'busy', subject: e.title, location: e.location ?? '', start: stamp(e.start), end: stamp(e.end) })),
                // an item that is not busy time, so a reader has to leave it out
                { status: 'free', start: stamp(from), end: stamp(from) },
              ],
            };
          }),
        });
      }

      // ---- SharePoint: the search, and files by drive and item (the signed-in account's own OneDrive is the drive `drive-<address>`)
      if (method === 'POST' && p === '/search/query') {
        if (!needAny('Sites.Read.All', 'Files.Read.All')) return;
        const first = ((JSON.parse(body || '{}') as { requests?: Array<{ query?: { queryString?: string }; size?: number }> }).requests ?? [])[0] ?? {};
        const words = (first.query?.queryString ?? '').replaceAll('"', '');
        const own = data.files.map((f) => ({ f, drive: `drive-${data.email}` }));
        const site = (data.siteFiles ?? []).map((f) => ({ f, drive: 'b!site-docs' }));
        const hits = [...site, ...own]
          .filter(({ f }) => matches(f.name, words) || matches(f.text, words))
          .slice(0, first.size ?? 25)
          .map(({ f, drive }, i) => ({
            hitId: String(i + 1),
            rank: i + 1,
            summary: `<c0>${words}</c0> SECRET-SUMMARY`,
            resource: { '@odata.type': '#microsoft.graph.driveItem', id: f.id, name: f.name, webUrl: `https://sharepoint.example/${drive}/${f.id}`, lastModifiedDateTime: f.modified, parentReference: { driveId: drive } },
          }));
        return send(200, { value: [{ searchTerms: [words], hitsContainers: [{ hits, total: hits.length, moreResultsAvailable: false }] }] });
      }
      const driveItem = /^\/drives\/([^/]+)\/items\/([^/]+)(\/content|\/workbook\/worksheets(?:\/([^/]+)\/range\(address='([A-Z]+)(\d+):([A-Z]+)(\d+)'\))?)?$/.exec(decodeURIComponent(p));
      if (method === 'GET' && driveItem) {
        if (!needAny('Sites.Read.All', 'Files.Read.All', 'Files.Read')) return;
        const pool = driveItem[1] === `drive-${data.email}` ? data.files : driveItem[1] === 'b!site-docs' ? (data.siteFiles ?? []) : [];
        const f = pool.find((x) => x.id === driveItem[2]);
        if (!f) return send(404, { error: 'not_found' });
        return sendDriveItem(f, driveItem[3], driveItem[4], driveItem[7], driveItem[8]);
      }
      const ownWorkbook = /^\/me\/drive\/items\/([^/]+)(\/workbook\/worksheets(?:\/([^/]+)\/range\(address='([A-Z]+)(\d+):([A-Z]+)(\d+)'\))?)$/.exec(decodeURIComponent(p));
      if (method === 'GET' && ownWorkbook) {
        if (!needAny('Files.Read', 'Files.Read.All')) return;
        const f = data.files.find((x) => x.id === ownWorkbook[1]);
        if (!f) return send(404, { error: 'not_found' });
        return sendDriveItem(f, ownWorkbook[2], ownWorkbook[3], ownWorkbook[6], ownWorkbook[7]);
      }
    }

    if (provider === 'notion') {
      if (!req.headers['notion-version']) return send(400, { object: 'error', code: 'missing_version' });
      const p = path.slice('/v1'.length);
      const title = (t: string): unknown => ({ title: { type: 'title', title: [{ plain_text: t }] } });
      if (method === 'POST' && p === '/search') {
        const words = (JSON.parse(body || '{}') as { query?: string }).query ?? '';
        return send(200, {
          results: data.pages.filter((pg) => matches(pg.title, words)).map((pg) => ({ object: 'page', id: pg.id, url: `https://notion.example/${pg.id}`, last_edited_time: '2026-10-30T12:00:00.000Z', properties: title(pg.title) })),
        });
      }
      const page = /^\/pages\/([^/]+)$/.exec(p);
      if (method === 'GET' && page) {
        const pg = data.pages.find((x) => x.id === decodeURIComponent(page[1]!));
        if (!pg) return send(404, { object: 'error', code: 'object_not_found' });
        return send(200, { object: 'page', id: pg.id, url: `https://notion.example/${pg.id}`, properties: title(pg.title) });
      }
      const blocks = /^\/blocks\/([^/]+)\/children$/.exec(p);
      if (method === 'GET' && blocks) {
        const pg = data.pages.find((x) => x.id === decodeURIComponent(blocks[1]!));
        if (!pg) return send(404, { object: 'error', code: 'object_not_found' });
        return send(200, {
          results: pg.blocks.map((b) => {
            const [type, content] = b.startsWith('## ') ? ['heading_2', b.slice(3)] : b.startsWith('# ') ? ['heading_1', b.slice(2)] : b.startsWith('- ') ? ['bulleted_list_item', b.slice(2)] : ['paragraph', b];
            return { object: 'block', type, [type!]: { rich_text: [{ plain_text: content }] } };
          }),
        });
      }
      if (method === 'POST' && p === '/pages') {
        const b = JSON.parse(body || '{}') as { parent: { page_id: string }; properties: { title: { title: Array<{ text: { content: string } }> } } };
        createdPages.push({ account: data.email, parent: b.parent.page_id, title: b.properties.title.title[0]?.text.content ?? '' });
        const id = `page-new-${nextId++}`;
        return send(200, { object: 'page', id, url: `https://notion.example/${id}` });
      }
    }
    return send(404, { error: 'not_found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fake provider failure' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    clientId,
    clientSecret,
    env: () => {
      const out: Record<string, string> = {};
      for (const id of ['GOOGLE', 'MICROSOFT', 'NOTION']) {
        out[`MANYTHREADS_OAUTH_${id}_CLIENT_ID`] = clientId;
        out[`MANYTHREADS_OAUTH_${id}_CLIENT_SECRET`] = clientSecret;
        out[`MANYTHREADS_OAUTH_${id}_FAKE_BASE`] = url;
      }
      return out;
    },
    apiCalls,
    tokenCalls,
    consents,
    revoked,
    drafts,
    sentMails,
    labelChanges,
    createdEvents,
    updatedEvents,
    createdPages,
    outlookSent,
    categoryChanges,
    outlookEventUpdates,
    scheduleRequests,
    account(email) {
      let a = accounts.get(email);
      if (!a) {
        a = defaultAccount(email);
        accounts.set(email, a);
      }
      return a;
    },
    signInAs(email) {
      if (!accounts.has(email)) accounts.set(email, defaultAccount(email));
      signedInAs = email;
    },
    denyNextConsent() {
      denyNext = true;
    },
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.expired = true;
    },
    revokeRefreshTokens() {
      for (const t of refreshTokens.values()) t.dead = true;
    },
    setAccessTtl(seconds) {
      accessTtl = seconds;
    },
    setRotation(provider, rotate) {
      rotation[provider] = rotate;
    },
    failNextApi(status, count = 1) {
      apiFailure = { status, left: count };
    },
    failNextToken(status, count = 1) {
      tokenFailure = { status, left: count };
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
