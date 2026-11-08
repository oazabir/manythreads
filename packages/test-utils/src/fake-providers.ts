import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultAccount, FOLDER, type FakeAccountData, type FakeEvent, type FakeFile, type FakeNotionPage, type FakePermission } from './fake-providers-data.ts';

export type { FakeAccountData, FakeCategory, FakeEvent, FakeFile, FakeLabel, FakeMail, FakeNotionPage, FakePermission } from './fake-providers-data.ts';
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
  /** Events a calendar was asked to delete (Google) or cancel (Microsoft). */
  deletedEvents: Array<{ provider: FakeProviderId; account: string; eventId: string }>;
  /** The description and the location every created event was sent with. */
  createdEventDetails: Array<{ provider: FakeProviderId; account: string; eventId: string; description: string; location: string }>;
  /** The data of one account; replace or edit it to change what the APIs answer. */
  account(email: string): FakeAccountData;
  /** The addresses of the accounts it holds. */
  accountEmails(): string[];
  /** Adds or replaces a file of the account and puts it in the change feed (Drive `changes`, OneDrive `delta`). Its version counts up. */
  putFile(email: string, file: FakeFile): void;
  /** Puts a file in the bin (the feeds report it). */
  trashFile(email: string, fileId: string): void;
  /** Deletes a file for good (the feeds report it removed). */
  removeFile(email: string, fileId: string): void;
  /** Replaces who else can open a file and puts it in the change feed. */
  setFilePermissions(email: string, fileId: string, permissions: FakePermission[]): void;
  /** Adds or replaces a Notion page of the account; its last-edited time becomes now unless it carries one. */
  putPage(email: string, page: FakeNotionPage): void;
  /** Adds or replaces a calendar event of the account (what an organizer does at the provider). */
  putEvent(email: string, event: FakeEvent): void;
  /** Hands out a sign-in that exists before any consent (the seeds seal such tokens): both tokens are the ones given, never random. */
  seedGrant(grant: SeedGrantInput): void;
  /** Forgets every recorded call and write, every forced failure and every sign-in made since the start (seeded ones stay), and puts the accounts back as they were at the start. */
  reset(): void;
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

/** A sign-in made before the run, with tokens chosen by the caller (tools/fake-saas derives them from a seed key, so a seeded stack and the stand-in agree). */
export interface SeedGrantInput {
  provider: FakeProviderId;
  /** The account at the provider the grant belongs to. */
  email: string;
  scopes: string[];
  accessToken: string;
  /** Google and Microsoft only: a refresh token that works until the person takes the access away. */
  refreshToken?: string;
}

export interface FakeProvidersOptions {
  /** Where it listens (default 127.0.0.1 and a free port) and the host name it writes into its own address (default: `host`, or 127.0.0.1 for 0.0.0.0). Only tools/fake-saas sets them. */
  host?: string;
  port?: number;
  publicHost?: string;
  seedGrants?: SeedGrantInput[];
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
  const initialAccounts = structuredClone([...accounts.values()]);
  let signedInAs = [...accounts.keys()][0]!;
  const initialSignedInAs = signedInAs;
  let selfUrl = '';
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
  const seeded: SeedGrantInput[] = [...(options.seedGrants ?? [])];
  const applySeedGrant = (g: SeedGrantInput): void => {
    accessTokens.set(g.accessToken, { provider: g.provider, account: g.email, scopes: g.scopes, expired: false });
    if (g.refreshToken) refreshTokens.set(g.refreshToken, { provider: g.provider, account: g.email, scopes: g.scopes, dead: false });
    const key = `${g.provider}:${g.email}`;
    granted.set(key, new Set([...(granted.get(key) ?? []), ...g.scopes]));
  };
  seeded.forEach(applySeedGrant);

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
  /** Events a calendar was asked to delete (Google) or cancel (Microsoft): the provider, the account and the event. */
  const deletedEventCalls: FakeProviders['deletedEvents'] = [];
  const deletedEvents = new Set<string>();
  /** The text fields of every created event (the join link goes in the description and the location). */
  const createdEventDetails: FakeProviders['createdEventDetails'] = [];
  /** Reply drafts Outlook made (`createReply`) and not yet sent, by id. */
  const replyDrafts = new Map<string, { account: string; original: string; fields: Record<string, unknown> }>();
  let nextId = 1;
  /** The change feed of the files: one entry per change, numbered; a page token of the feeds is a number (changes after it). */
  const changes: Array<{ seq: number; account: string; fileId: string; removed: boolean; time: string }> = [];
  let changeSeq = 0;
  const logChange = (account: string, fileId: string, removed: boolean): void => void changes.push({ seq: ++changeSeq, account, fileId, removed, time: new Date().toISOString() });
  const accountOf = (email: string): FakeAccountData => {
    let a = accounts.get(email);
    if (!a) {
      a = defaultAccount(email);
      accounts.set(email, a);
    }
    return a;
  };
  const findFile = (email: string, fileId: string): { data: FakeAccountData; file: FakeFile } => {
    const data = accountOf(email);
    const file = data.files.find((f) => f.id === fileId);
    if (!file) throw new Error(`no file ${fileId} in the account ${email}`);
    return { data, file };
  };
  const fileVersion = (f: FakeFile): number => f.version ?? 1;

