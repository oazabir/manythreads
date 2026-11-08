import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local double of Zendesk, Intercom, HubSpot and Salesforce, for the connections plugin's tests (PLAN P16-07). Each provider is its own small HTTP server (the plugin
// reads one fake address per provider, `MANYTHREADS_OAUTH_<PROVIDER>_FAKE_BASE`, so each needs its own origin), all started and stopped together.
//
//   * The sign-in is real OAuth as far as the plugin can see: the consent address answers at once with a redirect carrying a one-time code and the state the caller sent,
//     the token address checks the app's id and secret, the redirect address and, for Zendesk and Salesforce, the PKCE proof; HubSpot, Zendesk and Salesforce refresh
//     tokens renew an access token (Intercom's tokens do not expire). A code works once.
//   * The APIs answer from one account's data per provider (`data`), only for an access token it issued and has not been told to expire, and refuse a write when the
//     scope for it was not agreed to. They are as strict as the real ones where the tools depend on it: Zendesk's PUT, Intercom's version header and admin id, SOQL's
//     quoting (an unbalanced quote is a MALFORMED_QUERY).
//   * It never records a token, a code, a verifier or a client secret: `apiCalls` holds the method, the path and whether the call was authorized. The writes a tool makes
//     are kept as plain data (`writes`), and every SOQL text it was sent as `soql`.
//   * One account per provider: who is signed in only decides the address the "whose account" calls answer with.

export type FakeSupportProviderId = 'zendesk' | 'intercom' | 'hubspot' | 'salesforce';

export interface FakeSupportApiCall {
  provider: FakeSupportProviderId;
  method: string;
  /** The path only; the query is left out. */
  path: string;
  authorized: boolean;
}
export interface FakeSupportTokenCall {
  provider: FakeSupportProviderId;
  grant: string;
  ok: boolean;
  error: string | null;
  /** The PKCE proof matched the challenge of the start; null when the provider has none or the grant is not a code exchange. */
  pkce: boolean | null;
}

export interface ZdUser {
  id: number;
  name: string;
  email: string;
  role: string;
  organization_id: number | null;
  created_at: string;
}
export interface ZdComment {
  id: number;
  author_id: number;
  public: boolean;
  plain_body: string;
  created_at: string;
}
export interface ZdTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority: string | null;
  requester_id: number;
  assignee_id: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  comments: ZdComment[];
}
export interface IcPart {
  id: string;
  part_type: string;
  body: string;
  author: { type: string; id: string };
  created_at: number;
}
export interface IcConversation {
  id: string;
  state: string;
  created_at: number;
  updated_at: number;
  source: { subject: string; body: string; author: { type: string; id: string } };
  admin_assignee_id: string | null;
  parts: IcPart[];
}
export interface IcContact {
  id: string;
  role: string;
  name: string;
  email: string;
  created_at: number;
  last_seen_at: number | null;
}
export interface HsContact {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  company: string;
  jobtitle: string;
  lifecyclestage: string;
  hs_lead_status: string;
  lastmodifieddate: string;
}
export interface SfContact {
  Id: string;
  Name: string;
  Email: string;
  Title: string;
  AccountName: string;
}
export interface SfAccount {
  Id: string;
  Name: string;
  Industry: string;
}
export interface SfCase {
  Id: string;
  CaseNumber: string;
  Subject: string;
  Description: string;
  Status: string;
  Priority: string;
  Origin: string;
  ContactId: string;
  CreatedDate: string;
  LastModifiedDate: string;
}
export interface SfCaseComment {
  Id: string;
  ParentId: string;
  CommentBody: string;
  IsPublished: boolean;
  CreatedDate: string;
}

export interface FakeSupportData {
  zendesk: { users: ZdUser[]; tickets: ZdTicket[] };
  intercom: { adminId: string; contacts: IcContact[]; conversations: IcConversation[] };
  hubspot: { portalId: number; contacts: HsContact[] };
  salesforce: { contacts: SfContact[]; accounts: SfAccount[]; cases: SfCase[]; comments: SfCaseComment[] };
}

