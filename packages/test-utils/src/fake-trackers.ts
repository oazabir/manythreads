import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local double of the four work trackers, Jira, Linear, GitHub Issues and Asana, for the connections plugin's tests (PLAN P16-06). It is a sibling of
// fake-providers.ts (Google, Microsoft, Notion) and changes nothing in it: one small HTTP server whose paths do not collide, so one address serves as the fake base of
// all four (`env()` gives the variables that point the plugin at it).
//
//   * The sign-in is the real code flow as far as the plugin can see: the consent address answers at once with a redirect carrying a code and the state; the token
//     address checks the app's id and secret, the redirect address and, where the plugin sent a challenge, the PKCE proof. Refresh works for Jira, Linear and Asana
//     (rotating the refresh token as Atlassian does); GitHub's token does not expire.
//   * The APIs answer from plain data (`data`), only for an access token this server issued and has not been told to expire.
//   * It never records a token, a code, a verifier or a client secret. `calls` holds the method, the path and whether the call was authorized; `writes` holds what a
//     tool changed (a created issue, a comment, a status change) as plain data. `searches` holds the query a tool sent, so a test can see what reached the tracker.

export type FakeTrackerId = 'jira' | 'linear' | 'githubissues' | 'asana';

export interface FakeJiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  assignee: string | null;
  comments: Array<{ author: string; text: string }>;
}
export interface FakeLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  team: string;
  assignee: string | null;
  comments: Array<{ author: string; text: string }>;
}
export interface FakeGithubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  pullRequest: boolean;
  comments: Array<{ author: string; text: string }>;
}
export interface FakeAsanaTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  workspace: string;
  comments: Array<{ author: string; text: string }>;
}

export interface FakeTrackerData {
  jira: { statuses: string[]; issues: FakeJiraIssue[] };
  linear: { teams: Array<{ id: string; key: string; states: Array<{ id: string; name: string }> }>; issues: FakeLinearIssue[] };
  github: { issues: FakeGithubIssue[] };
  asana: { workspaces: Array<{ gid: string; name: string }>; tasks: FakeAsanaTask[] };
}

export const JIRA_SITE_ID = '4c3a1b5e-0000-4000-8000-5d2f9e7a1c11';

export function defaultTrackerData(): FakeTrackerData {
  return {
    jira: {
      statuses: ['To Do', 'In Progress', 'Done'],
      issues: [
        { key: 'ENG-101', summary: 'Login page times out', description: 'Users on slow networks see a blank page after 30 seconds.', status: 'To Do', type: 'Bug', assignee: 'Nadia Karim', comments: [{ author: 'Rafi Hasan', text: 'Reproduced on staging.' }] },
        { key: 'ENG-102', summary: 'Add dark mode', description: 'Follow the system setting.', status: 'In Progress', type: 'Task', assignee: null, comments: [] },
      ],
    },
    linear: {
      teams: [{ id: '8a1f0000-0000-4000-8000-00000000e001', key: 'ENG', states: [{ id: 's-todo', name: 'Todo' }, { id: 's-doing', name: 'In Progress' }, { id: 's-done', name: 'Done' }] }],
      issues: [
        { id: '9b2e0000-0000-4000-8000-00000000a101', identifier: 'ENG-7', title: 'Export fails for large boards', description: 'The CSV export stops at 10 000 cards.', state: 'Todo', team: 'ENG', assignee: 'Priya Rao', comments: [{ author: 'Omar Azabir', text: 'Seen twice this week.' }] },
        { id: '9b2e0000-0000-4000-8000-00000000a102', identifier: 'ENG-8', title: 'Slow search', description: 'Search takes four seconds.', state: 'In Progress', team: 'ENG', assignee: null, comments: [] },
      ],
    },
    github: {
      issues: [
        { repo: 'acme/widgets', number: 12, title: 'Crash when the widget list is empty', body: 'Steps: open the list with no widgets.', state: 'open', author: 'octocat', pullRequest: false, comments: [{ author: 'hubot', text: 'Confirmed.' }] },
        { repo: 'acme/widgets', number: 13, title: 'Fix the empty list crash', body: 'Fixes #12.', state: 'open', author: 'octocat', pullRequest: true, comments: [] },
        { repo: 'acme/gadgets', number: 3, title: 'Gadget colours are wrong', body: 'Blue shows as green.', state: 'open', author: 'hubot', pullRequest: false, comments: [] },
      ],
    },
    asana: {
      workspaces: [{ gid: '1100', name: 'Kahf' }],
      tasks: [
        { gid: '5001', name: 'Prepare the launch checklist', notes: 'Owners for each item.', completed: false, workspace: '1100', comments: [{ author: 'Nadia Karim', text: 'Draft is in the shared folder.' }] },
        { gid: '5002', name: 'Book the venue', notes: '', completed: true, workspace: '1100', comments: [] },
      ],
    },
  };
}