  const googleEvent = (e: FakeEvent, owner: string): Record<string, unknown> => ({
    id: e.id,
    status: e.status ?? 'confirmed',
    summary: e.title,
    ...(e.description !== undefined ? { description: e.description } : {}),
    start: { dateTime: e.start },
    end: { dateTime: e.end },
    location: e.location,
    organizer: { email: owner, self: true },
    attendees: (e.guests ?? []).map((email) => ({ email })),
    htmlLink: `https://calendar.example/${e.id}`,
    updated: new Date().toISOString(),
  });
  const msEvent = (e: FakeEvent): Record<string, unknown> => ({
    id: e.id,
    subject: e.title,
    isCancelled: e.status === 'cancelled',
    body: { contentType: 'text', content: e.description ?? '' },
    start: { dateTime: e.start, timeZone: 'UTC' },
    end: { dateTime: e.end, timeZone: 'UTC' },
    location: { displayName: e.location ?? '' },
    attendees: (e.guests ?? []).map((a) => ({ emailAddress: { address: a }, type: 'required' })),
    webLink: `https://outlook.example/${e.id}`,
  });
  const msDriveItem = (f: FakeFile, owner: string): Record<string, unknown> => ({
    id: f.id,
    name: f.name,
    lastModifiedDateTime: f.modified,
    webUrl: `https://onedrive.example/${f.id}`,
    size: Buffer.byteLength(f.text),
    eTag: `"${f.id}-${fileVersion(f)}"`,
    parentReference: { driveId: `drive-${owner}`, ...(f.parentId ? { id: f.parentId } : {}) },
    ...(f.mimeType === FOLDER ? { folder: { childCount: 0 } } : { file: { mimeType: f.mimeType.startsWith('application/vnd.google') ? 'text/plain' : f.mimeType } }),
  });
  const driveFile = (f: FakeFile): Record<string, unknown> => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modified,
    webViewLink: `https://drive.example/${f.id}`,
    trashed: f.trashed === true,
    version: String(fileVersion(f)),
    size: String(Buffer.byteLength(f.text)),
    ...(f.parentId ? { parents: [f.parentId] } : {}),
  });

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
        const query = q.get('q') ?? '';
        const words = /fullText contains '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replaceAll("\\'", "'").replaceAll('\\\\', '\\') ?? '';
        const parent = /'([^']+)' in parents/.exec(query)?.[1];
        const onlyMime = /mimeType = '([^']+)'/.exec(query)?.[1];
        const notMime = /mimeType != '([^']+)'/.exec(query)?.[1];
        const files = data.files.filter(
          (f) =>
            (matches(f.name, words) || matches(f.text, words)) &&
            (parent === undefined || (parent === 'root' ? f.parentId === undefined : f.parentId === parent)) &&
            (onlyMime === undefined || f.mimeType === onlyMime) &&
            (notMime === undefined || f.mimeType !== notMime) &&
            !(/trashed = false/.test(query) && f.trashed === true),
        );
        const size = Math.max(1, Math.min(1000, Number(q.get('pageSize') ?? 1000)));
        const from = Number(q.get('pageToken') ?? 0) || 0;
        const page = files.slice(from, from + size);
        return send(200, { files: page.map((f) => driveFile(f)), ...(from + size < files.length ? { nextPageToken: String(from + size) } : {}) });
      }
      if (method === 'GET' && path === '/drive/v3/changes/startPageToken') {
        if (!need('drive.readonly')) return;
        return send(200, { kind: 'drive#startPageToken', startPageToken: String(changeSeq) });
      }
      if (method === 'GET' && path === '/drive/v3/changes') {
        if (!need('drive.readonly')) return;
        const after = Number(q.get('pageToken'));
        if (!/^\d+$/.test(q.get('pageToken') ?? '') || after > changeSeq) return send(400, { error: { code: 400, message: 'Invalid value for: pageToken' } });
        const latest = new Map<string, (typeof changes)[number]>();
        for (const c of changes) if (c.seq > after && c.account === data.email) latest.set(c.fileId, c);
        const ordered = [...latest.values()].sort((a, b) => a.seq - b.seq);
        const size = Math.max(1, Math.min(1000, Number(q.get('pageSize') ?? 100)));
        const page = ordered.slice(0, size);
        const more = ordered.length > size;
        return send(200, {
          kind: 'drive#changeList',
          changes: page.map((c) => {
            const f = data.files.find((x) => x.id === c.fileId);
            return { kind: 'drive#change', changeType: 'file', fileId: c.fileId, removed: c.removed || !f, time: c.time, ...(c.removed || !f ? {} : { file: driveFile(f) }) };
          }),
          ...(more ? { nextPageToken: String(page[page.length - 1]!.seq) } : { newStartPageToken: String(changeSeq) }),
        });
      }
      const permissionsOf = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path);
      if (method === 'GET' && permissionsOf) {
        if (!need('drive.readonly')) return;
        const f = data.files.find((x) => x.id === decodeURIComponent(permissionsOf[1]!));
        if (!f) return send(404, { error: 'not_found' });
        return send(200, {
          kind: 'drive#permissionList',
          permissions: [
            { id: 'owner', type: 'user', role: 'owner', emailAddress: data.email },
            ...(f.permissions ?? []).map((p, i) =>
              p.type === 'anyone'
                ? { id: 'anyoneWithLink', type: 'anyone', role: 'reader', allowFileDiscovery: false }
                : p.type === 'domain'
                  ? { id: `domain-${i}`, type: 'domain', role: 'reader', domain: p.domain }
                  : { id: `${p.type}-${i}`, type: p.type, role: 'reader', emailAddress: p.email },
            ),
          ],
        });
      }
      const file = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
      if (method === 'GET' && file) {
        if (!need('drive.readonly')) return;
        const f = data.files.find((x) => x.id === decodeURIComponent(file[1]!));
        if (!f) return send(404, { error: 'not_found' });
        if (file[2] || q.get('alt') === 'media') return text(200, f.text);
        return send(200, driveFile(f));
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
          const own = id === 'primary' || id.toLowerCase() === data.email.toLowerCase();
          const found = own ? data : accounts.get(id);
          // a calendar its owner did not share answers like one that does not exist
          const owner = found && (own || found.shareCalendar !== false) ? found : undefined;
          calendars[id] = owner
            ? { busy: owner.events.filter((e) => e.status !== 'cancelled' && e.end > b.timeMin && e.start < b.timeMax).map((e) => ({ start: e.start, end: e.end })) }
            : { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] };
        }
        return send(200, { kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars });
      }
      const patched = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(path);
      if (method === 'GET' && patched) {
        if (!token.scopes.some((sc) => sc.endsWith('/calendar.events') || sc.endsWith('/calendar.events.readonly') || sc.endsWith('/calendar.readonly'))) return void send(403, { error: 'insufficient_scope' });
        const id = decodeURIComponent(patched[1]!);
        if (deletedEvents.has(`${data.email}:${id}`)) return send(410, { error: { code: 410, message: 'Resource has been deleted' } });
        const e = data.events.find((x) => x.id === id);
        if (!e) return send(404, { error: 'not_found' });
        return send(200, googleEvent(e, data.email));
      }
      if (method === 'DELETE' && patched) {
        if (!need('calendar.events')) return;
        const id = decodeURIComponent(patched[1]!);
        const at = data.events.findIndex((x) => x.id === id);
        if (at < 0) return send(deletedEvents.has(`${data.email}:${id}`) ? 410 : 404, { error: 'not_found' });
        data.events.splice(at, 1);
        deletedEvents.add(`${data.email}:${id}`);
        deletedEventCalls.push({ provider, account: data.email, eventId: id });
        res.writeHead(204);
        return void res.end();
      }
      if (method === 'PATCH' && patched) {
        if (!need('calendar.events')) return;
        const e = data.events.find((x) => x.id === decodeURIComponent(patched[1]!));
        if (!e) return send(404, { error: 'not_found' });
        const b = JSON.parse(body || '{}') as { summary?: string; start?: { dateTime: string }; end?: { dateTime: string }; attendees?: Array<{ email: string }>; description?: string; location?: string };
        if (b.summary !== undefined) e.title = b.summary;
        if (b.description !== undefined) e.description = b.description;
        if (b.location !== undefined) e.location = b.location;
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
          const items = data.events.filter((e) => e.status !== 'cancelled' && e.end > from && e.start < to).sort((a, b) => a.start.localeCompare(b.start));
          return send(200, { items: items.map((e) => googleEvent(e, data.email)) });
        }
        if (method === 'POST') {
          if (!need('calendar.events')) return;
          const b = JSON.parse(body || '{}') as { summary: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ email: string }>; description?: string; location?: string };
          const guests = (b.attendees ?? []).map((a) => a.email);
          createdEvents.push({ provider, account: data.email, title: b.summary, start: b.start.dateTime, end: b.end.dateTime, guests });
          const id = `event-new-${nextId++}`;
          // the event now exists at the provider: a later read, free/busy question or sync sees it (an organizer's own mailbox is not listed as a guest)
          const created: FakeEvent = { id, title: b.summary, start: b.start.dateTime, end: b.end.dateTime, guests, ...(b.description !== undefined ? { description: b.description } : {}), ...(b.location !== undefined ? { location: b.location } : {}) };
          data.events.push(created);
          createdEventDetails.push({ provider, account: data.email, eventId: id, description: b.description ?? '', location: b.location ?? '' });
          return send(200, googleEvent(created, data.email));
        }
      }
    }

    if (provider === 'microsoft') {
      const p = path.slice('/v1.0'.length);
      // Outlook mail reads work with Mail.Read or the wider Mail.ReadWrite, as at Microsoft
      const needAny = (...scopes: string[]): boolean => {
        if (token.scopes.some((sc) => scopes.some((want) => sc === want || sc.endsWith(`/${want}`)))) return true;
        send(403, { error: 'insufficient_scope' });
        return false;
      };
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
        return send(200, msDriveItem(f, data.email));
      }
      const itemPermissions = /^\/me\/drive\/items\/([^/]+)\/permissions$/.exec(p);
      if (method === 'GET' && itemPermissions) {
        if (!needAny('Files.Read', 'Files.Read.All')) return;
        const f = data.files.find((x) => x.id === decodeURIComponent(itemPermissions[1]!));
        if (!f) return send(404, { error: 'not_found' });
        const owner = { id: 'owner', roles: ['owner'], grantedToV2: { user: { email: data.email, displayName: data.email.split('@')[0] } } };
        const ownDomain = data.email.split('@')[1]!.toLowerCase();
        return send(200, {
          value: [
            owner,
            ...(f.permissions ?? []).flatMap((perm, i): Array<Record<string, unknown>> => {
              if (perm.type === 'anyone') return [{ id: `link-${i}`, roles: ['read'], link: { scope: 'anonymous', type: 'view' } }];
              // Graph does not name the tenant: an organization link is the owner's own, so a share to another domain has no counterpart here
              if (perm.type === 'domain') return perm.domain.toLowerCase() === ownDomain ? [{ id: `link-${i}`, roles: ['read'], link: { scope: 'organization', type: 'view' } }] : [];
              if (perm.type === 'user') return [{ id: `user-${i}`, roles: ['read'], grantedToV2: { user: { email: perm.email, displayName: perm.email.split('@')[0] } } }];
              return [{ id: `group-${i}`, roles: ['read'], grantedToV2: { group: { id: perm.email, displayName: perm.email.split('@')[0] } } }];
            }),
          ],
        });
      }
      const children = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(p);
      if (method === 'GET' && children) {
        if (!needAny('Files.Read', 'Files.Read.All')) return;
        const parent = children[1] === undefined ? undefined : decodeURIComponent(children[1]);
        const inside = data.files.filter((f) => f.trashed !== true && f.parentId === parent);
        const size = Math.max(1, Math.min(200, Number(q.get('$top') ?? 200)));
        const from = Number(q.get('$skiptoken') ?? 0) || 0;
        return send(200, {
          value: inside.slice(from, from + size).map((f) => msDriveItem(f, data.email)),
          ...(from + size < inside.length ? { '@odata.nextLink': `${selfUrl}/v1.0${p}?$top=${size}&$skiptoken=${from + size}` } : {}),
        });
      }
      if (method === 'GET' && p === '/me/drive/root/delta') {
        if (!needAny('Files.Read', 'Files.Read.All')) return;
        const tokenGiven = q.get('token');
        if (tokenGiven !== null && (!/^\d+$/.test(tokenGiven) || Number(tokenGiven) > changeSeq)) return send(410, { error: { code: 'resyncRequired', message: 'The delta token is not valid.' } });
        const size = Math.max(1, Math.min(200, Number(q.get('$top') ?? 200)));
        const skip = Number(q.get('$skiptoken') ?? 0) || 0;
        // the first round lists everything that is there; a later one lists what changed since the token, a removed or binned file as deleted
        const upto = Number(q.get('upto') ?? changeSeq);
        const since = q.get('since') ?? tokenGiven;
        const rows: Array<Record<string, unknown>> =
          since === null
            ? data.files.filter((f) => f.trashed !== true).map((f) => msDriveItem(f, data.email))
            : (() => {
                const latest = new Map<string, (typeof changes)[number]>();
                for (const c of changes) if (c.seq > Number(since) && c.seq <= upto && c.account === data.email) latest.set(c.fileId, c);
                return [...latest.values()]
                  .sort((a, b) => a.seq - b.seq)
                  .map((c) => {
                    const f = data.files.find((x) => x.id === c.fileId);
                    return !f || c.removed || f.trashed === true ? { id: c.fileId, deleted: { state: 'deleted' }, parentReference: { driveId: `drive-${data.email}` } } : msDriveItem(f, data.email);
                  });
              })();
        const keep = since === null ? '' : `&since=${since}`;
        const page = rows.slice(skip, skip + size);
        return send(200, {
          value: page,
          ...(skip + size < rows.length
            ? { '@odata.nextLink': `${selfUrl}/v1.0/me/drive/root/delta?$top=${size}&$skiptoken=${skip + size}&upto=${upto}${keep}` }
            : { '@odata.deltaLink': `${selfUrl}/v1.0/me/drive/root/delta?token=${upto}` }),
        });
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
        const items = data.events.filter((e) => e.status !== 'cancelled' && e.end > from && e.start < to).sort((a, b) => a.start.localeCompare(b.start));
        return send(200, {
          value: items.map((e) => ({ id: e.id, subject: e.title, start: { dateTime: e.start }, end: { dateTime: e.end }, location: { displayName: e.location ?? '' }, attendees: (e.guests ?? []).map((a) => ({ emailAddress: { address: a } })), webLink: `https://outlook.example/${e.id}` })),
        });
      }
      if (method === 'POST' && p === '/me/events') {
        if (!need('Calendars.ReadWrite')) return;
        const b = JSON.parse(body || '{}') as { subject: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ emailAddress: { address: string } }>; body?: { content?: string }; location?: { displayName?: string } };
        const guests = (b.attendees ?? []).map((a) => a.emailAddress.address);
        createdEvents.push({ provider, account: data.email, title: b.subject, start: b.start.dateTime, end: b.end.dateTime, guests });
        const id = `event-new-${nextId++}`;
        const zoned = (iso: string): string => (/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
        const created: FakeEvent = {
          id,
          title: b.subject,
          start: new Date(zoned(b.start.dateTime)).toISOString(),
          end: new Date(zoned(b.end.dateTime)).toISOString(),
          guests,
          description: b.body?.content ?? '',
          location: b.location?.displayName ?? '',
        };
        data.events.push(created);
        createdEventDetails.push({ provider, account: data.email, eventId: id, description: created.description ?? '', location: created.location ?? '' });
        return send(201, msEvent(created));
      }
      const msOne = /^\/me\/events\/([^/]+)(\/cancel)?$/.exec(p);
      if (msOne && (method === 'GET' || method === 'DELETE' || (method === 'POST' && msOne[2]))) {
        const id = decodeURIComponent(msOne[1]!);
        if (method === 'GET') {
          if (!needAny('Calendars.Read', 'Calendars.ReadWrite')) return;
          const e = data.events.find((x) => x.id === id);
          return e ? send(200, msEvent(e)) : send(404, { error: { code: 'ErrorItemNotFound' } });
        }
        if (!need('Calendars.ReadWrite')) return;
        const e = data.events.find((x) => x.id === id);
        if (!e) return send(404, { error: { code: 'ErrorItemNotFound' } });
        if (method === 'DELETE') data.events.splice(data.events.indexOf(e), 1);
        else e.status = 'cancelled';
        deletedEventCalls.push({ provider, account: data.email, eventId: id });
        res.writeHead(method === 'DELETE' ? 204 : 202);
        return void res.end();
      }
      if (method === 'PATCH' && /^\/me\/events\/[^/]+$/.test(p)) {
        if (!need('Calendars.ReadWrite')) return;
        const e = data.events.find((x) => x.id === decodeURIComponent(p.split('/')[3]!));
        if (!e) return send(404, { error: 'not_found' });
        const b = JSON.parse(body || '{}') as { subject?: string; start?: { dateTime: string }; end?: { dateTime: string }; attendees?: Array<{ emailAddress: { address: string } }>; body?: { content?: string }; location?: { displayName?: string } };
        if (b.subject !== undefined) e.title = b.subject;
        if (b.body?.content !== undefined) e.description = b.body.content;
        if (b.location?.displayName !== undefined) e.location = b.location.displayName;
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
            const own = id.toLowerCase() === data.email.toLowerCase();
            const owner = own ? data : accounts.get(id);
            if (!owner) return { scheduleId: id, scheduleItems: [], error: { message: `There is no mailbox for ${id}: SECRET-MAILBOX-TEXT`, responseCode: 'ErrorMailRecipientNotFound' } };
            if (!own && owner.shareCalendar === false) return { scheduleId: id, scheduleItems: [], error: { message: `No permission to read ${id}: SECRET-MAILBOX-TEXT`, responseCode: 'ErrorAccessDenied' } };
            return {
              scheduleId: id,
              availabilityView: '',
              scheduleItems: [
                ...owner.events.filter((e) => e.status !== 'cancelled' && e.end > from && e.start < to).map((e) => ({ status: 'busy', subject: e.title, location: e.location ?? '', start: stamp(e.start), end: stamp(e.end) })),
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
      const notionPage = (pg: FakeNotionPage): Record<string, unknown> => ({
        object: 'page',
        id: pg.id,
        url: `https://notion.example/${pg.id}`,
        last_edited_time: pg.lastEdited ?? '2026-10-30T12:00:00.000Z',
        archived: pg.archived === true,
        in_trash: pg.archived === true,
        public_url: pg.public === true ? `https://notion.example/public/${pg.id}` : null,
        properties: title(pg.title),
      });
      if (method === 'POST' && p === '/search') {
        const b = JSON.parse(body || '{}') as { query?: string; sort?: { direction?: string; timestamp?: string }; page_size?: number; start_cursor?: string };
        const words = b.query ?? '';
        const edited = (pg: FakeNotionPage): string => pg.lastEdited ?? '2026-10-30T12:00:00.000Z';
        const found = data.pages.filter((pg) => pg.archived !== true && matches(pg.title, words));
        if (b.sort?.timestamp === 'last_edited_time') found.sort((x, y) => (b.sort?.direction === 'ascending' ? 1 : -1) * edited(x).localeCompare(edited(y)));
        const size = Math.max(1, Math.min(100, b.page_size ?? 100));
        const from = Number(b.start_cursor ?? 0) || 0;
        return send(200, {
          object: 'list',
          results: found.slice(from, from + size).map((pg) => notionPage(pg)),
          has_more: from + size < found.length,
          next_cursor: from + size < found.length ? String(from + size) : null,
        });
      }
      const page = /^\/pages\/([^/]+)$/.exec(p);
      if (method === 'GET' && page) {
        const pg = data.pages.find((x) => x.id === decodeURIComponent(page[1]!));
        if (!pg) return send(404, { object: 'error', code: 'object_not_found' });
        return send(200, notionPage(pg));
      }
      const blocks = /^\/blocks\/([^/]+)\/children$/.exec(p);
      if (method === 'GET' && blocks) {
        const pg = data.pages.find((x) => x.id === decodeURIComponent(blocks[1]!));
        if (!pg) return send(404, { object: 'error', code: 'object_not_found' });
        const size = Math.max(1, Math.min(100, Number(q.get('page_size') ?? 100)));
        const from = Number(q.get('start_cursor') ?? 0) || 0;
        return send(200, {
          object: 'list',
          has_more: from + size < pg.blocks.length,
          next_cursor: from + size < pg.blocks.length ? String(from + size) : null,
          results: pg.blocks.slice(from, from + size).map((b) => {
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
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const listenHost = options.host ?? '127.0.0.1';
  const url = `http://${options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost)}:${(server.address() as AddressInfo).port}`;
  selfUrl = url;

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
    deletedEvents: deletedEventCalls,
    createdEventDetails,
    account: accountOf,
    accountEmails: () => [...accounts.keys()],
    putFile(email, file) {
      const data = accountOf(email);
      const at = data.files.findIndex((f) => f.id === file.id);
      const next: FakeFile = { ...file, version: (at >= 0 ? fileVersion(data.files[at]!) : 0) + 1 };
      if (at >= 0) data.files[at] = next;
      else data.files.push(next);
      logChange(data.email, file.id, false);
    },
    trashFile(email, fileId) {
      const { data, file } = findFile(email, fileId);
      file.trashed = true;
      file.version = fileVersion(file) + 1;
      logChange(data.email, fileId, false);
    },
    removeFile(email, fileId) {
      const { data } = findFile(email, fileId);
      data.files.splice(data.files.findIndex((f) => f.id === fileId), 1);
      logChange(data.email, fileId, true);
    },
    setFilePermissions(email, fileId, permissions) {
      const { data, file } = findFile(email, fileId);
      file.permissions = permissions;
      file.version = fileVersion(file) + 1;
      logChange(data.email, fileId, false);
    },
    putPage(email, page) {
      const data = accountOf(email);
      const next: FakeNotionPage = { ...page, lastEdited: page.lastEdited ?? new Date().toISOString() };
      const at = data.pages.findIndex((pg) => pg.id === page.id);
      if (at >= 0) data.pages[at] = next;
      else data.pages.push(next);
    },
    putEvent(email, event) {
      const data = accountOf(email);
      const at = data.events.findIndex((e) => e.id === event.id);
      if (at >= 0) data.events[at] = event;
      else data.events.push(event);
    },
    seedGrant(grant) {
      seeded.push(grant);
      applySeedGrant(grant);
    },
    reset() {
      for (const list of [apiCalls, tokenCalls, consents, revoked, drafts, sentMails, labelChanges, createdEvents, updatedEvents, createdPages, outlookSent, categoryChanges, outlookEventUpdates, scheduleRequests, deletedEventCalls, createdEventDetails, changes] as unknown[][]) list.length = 0;
      deletedEvents.clear();
      replyDrafts.clear();
      codes.clear();
      accessTokens.clear();
      refreshTokens.clear();
      granted.clear();
      seeded.forEach(applySeedGrant);
      accounts.clear();
      for (const a of structuredClone(initialAccounts)) accounts.set(a.email, a);
      signedInAs = initialSignedInAs;
      denyNext = false;
      accessTtl = 3600;
      rotation.google = false;
      rotation.microsoft = true;
      rotation.notion = false;
      apiFailure = null;
      tokenFailure = null;
      changeSeq = 0;
      nextId = 1;
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