export interface FakeSupportWrites {
  zendeskUpdates: Array<{ ticketId: number; comment: { body: string; public: boolean } | null; status: string | null }>;
  intercomParts: Array<{ conversationId: string; kind: 'reply' | 'parts'; messageType: string; type: string; adminId: string; body: string | null }>;
  hubspotNotes: Array<{ contactId: string; body: string }>;
  hubspotUpdates: Array<{ contactId: string; properties: Record<string, unknown> }>;
  salesforceComments: Array<{ caseId: string; body: string; published: boolean }>;
  salesforceCaseUpdates: Array<{ caseId: string; fields: Record<string, unknown> }>;
}

export interface FakeSupport {
  /** `http://127.0.0.1:<port>` of each provider. */
  urls: Record<FakeSupportProviderId, string>;
  clientId: string;
  clientSecret: string;
  /** The variables that make the connections plugin use these servers: the app id and secret and the fake base of each provider. */
  env(): Record<string, string>;
  data: FakeSupportData;
  writes: FakeSupportWrites;
  apiCalls: FakeSupportApiCall[];
  tokenCalls: FakeSupportTokenCall[];
  /** Every consent address that was opened, as the scopes asked for (no state or challenge). */
  consents: Array<{ provider: FakeSupportProviderId; scopes: string[]; hasChallenge: boolean }>;
  /** Every SOQL text Salesforce was sent. */
  soql: string[];
  /** The account the next consent signs in as. */
  signInAs(email: string): void;
  denyNextConsent(): void;
  /** Every access token issued so far stops working (the API answers 401) while refresh tokens still work. */
  expireAccessTokens(): void;
  /** Every refresh token issued so far is refused with `invalid_grant`. */
  revokeRefreshTokens(): void;
  /** The next `count` API calls answer `status` before anything else. */
  failNextApi(status: number, count?: number): void;
  stop(): Promise<void>;
}