/** What a tool changed at a tracker. `target` is the key, number or id; `text` is the title, comment or notes that was sent. */
export interface FakeTrackerWrite {
  tracker: FakeTrackerId;
  kind: 'create' | 'comment' | 'status';
  target: string;
  account: string;
  text?: string;
  status?: string;
}

export interface FakeTrackerCall {
  tracker: FakeTrackerId;
  method: string;
  /** The path only, as it came (percent-encoding kept); the query is left out. */
  path: string;
  authorized: boolean;
}

export interface FakeTrackers {
  url: string;
  clientId: string;
  clientSecret: string;
  /** The variables that make the connections plugin use this server: app id and secret and the fake base, for each of the four. */
  env(): Record<string, string>;
  data: FakeTrackerData;
  calls: FakeTrackerCall[];
  writes: FakeTrackerWrite[];
  /** Every search a tool sent: Jira's JQL, Linear's filter (as JSON), GitHub's `q`, Asana's typeahead query. */
  searches: Array<{ tracker: FakeTrackerId; query: string }>;
  /** Every GraphQL document and variables Linear was sent (the variables as JSON), so a test can see that values travel as variables. */
  graphql: Array<{ query: string; variables: string }>;
  tokenCalls: Array<{ tracker: FakeTrackerId; grant: string; ok: boolean; pkce: boolean | null }>;
  consents: Array<{ tracker: FakeTrackerId; scopes: string[]; hasChallenge: boolean }>;
  signInAs(email: string): void;
  expireAccessTokens(): void;
  failNextApi(status: number, count?: number): void;
  /** The next `count` Linear GraphQL calls (not the account-label one) answer 200 with an errors list of this `extensions.type`; the message quotes a secret, so a test can see it is never passed on. */
  failNextGraphql(type: string, count?: number): void;
  stop(): Promise<void>;
}

interface IssuedCode {
  tracker: FakeTrackerId;
  account: string;
  redirectUri: string;
  challenge: string | null;
  scopes: string[];
}
interface Issued {
  tracker: FakeTrackerId;
  account: string;
  scopes: string[];
}

const TRACKERS = {
  jira: { authorize: '/jira/authorize', token: '/jira/oauth/token', api: '/jira-api' },
  linear: { authorize: '/linear/oauth/authorize', token: '/linear/oauth/token', api: '/linear-api' },
  githubissues: { authorize: '/github/login/oauth/authorize', token: '/github/login/oauth/access_token', api: '/github-api' },
  asana: { authorize: '/asana/-/oauth_authorize', token: '/asana/-/oauth_token', api: '/asana-api/api/1.0' },
} as const satisfies Record<FakeTrackerId, { authorize: string; token: string; api: string }>;
const IDS = Object.keys(TRACKERS) as FakeTrackerId[];

const sha256url = (value: string): string => createHash('sha256').update(value).digest('base64url');
const fresh = (prefix: string): string => `${prefix}-${randomBytes(18).toString('base64url')}`;
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const has = (hay: string, words: string): boolean => words.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.toLowerCase().includes(w));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const adf = (text: string): unknown => ({ type: 'doc', version: 1, content: text.split(/\n{2,}/).filter((p) => p.trim() !== '').map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) });
const adfPlain = (doc: unknown): string => arr(rec(doc)['content']).map((p) => arr(rec(p)['content']).map((t) => s(rec(t)['text'])).join('')).join('\n\n');