const sha256url = (value: string): string => createHash('sha256').update(value).digest('base64url');
const fresh = (prefix: string): string => `${prefix}-${randomBytes(18).toString('base64url')}`;
const ISO = '2026-10-30T10:12:00Z';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The data every test starts from: a customer, Nadia's ticket, conversation, contact and case at each provider. */
export function defaultSupportData(): FakeSupportData {
  return {
    zendesk: {
      users: [
        { id: 101, name: 'Hana Okafor', email: 'hana@harbourgrain.example', role: 'end-user', organization_id: 7001, created_at: '2026-06-01T08:00:00Z' },
        { id: 102, name: 'Support Agent', email: 'agent@kahf.example', role: 'agent', organization_id: null, created_at: '2025-01-01T08:00:00Z' },
      ],
      tickets: [
        {
          id: 4101,
          subject: 'Invoice 2041 was charged twice',
          description: 'Hello, we were charged twice for invoice 2041. SECRET-TICKET-TEXT',
          status: 'open',
          priority: 'high',
          requester_id: 101,
          assignee_id: 102,
          tags: ['billing', 'refund'],
          created_at: '2026-10-29T09:00:00Z',
          updated_at: ISO,
          comments: [
            { id: 9001, author_id: 101, public: true, plain_body: 'Hello, we were charged twice for invoice 2041. SECRET-TICKET-TEXT', created_at: '2026-10-29T09:00:00Z' },
            { id: 9002, author_id: 102, public: false, plain_body: 'Checked the ledger: duplicate confirmed.', created_at: '2026-10-30T10:12:00Z' },
          ],
        },
        {
          id: 4102,
          subject: 'How do I export my data?',
          description: 'I need a CSV export.',
          status: 'pending',
          priority: 'normal',
          requester_id: 101,
          assignee_id: null,
          tags: [],
          created_at: '2026-10-20T09:00:00Z',
          updated_at: '2026-10-21T09:00:00Z',
          comments: [{ id: 9003, author_id: 101, public: true, plain_body: 'I need a CSV export.', created_at: '2026-10-20T09:00:00Z' }],
        },
      ],
    },
    intercom: {
      adminId: '991267',
      contacts: [{ id: '6329bd9ad4bbd07a4f2a6e11', role: 'user', name: 'Hana Okafor', email: 'hana@harbourgrain.example', created_at: 1780300800, last_seen_at: 1793000000 }],
      conversations: [
        {
          id: '215472581234',
          state: 'open',
          created_at: 1793000000,
          updated_at: 1793003600,
          source: { subject: 'Seats', body: '<p>Can we add five seats? SECRET-CONVERSATION-TEXT</p>', author: { type: 'user', id: '6329bd9ad4bbd07a4f2a6e11' } },
          admin_assignee_id: '991267',
          parts: [
            { id: 'p1', part_type: 'comment', body: '<p>Sure, checking.</p>', author: { type: 'admin', id: '991267' }, created_at: 1793001000 },
            { id: 'p2', part_type: 'note', body: '<p>Internal: they are on the annual plan.</p>', author: { type: 'admin', id: '991267' }, created_at: 1793002000 },
          ],
        },
        { id: '215472589999', state: 'closed', created_at: 1792000000, updated_at: 1792000500, source: { subject: 'Thanks', body: '<p>Thanks for the help</p>', author: { type: 'user', id: '6329bd9ad4bbd07a4f2a6e11' } }, admin_assignee_id: null, parts: [] },
      ],
    },
    hubspot: {
      portalId: 4417,
      contacts: [
        { id: '501', firstname: 'Hana', lastname: 'Okafor', email: 'hana@harbourgrain.example', company: 'Harbour Grain', jobtitle: 'Finance lead', lifecyclestage: 'customer', hs_lead_status: 'CONNECTED', lastmodifieddate: ISO },
        { id: '502', firstname: 'Ola', lastname: 'Berg', email: 'ola@fjordmill.example', company: 'Fjord Mill', jobtitle: 'Buyer', lifecyclestage: 'lead', hs_lead_status: 'NEW', lastmodifieddate: '2026-10-01T09:00:00Z' },
      ],
    },
    salesforce: {
      contacts: [{ Id: '003AB000001abcdQAA', Name: 'Hana Okafor', Email: 'hana@harbourgrain.example', Title: 'Finance lead', AccountName: 'Harbour Grain' }],
      accounts: [{ Id: '001AB000002efghQAA', Name: 'Harbour Grain', Industry: 'Food' }],
      cases: [
        {
          Id: '500AB000003ijklQAA',
          CaseNumber: '00001234',
          Subject: 'Duplicate charge on invoice 2041',
          Description: 'Charged twice. SECRET-CASE-TEXT',
          Status: 'Working',
          Priority: 'High',
          Origin: 'Email',
          ContactId: '003AB000001abcdQAA',
          CreatedDate: '2026-10-29T09:00:00.000+0000',
          LastModifiedDate: ISO,
        },
      ],
      comments: [{ Id: '00aAB000004mnopQAA', ParentId: '500AB000003ijklQAA', CommentBody: 'Called the customer.', IsPublished: false, CreatedDate: '2026-10-30T10:12:00.000+0000' }],
    },
  };
}

const ticketHead = (t: ZdTicket): Omit<ZdTicket, 'comments'> => ({ id: t.id, subject: t.subject, description: t.description, status: t.status, priority: t.priority, requester_id: t.requester_id, assignee_id: t.assignee_id, tags: t.tags, created_at: t.created_at, updated_at: t.updated_at });
const conversationHead = (c: IcConversation): Omit<IcConversation, 'parts'> => ({ id: c.id, state: c.state, created_at: c.created_at, updated_at: c.updated_at, source: c.source, admin_assignee_id: c.admin_assignee_id });

/** The literals of a SOQL text, as written (`raw`, escapes kept) and as the string they mean (`value`); null when a quote is left open. */
export function soqlLiterals(q: string): Array<{ raw: string; value: string }> | null {
  const out: Array<{ raw: string; value: string }> = [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] !== "'") continue;
    let raw = '';
    let closed = false;
    for (i++; i < q.length; i++) {
      if (q[i] === '\\' && i + 1 < q.length) {
        raw += q[i]! + q[i + 1]!;
        i++;
      } else if (q[i] === "'") {
        closed = true;
        break;
      } else raw += q[i]!;
    }
    if (!closed) return null;
    out.push({ raw, value: raw.replace(/\\(.)/g, '$1') });
  }
  return out;
}
/** What a LIKE pattern looks for: the pattern without its own `%` at either end, escapes undone. */
const likeNeedle = (raw: string): string => raw.replace(/^%/, '').replace(/(?<!\\)%$/, '').replace(/\\(.)/g, '$1').toLowerCase();