/**
 * `host` and `port` say where it listens (default: 127.0.0.1 and a free port); `publicHost` is the host name written into the addresses it hands out (default: `host`, or
 * 127.0.0.1 for 0.0.0.0). Only tools/fake-saas sets them, to put the stand-in on the devbox address a stage release can reach.
 */
export async function startFakeTrackers(options: { clientId?: string; clientSecret?: string; accounts?: string[]; host?: string; port?: number; publicHost?: string } = {}): Promise<FakeTrackers> {
  const clientId = options.clientId ?? 'fake-tracker-client-id';
  const clientSecret = options.clientSecret ?? 'fake-tracker-client-secret';
  const accounts = options.accounts ?? ['person@kahf.example'];
  let signedInAs = accounts[0]!;
  const accessTtl = 3600;
  let apiFailure: { status: number; left: number } | null = null;
  let graphqlFailure: { type: string; left: number } | null = null;
  const data = defaultTrackerData();
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, Issued & { expired: boolean }>();
  const refreshTokens = new Map<string, Issued & { dead: boolean }>();
  const calls: FakeTrackers['calls'] = [];
  const writes: FakeTrackers['writes'] = [];
  const searches: FakeTrackers['searches'] = [];
  const graphql: FakeTrackers['graphql'] = [];
  const tokenCalls: FakeTrackers['tokenCalls'] = [];
  const consents: FakeTrackers['consents'] = [];
  let next = 1000;
  let baseUrl = '';

  const trackerOf = (path: string): FakeTrackerId | null => IDS.find((id) => path.startsWith(`${TRACKERS[id].api}/`) || path === TRACKERS[id].api || path.startsWith(`${TRACKERS[id].authorize}`) || path === TRACKERS[id].token) ?? null;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const tracker = trackerOf(path);
    const send = (status: number, doc: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    };
    if (!tracker) return send(404, { error: 'not_found' });
    const where = TRACKERS[tracker];

    // ---- the consent address ----
    if (method === 'GET' && path === where.authorize) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== clientId || !redirectUri || q.get('response_type') !== 'code') return send(400, { error: 'invalid_request' });
      const scopes = (q.get('scope') ?? '').split(/[\s,]+/).filter((x) => x !== '');
      consents.push({ tracker, scopes, hasChallenge: q.has('code_challenge') });
      const code = fresh('code');
      codes.set(code, { tracker, account: signedInAs, redirectUri, challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null, scopes });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    // ---- the token address ----
    if (method === 'POST' && path === where.token) {
      const form = body.trim().startsWith('{') ? (JSON.parse(body) as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
      const grant = s(form['grant_type']);
      const fail = (status: number, error: string, pkce: boolean | null = null): void => {
        tokenCalls.push({ tracker, grant, ok: false, pkce });
        return send(status, { error });
      };
      if (form['client_id'] !== clientId || form['client_secret'] !== clientSecret) return fail(401, 'invalid_client');
      let issued: Issued;
      let pkce: boolean | null = null;
      if (grant === 'authorization_code') {
        const code = codes.get(s(form['code']));
        codes.delete(s(form['code']));
        if (!code || code.tracker !== tracker || code.redirectUri !== form['redirect_uri']) return fail(400, 'invalid_grant');
        if (code.challenge !== null) {
          pkce = sha256url(s(form['code_verifier'])) === code.challenge;
          if (!pkce) return fail(400, 'invalid_grant', false);
        }
        issued = { tracker, account: code.account, scopes: code.scopes };
      } else if (grant === 'refresh_token' && tracker !== 'githubissues') {
        const old = refreshTokens.get(s(form['refresh_token']));
        if (!old || old.dead || old.tracker !== tracker) return fail(400, 'invalid_grant');
        issued = old;
        if (tracker === 'jira') old.dead = true; // Atlassian rotates the refresh token on every renewal
      } else return fail(400, 'unsupported_grant_type');
      const access = fresh('access');
      accessTokens.set(access, { ...issued, expired: false });
      const refresh = tracker === 'githubissues' ? null : tracker === 'jira' || grant === 'authorization_code' ? fresh('refresh') : s(form['refresh_token']);
      if (refresh !== null && !refreshTokens.has(refresh)) refreshTokens.set(refresh, { ...issued, dead: false });
      tokenCalls.push({ tracker, grant, ok: true, pkce });
      // the scope in the form each tracker uses: a list (Linear), commas (GitHub), spaces
      const scope = tracker === 'linear' ? issued.scopes : tracker === 'githubissues' ? issued.scopes.join(',') : issued.scopes.join(' ');
      return send(200, { access_token: access, token_type: 'bearer', scope, ...(tracker === 'githubissues' ? {} : { expires_in: accessTtl }), ...(refresh ? { refresh_token: refresh } : {}) });
    }

    if (!path.startsWith(where.api)) return send(404, { error: 'not_found' });

    // ---- the API ----
    const bearer = /^Bearer (.+)$/.exec(String(req.headers['authorization'] ?? ''))?.[1];
    const token = bearer ? accessTokens.get(bearer) : undefined;
    const authorized = token !== undefined && token.tracker === tracker && !token.expired;
    calls.push({ tracker, method, path, authorized });
    if (!authorized) return send(401, { message: 'bad credentials' });
    if (apiFailure && apiFailure.left > 0) {
      apiFailure.left -= 1;
      return send(apiFailure.status, { message: 'forced failure' });
    }
    const account = token.account;
    const sub = path.slice(where.api.length);
    const json = body.trim() === '' ? {} : (JSON.parse(body) as unknown);
    const q = url.searchParams;
    const wrote = (w: Omit<FakeTrackerWrite, 'tracker' | 'account'>): void => void writes.push({ tracker, account, ...w });
    const notFound = (): void => send(404, { message: 'not found' });

    if (tracker === 'jira') {
      if (sub === '/oauth/token/accessible-resources') return send(200, [{ id: JIRA_SITE_ID, url: `${baseUrl}/jira-site`, name: 'kahf', scopes: token.scopes }]);
      if (sub === '/me') return send(200, { email: account, name: account });
      const m = new RegExp(`^/ex/jira/${JIRA_SITE_ID}/rest/api/3(/.*)$`).exec(sub);
      if (!m) return notFound();
      const api = m[1]!;
      const issue = (key: string): FakeJiraIssue | undefined => data.jira.issues.find((i) => i.key === decodeURIComponent(key));
      const shape = (i: FakeJiraIssue): unknown => ({
        key: i.key,
        fields: {
          summary: i.summary,
          status: { name: i.status },
          issuetype: { name: i.type },
          assignee: i.assignee ? { displayName: i.assignee } : null,
          reporter: { displayName: 'Omar Azabir' },
          updated: '2026-11-03T08:00:00.000+0000',
          labels: [],
          description: adf(i.description),
          comment: { comments: i.comments.map((c) => ({ author: { displayName: c.author }, created: '2026-11-03T08:00:00.000+0000', body: adf(c.text) })) },
        },
      });
      if (method === 'POST' && api === '/search/jql') {
        const jql = s(rec(json)['jql']);
        searches.push({ tracker, query: jql });
        const key = /key = "([^"]+)"/.exec(jql)?.[1];
        const text = /text ~ "([^"]*)"/.exec(jql)?.[1];
        const project = /project = "([^"]+)"/.exec(jql)?.[1];
        const found = data.jira.issues.filter((i) => (key ? i.key === key : text !== undefined ? has(`${i.summary} ${i.description}`, text) : false) && (!project || i.key.startsWith(`${project}-`)));
        return send(200, { issues: found.slice(0, Number(rec(json)['maxResults'] ?? 10)).map(shape) });
      }
      if (method === 'POST' && api === '/issue') {
        const f = rec(rec(json)['fields']);
        const project = s(rec(f['project'])['key']);
        const made: FakeJiraIssue = { key: `${project}-${String(++next)}`, summary: s(f['summary']), description: adfPlain(f['description']), status: 'To Do', type: s(rec(f['issuetype'])['name']), assignee: null, comments: [] };
        data.jira.issues.push(made);
        wrote({ kind: 'create', target: made.key, text: made.summary });
        return send(201, { id: String(next), key: made.key });
      }
      const one = /^\/issue\/([^/]+)(\/comment|\/transitions)?$/.exec(api);
      if (!one) return notFound();
      const found = issue(one[1]!);
      if (!found) return notFound();
      if (!one[2] && method === 'GET') return send(200, shape(found));
      if (one[2] === '/comment' && method === 'POST') {
        const text = adfPlain(rec(json)['body']);
        found.comments.push({ author: account, text });
        wrote({ kind: 'comment', target: found.key, text });
        return send(201, { id: String(++next) });
      }
      if (one[2] === '/transitions' && method === 'GET') return send(200, { transitions: data.jira.statuses.filter((n) => n !== found.status).map((n) => ({ id: String(11 + data.jira.statuses.indexOf(n)), name: `Move to ${n}`, to: { name: n } })) });
      if (one[2] === '/transitions' && method === 'POST') {
        const to = data.jira.statuses[Number(s(rec(rec(json)['transition'])['id'])) - 11];
        if (!to) return send(400, { errorMessages: ['bad transition'] });
        found.status = to;
        wrote({ kind: 'status', target: found.key, status: to });
        return send(204, {});
      }
      return notFound();
    }

    if (tracker === 'linear') {
      if (sub !== '/graphql' || method !== 'POST') return notFound();
      const query = s(rec(json)['query']);
      const vars = rec(rec(json)['variables']);
      graphql.push({ query, variables: JSON.stringify(vars) });
      const shape = (i: FakeLinearIssue): unknown => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        url: `https://linear.example/issue/${i.identifier}`,
        updatedAt: '2026-11-03T08:00:00.000Z',
        state: { name: i.state },
        assignee: i.assignee ? { name: i.assignee } : null,
        team: { key: i.team },
        description: i.description,
        creator: { name: 'Omar Azabir' },
        labels: { nodes: [] },
        comments: { nodes: i.comments.map((c) => ({ body: c.text, createdAt: '2026-11-03T08:00:00.000Z', user: { name: c.author } })) },
      });
      const pick = (idOrKey: string): FakeLinearIssue | undefined => data.linear.issues.find((i) => i.id === idOrKey || i.identifier === idOrKey);
      if (query.includes('viewer')) return send(200, { data: { viewer: { email: account } } });
      if (graphqlFailure && graphqlFailure.left > 0) {
        graphqlFailure.left -= 1;
        return send(200, { errors: [{ message: 'SECRET-LINEAR-MESSAGE for ENG-7', extensions: { type: graphqlFailure.type } }], data: null });
      }
      if (query.includes('issueCreate')) {
        const input = rec(vars['input']);
        const team = data.linear.teams.find((t) => t.id === input['teamId']);
        if (!team) return send(200, { errors: [{ message: 'Entity not found: Team', extensions: { type: 'invalid input' } }] });
        const made: FakeLinearIssue = { id: randomUUID(), identifier: `${team.key}-${String(++next)}`, title: s(input['title']), description: s(input['description']), state: 'Todo', team: team.key, assignee: null, comments: [] };
        data.linear.issues.push(made);
        wrote({ kind: 'create', target: made.identifier, text: made.title });
        return send(200, { data: { issueCreate: { success: true, issue: { identifier: made.identifier, url: `https://linear.example/issue/${made.identifier}` } } } });
      }
      if (query.includes('commentCreate')) {
        const input = rec(vars['input']);
        const found = pick(s(input['issueId']));
        if (!found || !/^[0-9a-f-]{36}$/.test(s(input['issueId']))) return send(200, { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] });
        found.comments.push({ author: account, text: s(input['body']) });
        wrote({ kind: 'comment', target: found.identifier, text: s(input['body']) });
        return send(200, { data: { commentCreate: { success: true, comment: { id: 'c1', url: `https://linear.example/issue/${found.identifier}#c1` } } } });
      }
      if (query.includes('issueUpdate')) {
        const found = pick(s(vars['id']));
        const state = data.linear.teams.flatMap((t) => t.states).find((x) => x.id === rec(vars['input'])['stateId']);
        if (!found || !state) return send(200, { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] });
        found.state = state.name;
        wrote({ kind: 'status', target: found.identifier, status: state.name });
        return send(200, { data: { issueUpdate: { success: true } } });
      }
      if (query.includes('teams(first')) {
        const team = data.linear.teams.find((t) => t.key === vars['key']);
        return send(200, { data: { teams: { nodes: team ? [{ id: team.id }] : [] } } });
      }
      if (query.includes('states(first')) {
        const found = pick(s(vars['id']));
        if (!found) return send(200, { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] });
        const team = data.linear.teams.find((t) => t.key === found.team)!;
        return send(200, { data: { issue: { id: found.id, team: { states: { nodes: team.states } } } } });
      }
      if (query.includes('issues(first')) {
        searches.push({ tracker, query: JSON.stringify(vars['filter']) });
        const filter = rec(vars['filter']);
        const word = s(rec(rec(arr(filter['or'])[0])['title'])['containsIgnoreCase']);
        const team = s(rec(rec(filter['team'])['key'])['eq']);
        return send(200, { data: { issues: { nodes: data.linear.issues.filter((i) => has(`${i.title} ${i.description}`, word) && (!team || i.team === team)).map(shape) } } });
      }
      if (query.includes('comments(first')) {
        const found = pick(s(vars['id']));
        return found ? send(200, { data: { issue: shape(found) } }) : send(200, { errors: [{ message: 'Entity not found: Issue' }], data: null });
      }
      if (query.includes('issue(id')) {
        const found = pick(s(vars['id']));
        return found ? send(200, { data: { issue: { id: found.id } } }) : send(200, { errors: [{ message: 'Entity not found: Issue' }], data: null });
      }
      return send(200, { errors: [{ message: 'unknown query' }] });
    }

    if (tracker === 'githubissues') {
      const shape = (i: FakeGithubIssue): unknown => ({
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        user: { login: i.author },
        comments: i.comments.length,
        labels: [],
        assignees: [],
        updated_at: '2026-11-03T08:00:00Z',
        html_url: `https://github.example/${i.repo}/issues/${String(i.number)}`,
        repository_url: `https://api.github.example/repos/${i.repo}`,
        ...(i.pullRequest ? { pull_request: {} } : {}),
      });
      if (sub === '/user') return send(200, { login: account.split('@')[0] });
      if (sub === '/search/issues') {
        const qs = q.get('q') ?? '';
        searches.push({ tracker, query: qs });
        const repo = /(?:^| )repo:(\S+)/.exec(qs)?.[1];
        const wordsOnly = qs.replace(/(?:^| )(repo|is|org|user):\S+/g, ' ').trim();
        const found = data.github.issues.filter((i) => !i.pullRequest && (!repo || i.repo === repo) && has(`${i.title} ${i.body}`, wordsOnly));
        return send(200, { total_count: found.length, items: found.map(shape) });
      }
      if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(sub)) {
        const [, owner, name] = sub.split('/').slice(1);
        const made: FakeGithubIssue = { repo: `${decodeURIComponent(owner!)}/${decodeURIComponent(name!)}`, number: ++next, title: s(rec(json)['title']), body: s(rec(json)['body']), state: 'open', author: account.split('@')[0]!, pullRequest: false, comments: [] };
        data.github.issues.push(made);
        wrote({ kind: 'create', target: `${made.repo}#${String(made.number)}`, text: made.title });
        return send(201, shape(made));
      }
      const m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?$/.exec(sub);
      if (!m) return notFound();
      const repo = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      const found = data.github.issues.find((i) => i.repo === repo && i.number === Number(m[3]));
      if (!found) return notFound();
      if (!m[4] && method === 'GET') return send(200, shape(found));
      if (!m[4] && method === 'PATCH') {
        found.state = rec(json)['state'] === 'closed' ? 'closed' : 'open';
        wrote({ kind: 'status', target: `${repo}#${String(found.number)}`, status: `${found.state}${rec(json)['state_reason'] ? `:${s(rec(json)['state_reason'])}` : ''}` });
        return send(200, shape(found));
      }
      if (m[4] && method === 'GET') return send(200, found.comments.map((c) => ({ user: { login: c.author }, created_at: '2026-11-03T08:00:00Z', body: c.text })));
      if (m[4] && method === 'POST') {
        found.comments.push({ author: account, text: s(rec(json)['body']) });
        wrote({ kind: 'comment', target: `${repo}#${String(found.number)}`, text: s(rec(json)['body']) });
        return send(201, { html_url: `https://github.example/${repo}/issues/${String(found.number)}#c` });
      }
      return notFound();
    }

    // Asana
    const shape = (t: FakeAsanaTask): unknown => ({ gid: t.gid, name: t.name, notes: t.notes, completed: t.completed, assignee: null, due_on: null, modified_at: '2026-11-03T08:00:00Z', permalink_url: `https://asana.example/0/${t.workspace}/${t.gid}`, projects: [] });
    if (sub === '/users/me') return send(200, { data: { email: account, workspaces: data.asana.workspaces } });
    const typeahead = /^\/workspaces\/(\d+)\/typeahead$/.exec(sub);
    if (typeahead && method === 'GET') {
      searches.push({ tracker, query: q.get('query') ?? '' });
      return send(200, { data: data.asana.tasks.filter((t) => t.workspace === typeahead[1] && has(t.name, q.get('query') ?? '')).map(shape) });
    }
    if (method === 'POST' && sub === '/tasks') {
      const d = rec(rec(json)['data']);
      const made: FakeAsanaTask = { gid: String(++next), name: s(d['name']), notes: s(d['notes']), completed: false, workspace: s(d['workspace']) || data.asana.workspaces[0]!.gid, comments: [] };
      data.asana.tasks.push(made);
      wrote({ kind: 'create', target: made.gid, text: made.name });
      return send(201, { data: shape(made) });
    }
    const t = /^\/tasks\/(\d+)(\/stories)?$/.exec(sub);
    if (!t) return notFound();
    const found = data.asana.tasks.find((x) => x.gid === t[1]);
    if (!found) return notFound();
    if (!t[2] && method === 'GET') return send(200, { data: shape(found) });
    if (!t[2] && method === 'PUT') {
      found.completed = rec(rec(json)['data'])['completed'] === true;
      wrote({ kind: 'status', target: found.gid, status: found.completed ? 'done' : 'open' });
      return send(200, { data: shape(found) });
    }
    if (t[2] && method === 'GET') return send(200, { data: found.comments.map((c) => ({ type: 'comment', text: c.text, created_at: '2026-11-03T08:00:00Z', created_by: { name: c.author } })) });
    if (t[2] && method === 'POST') {
      const text = s(rec(rec(json)['data'])['text']);
      found.comments.push({ author: account, text });
      wrote({ kind: 'comment', target: found.gid, text });
      return send(201, { data: { gid: String(++next), text } });
    }
    return notFound();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
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
    env: () => Object.fromEntries(IDS.flatMap((id) => [[`MANYTHREADS_OAUTH_${id.toUpperCase()}_CLIENT_ID`, clientId], [`MANYTHREADS_OAUTH_${id.toUpperCase()}_CLIENT_SECRET`, clientSecret], [`MANYTHREADS_OAUTH_${id.toUpperCase()}_FAKE_BASE`, baseUrl]])),
    data,
    calls,
    writes,
    searches,
    graphql,
    tokenCalls,
    consents,
    signInAs: (email) => void (signedInAs = email),
    expireAccessTokens: () => void [...accessTokens.values()].forEach((t) => void (t.expired = true)),
    failNextApi: (status, count = 1) => void (apiFailure = { status, left: count }),
    failNextGraphql: (type, count = 1) => void (graphqlFailure = { type, left: count }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