interface Issued {
  provider: FakeSupportProviderId;
  account: string;
  scopes: string[];
}
interface IssuedCode extends Issued {
  redirectUri: string;
  challenge: string | null;
}

interface Spec {
  authorize: string;
  token: string;
  revoke: string | null;
  pkce: boolean;
  /** The token answer carries a refresh token. */
  refresh: boolean;
  /** The token answer says how long it lives. */
  expires: boolean;
  scopeParam: boolean;
  tokenResponse(access: string, scopes: string[]): Record<string, unknown>;
}
const SPECS: Record<FakeSupportProviderId, Spec> = {
  zendesk: {
    authorize: '/oauth/authorizations/new',
    token: '/oauth/tokens',
    revoke: null,
    pkce: true,
    refresh: true,
    expires: true,
    scopeParam: true,
    tokenResponse: (access, scopes) => ({ access_token: access, token_type: 'bearer', scope: scopes.join(' ') }),
  },
  intercom: { authorize: '/oauth', token: '/auth/eagle/token', revoke: null, pkce: false, refresh: false, expires: false, scopeParam: false, tokenResponse: (access) => ({ token_type: 'Bearer', access_token: access }) },
  hubspot: {
    authorize: '/oauth/authorize',
    token: '/oauth/v1/token',
    revoke: null,
    pkce: false,
    refresh: true,
    expires: true,
    scopeParam: true,
    tokenResponse: (access) => ({ access_token: access, token_type: 'bearer' }),
  },
  salesforce: {
    authorize: '/services/oauth2/authorize',
    token: '/services/oauth2/token',
    revoke: '/services/oauth2/revoke',
    pkce: true,
    refresh: true,
    expires: false,
    scopeParam: true,
    tokenResponse: (access, scopes) => ({ access_token: access, token_type: 'Bearer', scope: scopes.join(' '), instance_url: 'https://not-used.my.salesforce.com', issued_at: '1793000000000' }),
  },
};

export interface FakeSupportOptions {
  clientId?: string;
  clientSecret?: string;
  data?: FakeSupportData;
  /** Where the four servers listen (default 127.0.0.1); `port` is the first one's port, the next three follow it (default: free ports); `publicHost` is the host written into their addresses. Only tools/fake-saas sets them. */
  host?: string;
  port?: number;
  publicHost?: string;
}

export async function startFakeSupport(options: FakeSupportOptions = {}): Promise<FakeSupport> {
  const clientId = options.clientId ?? 'fake-support-client-id';
  const clientSecret = options.clientSecret ?? 'fake-support-client-secret';
  const data = options.data ?? defaultSupportData();
  const writes: FakeSupportWrites = { zendeskUpdates: [], intercomParts: [], hubspotNotes: [], hubspotUpdates: [], salesforceComments: [], salesforceCaseUpdates: [] };
  const apiCalls: FakeSupportApiCall[] = [];
  const tokenCalls: FakeSupportTokenCall[] = [];
  const consents: FakeSupport['consents'] = [];
  const soql: string[] = [];
  let signedInAs = 'agent@kahf.example';
  let denyNext = false;
  let apiFailure: { status: number; left: number } | null = null;
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, Issued & { expired: boolean }>();
  const refreshTokens = new Map<string, Issued & { dead: boolean }>();

  const handle = async (provider: FakeSupportProviderId, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const spec = SPECS[provider];
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const q = url.searchParams;
    const send = (status: number, doc: unknown): void => {
      if (status === 204) {
        res.writeHead(204);
        return void res.end();
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    };

    // ---- the consent address ----
    if (method === 'GET' && path === spec.authorize) {
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== clientId || !redirectUri || q.get('response_type') !== 'code') return send(400, { error: 'invalid_request' });
      const target = new URL(redirectUri);
      const state = q.get('state') ?? '';
      if (denyNext) {
        denyNext = false;
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('state', state);
        res.writeHead(302, { location: target.toString() });
        return void res.end();
      }
      const scopes = (q.get('scope') ?? '').split(' ').filter((s) => s !== '');
      consents.push({ provider, scopes, hasChallenge: q.has('code_challenge') });
      const code = fresh('code');
      codes.set(code, { provider, account: signedInAs, scopes, redirectUri, challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null });
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    // ---- the token address ----
    if (method === 'POST' && path === spec.token) {
      const fields: Record<string, string> = (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw || '{}') as Record<string, string>) : Object.fromEntries(new URLSearchParams(raw));
      const grant = fields['grant_type'] ?? 'authorization_code';
      const record = (ok: boolean, error: string | null, pkce: boolean | null): void => void tokenCalls.push({ provider, grant, ok, error, pkce });
      const refuse = (status: number, error: string, pkce: boolean | null = null): void => {
        record(false, error, pkce);
        send(status, { error });
      };
      if (fields['client_id'] !== clientId || fields['client_secret'] !== clientSecret) return refuse(401, 'invalid_client');
      const ttl = provider === 'hubspot' ? 1800 : 3600;
      if (grant === 'authorization_code') {
        const issued = codes.get(fields['code'] ?? '');
        codes.delete(fields['code'] ?? '');
        if (!issued || issued.provider !== provider) return refuse(400, 'invalid_grant');
        if (provider !== 'intercom' && issued.redirectUri !== fields['redirect_uri']) return refuse(400, 'invalid_grant');
        let pkce: boolean | null = null;
        if (spec.pkce) {
          pkce = issued.challenge !== null && typeof fields['code_verifier'] === 'string' && sha256url(fields['code_verifier']) === issued.challenge;
          if (!pkce) return refuse(400, 'invalid_grant', pkce);
        }
        const access = fresh('access');
        accessTokens.set(access, { provider, account: issued.account, scopes: issued.scopes, expired: false });
        const out = spec.tokenResponse(access, issued.scopes);
        if (spec.expires) out['expires_in'] = ttl;
        if (spec.refresh) {
          const refresh = fresh('refresh');
          refreshTokens.set(refresh, { provider, account: issued.account, scopes: issued.scopes, dead: false });
          out['refresh_token'] = refresh;
        }
        record(true, null, pkce);
        return send(200, out);
      }
      if (grant === 'refresh_token' && spec.refresh) {
        const old = refreshTokens.get(fields['refresh_token'] ?? '');
        if (!old || old.dead || old.provider !== provider) return refuse(400, 'invalid_grant');
        const access = fresh('access');
        accessTokens.set(access, { provider, account: old.account, scopes: old.scopes, expired: false });
        const out = spec.tokenResponse(access, old.scopes);
        if (spec.expires) out['expires_in'] = ttl;
        // Salesforce answers a refresh without a new refresh token; the others hand the same one back
        if (provider !== 'salesforce') out['refresh_token'] = fields['refresh_token'];
        record(true, null, null);
        return send(200, out);
      }
      return refuse(400, 'unsupported_grant_type');
    }

    // ---- revoke (Salesforce) ----
    if (method === 'POST' && spec.revoke !== null && path === spec.revoke) {
      const token = Object.fromEntries(new URLSearchParams(raw))['token'] ?? '';
      const r = refreshTokens.get(token);
      if (r) r.dead = true;
      const a = accessTokens.get(token);
      if (a) a.expired = true;
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
    const need = (scope: string): boolean => {
      if (token.scopes.includes(scope)) return true;
      send(403, { error: 'insufficient_scope' });
      return false;
    };
    const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
    const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

    // ------------------------------ Zendesk ------------------------------
    if (provider === 'zendesk') {
      const d = data.zendesk;
      const read = (): boolean => need('read');
      if (method === 'GET' && path === '/api/v2/users/me.json') return send(200, { user: { email: signedInAs } });
      if (method === 'GET' && path === '/api/v2/search.json') {
        if (!read()) return;
        const query = q.get('query') ?? '';
        const phrase = /"([^"]*)"/.exec(query)?.[1]?.toLowerCase() ?? '';
        const status = /\bstatus:(\w+)/.exec(query)?.[1];
        const requester = /\brequester:(\S+)/.exec(query)?.[1]?.toLowerCase();
        const who = requester ? d.users.find((u) => u.email.toLowerCase() === requester)?.id : undefined;
        const found = d.tickets.filter(
          (t) =>
            (status === undefined || t.status === status) &&
            (requester === undefined || t.requester_id === who) &&
            (phrase === '' || `${t.subject} ${t.description}`.toLowerCase().includes(phrase)),
        );
        const per = Number(q.get('per_page') ?? 10);
        return send(200, { count: found.length, results: found.slice(0, per).map((t) => ({ ...ticketHead(t), result_type: 'ticket' })) });
      }
      const ticketPath = /^\/api\/v2\/tickets\/(\d+)(\/comments)?\.json$/.exec(path);
      if (ticketPath) {
        const ticket = d.tickets.find((t) => t.id === Number(ticketPath[1]));
        if (!ticket) return send(404, { error: 'RecordNotFound' });
        if (method === 'GET') {
          if (!read()) return;
          const { comments, ...rest } = ticket;
          if (ticketPath[2]) {
            const sorted = q.get('sort_order') === 'desc' ? [...comments].reverse() : comments;
            return send(200, { comments: sorted.slice(0, Number(q.get('per_page') ?? 100)) });
          }
          return send(200, { ticket: rest });
        }
        // Zendesk takes PUT for a change, not PATCH
        if (method === 'PUT' && !ticketPath[2]) {
          if (!need('tickets:write')) return;
          const change = obj(body['ticket']);
          const comment = obj(change['comment']);
          const hasComment = typeof comment['body'] === 'string';
          writes.zendeskUpdates.push({
            ticketId: ticket.id,
            comment: hasComment ? { body: String(comment['body']), public: comment['public'] === true } : null,
            status: typeof change['status'] === 'string' ? change['status'] : null,
          });
          if (hasComment) ticket.comments.push({ id: 9100 + ticket.comments.length, author_id: 102, public: comment['public'] === true, plain_body: String(comment['body']), created_at: ISO });
          if (typeof change['status'] === 'string') ticket.status = change['status'];
          return send(200, { ticket: ticketHead(ticket) });
        }
      }
      if (method === 'GET' && path === '/api/v2/users/search.json') {
        if (!read()) return;
        const phrase = /"([^"]*)"/.exec(q.get('query') ?? '')?.[1]?.toLowerCase() ?? '';
        return send(200, { users: d.users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(phrase)) });
      }
      const requested = /^\/api\/v2\/users\/(\d+)\/tickets\/requested\.json$/.exec(path);
      if (method === 'GET' && requested) {
        if (!read()) return;
        return send(200, { tickets: d.tickets.filter((t) => t.requester_id === Number(requested[1])).map(ticketHead) });
      }
      return send(404, { error: 'not_found' });
    }

    // ------------------------------ Intercom ------------------------------
    if (provider === 'intercom') {
      const d = data.intercom;
      // every call names the version it expects the answer in
      if (!req.headers['intercom-version']) return send(400, { type: 'error.list', errors: [{ code: 'intercom_version_invalid' }] });
      const part = (p: IcPart): Record<string, unknown> => ({ ...p });
      if (method === 'GET' && path === '/me') return send(200, { type: 'admin', id: d.adminId, email: signedInAs });
      if (method === 'POST' && path === '/conversations/search') {
        const filters = (obj(body['query'])['value'] as unknown[] | undefined) ?? [];
        const words = String(obj(filters.find((f) => obj(f)['field'] === 'source.body'))['value'] ?? '').toLowerCase();
        const state = obj(filters.find((f) => obj(f)['field'] === 'state'))['value'];
        const per = Number(obj(body['pagination'])['per_page'] ?? 10);
        const found = d.conversations.filter((c) => c.source.body.toLowerCase().includes(words) && (state === undefined || c.state === state));
        return send(200, { type: 'conversation.list', conversations: found.slice(0, per).map(conversationHead) });
      }
      const conversation = /^\/conversations\/([A-Za-z0-9]+)(\/reply|\/parts)?$/.exec(path);
      if (conversation) {
        const c = d.conversations.find((x) => x.id === conversation[1]);
        if (!c) return send(404, { type: 'error.list', errors: [{ code: 'not_found' }] });
        if (method === 'GET' && !conversation[2]) {
          const { parts, ...rest } = c;
          return send(200, { ...rest, conversation_parts: { conversation_parts: parts.map(part) } });
        }
        if (method === 'POST' && conversation[2]) {
          const adminId = String(body['admin_id'] ?? '');
          if (adminId !== d.adminId || body['type'] !== 'admin') return send(400, { type: 'error.list', errors: [{ code: 'parameter_invalid' }] });
          const kind = conversation[2] === '/reply' ? 'reply' : 'parts';
          writes.intercomParts.push({ conversationId: c.id, kind, messageType: String(body['message_type']), type: 'admin', adminId, body: typeof body['body'] === 'string' ? body['body'] : null });
          if (kind === 'parts') c.state = body['message_type'] === 'close' ? 'closed' : 'open';
          else c.parts.push({ id: `p${c.parts.length + 1}`, part_type: body['message_type'] === 'note' ? 'note' : 'comment', body: String(body['body'] ?? ''), author: { type: 'admin', id: adminId }, created_at: 1793004000 });
          return send(200, { type: 'conversation', id: c.id, state: c.state });
        }
      }
      if (method === 'POST' && path === '/contacts/search') {
        const f = obj(body['query']);
        const value = String(f['value'] ?? '').toLowerCase();
        const found = d.contacts.filter((c) => (f['field'] === 'email' ? c.email.toLowerCase() === value : c.name.toLowerCase().includes(value)));
        return send(200, { type: 'list', data: found });
      }
      return send(404, { error: 'not_found' });
    }

    // ------------------------------ HubSpot ------------------------------
    if (provider === 'hubspot') {
      const d = data.hubspot;
      const shape = (c: HsContact): Record<string, unknown> => {
        const { id, ...properties } = c;
        return { id, properties };
      };
      if (method === 'GET' && path === '/account-info/v3/details') return send(200, { portalId: d.portalId });
      if (method === 'POST' && path === '/crm/v3/objects/contacts/search') {
        if (!need('crm.objects.contacts.read')) return;
        const words = String(body['query'] ?? '').toLowerCase();
        const found = d.contacts.filter((c) => `${c.firstname} ${c.lastname} ${c.email} ${c.company}`.toLowerCase().includes(words));
        return send(200, { total: found.length, results: found.slice(0, Number(body['limit'] ?? 10)).map(shape) });
      }
      const contact = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(path);
      if (contact) {
        const c = d.contacts.find((x) => x.id === contact[1]);
        if (!c) return send(404, { status: 'error', category: 'OBJECT_NOT_FOUND' });
        if (method === 'GET') return need('crm.objects.contacts.read') ? send(200, shape(c)) : undefined;
        if (method === 'PATCH') {
          if (!need('crm.objects.contacts.write')) return;
          const properties = obj(body['properties']);
          writes.hubspotUpdates.push({ contactId: c.id, properties });
          if (typeof properties['hs_lead_status'] === 'string') c.hs_lead_status = properties['hs_lead_status'];
          return send(200, shape(c));
        }
      }
      if (method === 'POST' && path === '/crm/v3/objects/notes') {
        if (!need('crm.objects.contacts.write')) return;
        const to = obj(obj((body['associations'] as unknown[] | undefined)?.[0])['to']);
        const target = d.contacts.find((x) => x.id === String(to['id']));
        if (!target) return send(400, { status: 'error', category: 'VALIDATION_ERROR' });
        writes.hubspotNotes.push({ contactId: target.id, body: String(obj(body['properties'])['hs_note_body'] ?? '') });
        return send(201, { id: `n${writes.hubspotNotes.length}`, properties: {} });
      }
      return send(404, { error: 'not_found' });
    }

    // ------------------------------ Salesforce ------------------------------
    const d = data.salesforce;
    if (method === 'GET' && path === '/services/oauth2/userinfo') return send(200, { email: signedInAs });
    if (!need('api')) return;
    const base = '/services/data/v62.0';
    if (method === 'GET' && path === `${base}/query`) {
      const text = q.get('q') ?? '';
      soql.push(text);
      const lits = soqlLiterals(text);
      if (lits === null) return send(400, [{ errorCode: 'MALFORMED_QUERY', message: 'unclosed string literal' }]);
      const from = /\bFROM (\w+)/.exec(text)?.[1];
      const contains = (hay: string, needle: string): boolean => hay.toLowerCase().includes(needle);
      if (from === 'Contact') {
        const needle = likeNeedle(lits[0]?.raw ?? '');
        return send(200, { records: d.contacts.filter((c) => contains(c.Name, needle) || contains(c.Email, needle)).map(({ AccountName, ...c }) => ({ ...c, Account: { Name: AccountName } })) });
      }
      if (from === 'Account') return send(200, { records: d.accounts.filter((a) => contains(a.Name, likeNeedle(lits[0]?.raw ?? ''))) });
      if (from === 'Case') {
        const needle = likeNeedle(lits[0]?.raw ?? '');
        const number = lits[1]?.value ?? '';
        const status = /\bStatus = '/.test(text) ? lits[2]?.value : undefined;
        return send(200, { records: d.cases.filter((c) => (contains(c.Subject, needle) || c.CaseNumber === number) && (status === undefined || c.Status === status)) });
      }
      if (from === 'CaseComment') return send(200, { records: d.comments.filter((c) => c.ParentId === lits[0]?.value).reverse() });
      return send(400, [{ errorCode: 'INVALID_TYPE', message: 'unknown object' }]);
    }
    const sobject = /^\/services\/data\/v62\.0\/sobjects\/(Case|CaseComment)(?:\/([A-Za-z0-9]+))?$/.exec(path);
    if (sobject) {
      if (sobject[1] === 'CaseComment' && method === 'POST') {
        const parent = String(body['ParentId'] ?? '');
        if (!d.cases.some((c) => c.Id === parent)) return send(400, [{ errorCode: 'INVALID_CROSS_REFERENCE_KEY' }]);
        writes.salesforceComments.push({ caseId: parent, body: String(body['CommentBody'] ?? ''), published: body['IsPublished'] === true });
        d.comments.push({ Id: `00aAB00000${String(d.comments.length).padStart(5, '0')}QAA`, ParentId: parent, CommentBody: String(body['CommentBody'] ?? ''), IsPublished: body['IsPublished'] === true, CreatedDate: ISO });
        return send(201, { id: `00aAB00000${String(d.comments.length).padStart(5, '0')}QAA`, success: true, errors: [] });
      }
      if (sobject[1] === 'Case' && sobject[2]) {
        const c = d.cases.find((x) => x.Id === sobject[2]);
        if (!c) return send(404, [{ errorCode: 'NOT_FOUND' }]);
        if (method === 'GET') return send(200, c);
        if (method === 'PATCH') {
          writes.salesforceCaseUpdates.push({ caseId: c.Id, fields: body });
          if (typeof body['Status'] === 'string') c.Status = body['Status'];
          return send(204, null);
        }
      }
    }
    return send(404, [{ errorCode: 'NOT_FOUND' }]);
  };

  const servers = new Map<FakeSupportProviderId, Server>();
  const urls = {} as Record<FakeSupportProviderId, string>;
  const listenHost = options.host ?? '127.0.0.1';
  const publicHost = options.publicHost ?? (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost);
  for (const [index, provider] of (Object.keys(SPECS) as FakeSupportProviderId[]).entries()) {
    const server = createServer((req, res) => {
      handle(provider, req, res).catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"fake failure"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(options.port === undefined || options.port === 0 ? 0 : options.port + index, listenHost, resolve));
    servers.set(provider, server);
    urls[provider] = `http://${publicHost}:${String((server.address() as AddressInfo).port)}`;
  }

  return {
    urls,
    clientId,
    clientSecret,
    env: () =>
      Object.fromEntries(
        (Object.keys(SPECS) as FakeSupportProviderId[]).flatMap((p) => [
          [`MANYTHREADS_OAUTH_${p.toUpperCase()}_CLIENT_ID`, clientId],
          [`MANYTHREADS_OAUTH_${p.toUpperCase()}_CLIENT_SECRET`, clientSecret],
          [`MANYTHREADS_OAUTH_${p.toUpperCase()}_FAKE_BASE`, urls[p]],
        ]),
      ),
    data,
    writes,
    apiCalls,
    tokenCalls,
    consents,
    soql,
    signInAs: (email) => void (signedInAs = email),
    denyNextConsent: () => void (denyNext = true),
    expireAccessTokens: () => void [...accessTokens.values()].forEach((t) => (t.expired = true)),
    revokeRefreshTokens: () => void [...refreshTokens.values()].forEach((t) => (t.dead = true)),
    failNextApi: (status, count = 1) => void (apiFailure = { status, left: count }),
    stop: async () => {
      await Promise.all([...servers.values()].map((s) => new Promise<void>((resolve) => (s.closeAllConnections(), s.close(() => resolve())))));
    },
  };
}
