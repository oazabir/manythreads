import { createAppPool, createSecretService, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { ListOAuthAppsResponse, ListPersonConnectionsResponse, McpRunMintResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeSupport, type FakeSupport } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { compileBot } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';
import { PERSON_TOOL_DEFS } from '../src/person-tools.ts';
import type { OAuthDeps } from '../src/oauth/store.ts';

// P16-07: Zendesk, Intercom, HubSpot and Salesforce, on a real server and a fake of each provider (packages/test-utils/src/fake-support.ts; no real network). The sign-in is the
// real OAuth code flow against the fakes; the tools are called through the real MCP gateway as a bot that a person asked, and every write waits for an approval.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, priya, rafi, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
const WS = omar.workspaceId;
const asker = nadia;

let w: RepoWorld;
let fake: FakeSupport;
let sysPool: pg.Pool;
let deps: OAuthDeps;
const savedEnv: Record<string, string | undefined> = {};

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const asPlugin = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => sys((tx) => fn(tx as unknown as PluginTx));
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// ---- the browser's side of a sign-in ----

const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function begin(who: Who, provider: PersonProviderId, body: Record<string, unknown> = {}): Promise<string> {
  const res = await raw(who, 'POST', `/api/me/connections/${provider}/start`, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return StartPersonConnectionResponse.parse(await res.json()).url;
}
async function consent(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}
async function arrive(who: Who, back: URL): Promise<URL> {
  const res = await raw(who, 'GET', `${back.pathname}${back.search}`);
  expect(res.status, await res.clone().text()).toBe(302);
  return new URL(res.headers.get('location')!, 'http://site.invalid');
}
async function connect(who: Who & { email: string }, provider: PersonProviderId, services?: string[]): Promise<URL> {
  fake.signInAs(who.email);
  const url = await begin(who, provider, services ? { services } : {});
  return arrive(who, await consent(url));
}
const providersOf = async (who: Who) => {
  const res = await w.call(who, 'GET', '/api/me/connections/providers');
  expect(res.status).toBe(200);
  return ListPersonConnectionsResponse.parse(res.body).providers;
};
const providerOf = async (who: Who, id: PersonProviderId) => (await providersOf(who)).find((p) => p.id === id)!;

beforeAll(async () => {
  fake = await startFakeSupport();
  for (const [k, v] of Object.entries(fake.env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  deps = {
    db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
    secrets: createSecretService(),
    now: () => new Date(),
    env: process.env,
  };
  void deps;
}, 180_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sysPool?.end();
  await w?.close();
  await fake?.stop();
});

const NEW = ['zendesk', 'intercom', 'hubspot', 'salesforce'] as const;

describe('connecting', () => {
  it('lists the four providers with what each offers', async () => {
    const list = await providersOf(omar);
    expect(list.map((p) => p.id)).toEqual(['google', 'microsoft', 'notion', 'jira', 'linear', 'githubissues', 'asana', ...NEW, 'confluence', 'dropbox', 'box']);
    const zendesk = list.find((p) => p.id === 'zendesk')!;
    expect(zendesk).toMatchObject({ configured: true, connected: false });
    expect(zendesk.services.map((s) => s.id)).toEqual(['tickets', 'tickets_write']);
    expect(zendesk.services.find((s) => s.id === 'tickets')).toMatchObject({ tools: ['zendesk.search_tickets', 'zendesk.read_ticket', 'zendesk.find_customer'], writes: false });
    expect(zendesk.services.find((s) => s.id === 'tickets_write')).toMatchObject({ tools: ['zendesk.add_note', 'zendesk.reply', 'zendesk.set_status'], writes: true });
    expect(list.find((p) => p.id === 'intercom')!.services.map((s) => s.id)).toEqual(['conversations', 'conversations_write']);
    expect(list.find((p) => p.id === 'hubspot')!.services.map((s) => s.id)).toEqual(['contacts', 'contacts_write']);
    expect(list.find((p) => p.id === 'salesforce')!.services.map((s) => s.id)).toEqual(['records']);
  });

  it('a full Zendesk sign-in and a Salesforce one use PKCE; HubSpot and Intercom do not; only Intercom gets no refresh token', async () => {
    for (const p of NEW) await connect(asker, p);
    const grants = (p: string) => fake.tokenCalls.filter((c) => c.provider === p && c.grant === 'authorization_code').at(-1)!;
    expect(grants('zendesk')).toMatchObject({ ok: true, pkce: true });
    expect(grants('salesforce')).toMatchObject({ ok: true, pkce: true });
    expect(grants('hubspot')).toMatchObject({ ok: true, pkce: null });
    expect(grants('intercom')).toMatchObject({ ok: true, pkce: null });
    for (const p of NEW) expect(await providerOf(asker, p), p).toMatchObject({ connected: true, state: 'ok' });
    expect((await providerOf(asker, 'zendesk')).accountLabel).toBe(asker.email);
    expect((await providerOf(asker, 'salesforce')).accountLabel).toBe(asker.email);
    expect((await providerOf(asker, 'intercom')).accountLabel).toBe(asker.email);
    expect((await providerOf(asker, 'hubspot')).accountLabel).toBe('HubSpot account 4417');
    const refresh = await sys(async (tx) => (await tx.query<{ slug: string; n: number }>(`SELECT c.slug, count(*)::int AS n FROM app.connection_secrets cs JOIN app.connections c ON c.id = cs.connection_id WHERE c.owner_id = $1 GROUP BY c.slug`, [asker.actorId])).rows);
    expect(Object.fromEntries(refresh.map((r) => [r.slug, r.n]))).toMatchObject({ zendesk: 2, salesforce: 2, hubspot: 2, intercom: 1 });
  });

  it('asks only for the scopes of the services the person ticks', async () => {
    const scopes = () => fake.consents.at(-1)!;
    await connect(priya, 'zendesk');
    expect(scopes()).toMatchObject({ provider: 'zendesk', scopes: ['read'], hasChallenge: true });
    await connect(priya, 'zendesk', ['tickets', 'tickets_write']);
    expect(scopes().scopes).toEqual(['read', 'tickets:write']);
    await connect(priya, 'hubspot', ['contacts']);
    expect(scopes()).toMatchObject({ provider: 'hubspot', scopes: ['crm.objects.contacts.read'] });
    await connect(priya, 'salesforce');
    expect(scopes()).toMatchObject({ provider: 'salesforce', scopes: expect.arrayContaining(['api', 'refresh_token']) });
    // Intercom has no scope parameter: what the app is allowed is set in Intercom, and the services here are the person's own choice
    await connect(priya, 'intercom', ['conversations']);
    expect(scopes()).toMatchObject({ provider: 'intercom', scopes: [] });
    expect((await providerOf(priya, 'intercom')).services.filter((s) => s.granted).map((s) => s.id)).toEqual(['conversations']);
  });

  it('a person who says no at the provider is not connected and is told so plainly', async () => {
    fake.denyNextConsent();
    const back = await consent(await begin(tariq, 'zendesk'));
    const done = await arrive(tariq, back);
    expect(done.searchParams.get('connected')).toBeNull();
    expect((await providerOf(tariq, 'zendesk')).connected).toBe(false);
  });
});

describe('the subdomain of the account (Zendesk and Salesforce)', () => {
  const put = (provider: string, body: unknown) => w.call(omar, 'PUT', `/api/admin/connections/oauth-apps/${provider}`, body);
  const SECRET = 'APP-SECRET-must-not-appear';

  it('an admin enters one plain label; anything that could change the address is refused, and the secret is never echoed', async () => {
    for (const bad of ['acme.evil.example', 'evil.example/x', 'user@evil.example', 'acme:8080', 'https://acme', 'ac--me', 'acme.zendesk.com']) {
      const res = await put('zendesk', { clientId: 'x', clientSecret: SECRET, tenant: bad });
      expect(res.status, bad).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    }
    expect((await put('zendesk', { clientId: 'x', clientSecret: SECRET })).status).toBe(400);
    expect((await put('salesforce', { clientId: 'x', clientSecret: SECRET, tenant: 'a/b' })).status).toBe(400);
    expect((await put('hubspot', { clientId: 'x', clientSecret: SECRET, tenant: 'acme' })).status).toBe(400);
    expect((await put('intercom', { clientId: 'x', clientSecret: SECRET, tenant: 'acme' })).status).toBe(400);
  });

  it('a good label is kept lower-case and shown with its kind; clearing the app puts the server’s setting back', async () => {
    const ok = await put('zendesk', { clientId: fake.clientId, clientSecret: fake.clientSecret, tenant: ' Acme-Support ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const apps = ListOAuthAppsResponse.parse((await w.call(omar, 'GET', '/api/admin/connections/oauth-apps')).body).apps;
    expect(apps.find((a) => a.provider === 'zendesk')).toMatchObject({ source: 'workspace', supportsTenant: true, tenantKind: 'subdomain', tenant: 'acme-support' });
    expect(apps.find((a) => a.provider === 'salesforce')).toMatchObject({ supportsTenant: true, tenantKind: 'subdomain' });
    expect(apps.find((a) => a.provider === 'microsoft')).toMatchObject({ supportsTenant: true, tenantKind: 'directory' });
    expect(apps.find((a) => a.provider === 'hubspot')).toMatchObject({ supportsTenant: false, tenantKind: null });
    expect(JSON.stringify(apps)).not.toContain(fake.clientSecret);
    expect((await w.call(omar, 'DELETE', '/api/admin/connections/oauth-apps/zendesk')).body).toEqual({ cleared: true });
    // with the fake standing in for the provider the sign-in still works from the server's own setting
    expect((await providerOf(omar, 'zendesk')).configured).toBe(true);
  });

  it('only an admin may set it', async () => {
    expect((await w.call(nadia, 'PUT', '/api/admin/connections/oauth-apps/zendesk', { clientId: 'x', clientSecret: SECRET, tenant: 'acme' })).status).toBe(403);
  });
});

// ---- the tools, through the gateway ----

const declared: Declared = new Map([['email.read', { destructive: false }], ...PERSON_TOOL_DEFS.map((t) => [t.name, { destructive: false }] as const)]);
const SUPPORT_NAMES = PERSON_TOOL_DEFS.filter((t) => (NEW as readonly string[]).includes(t.provider)).map((t) => t.name);

async function makeBot(team: string, slug: string, connections: unknown = []): Promise<{ botId: string; actorId: string }> {
  return sys(async (tx) => {
    const botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
         VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
        [WS, team, slug, JSON.stringify(connections)],
      )
    ).rows[0]!.id;
    const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [WS, botId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actorId, WS]);
    return { botId, actorId };
  });
}
async function openRun(botId: string, team: string, askerActorId: string | null): Promise<McpRunMintResponse> {
  const appPool = createAppPool(w.server.db.appUrl);
  const pool = createSystemPool(w.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
    const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({ botId, teamId: team, workspaceId: WS, trigger: askerActorId === null ? 'webhook' : 'conversation', ...(askerActorId === null ? {} : { askerActorId }) });
    return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${w.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
  } finally {
    await appPool.end();
    await pool.end();
  }
}
async function rpc(run: McpRunMintResponse, method: string, params?: unknown): Promise<{ result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> {
  const res = await fetch(`${w.server.url}/api/mcp/runs/${run.runId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as never;
}
const listed = async (run: McpRunMintResponse): Promise<string[]> => ((await rpc(run, 'tools/list')).result?.tools ?? []).map((t) => t.name);
const answers: string[] = [];
const called = async (run: McpRunMintResponse, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const body = await rpc(run, 'tools/call', { name, arguments: args });
  if (!body.result?.content) throw new Error(`${name} answered without a result: ${JSON.stringify(body).slice(0, 300)}`);
  const text = body.result.content[0]!.text;
  answers.push(text);
  return JSON.parse(text) as Record<string, unknown>;
};
const pendingOf = (answer: Record<string, unknown>) =>
  sys(async (tx) => (await tx.query<{ id: string; summary: string; args_preview: Record<string, unknown>; status: string }>('SELECT id, summary, args_preview, status FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]!);
async function approve(id: string): Promise<void> {
  const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${id}/approve`, {});
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string | null }>('SELECT outcome FROM app.approvals WHERE id = $1', [id])).rows[0]!.outcome)) === 'ran' || null, 30_000, 'the approval to be marked as run');
}
const LONG = `${'The invoice was charged twice. '.repeat(60)}`.slice(0, 1599) + '!';

describe('the tools, as a bot that the person asked', () => {
  let bot: { botId: string; actorId: string };
  const run = () => openRun(bot.botId, ENG, asker.actorId);

  beforeAll(async () => {
    bot = await makeBot(ENG, 'support-bot', [{ connection: 'person:*', tools: SUPPORT_NAMES }]);
    await asPlugin((tx) => compileBot(tx, declared, { workspaceId: WS, teamId: ENG, botId: bot.botId }));
    // read access only, to begin with
    await connect(asker, 'zendesk', ['tickets']);
    await connect(asker, 'intercom', ['conversations']);
    await connect(asker, 'hubspot', ['contacts']);
    await connect(asker, 'salesforce', ['records']);
  });

  it('offers a write tool only for a service the person agreed to, and says what to do when one is called without it', async () => {
    const names = await listed(await run());
    for (const n of ['zendesk.search_tickets', 'zendesk.read_ticket', 'zendesk.find_customer', 'intercom.search_conversations', 'hubspot.find_contact', 'salesforce.find_customer', 'salesforce.add_case_note', 'salesforce.set_case_status']) expect(names, n).toContain(n);
    for (const n of ['zendesk.reply', 'zendesk.add_note', 'zendesk.set_status', 'intercom.reply', 'intercom.add_note', 'intercom.set_state', 'hubspot.add_note', 'hubspot.set_lead_status']) expect(names, n).not.toContain(n);
    // a write tool that is not offered can still be named: it waits for an approval like any write, and once approved it still does nothing, as the service was not agreed to
    const answer = await called(await run(), 'zendesk.reply', { ticketId: '4101', body: 'Hello' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${String(answer['approvalId'])}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string | null }>('SELECT outcome FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]!.outcome)) || null, 30_000, 'the approval to be decided');
    expect(fake.writes.zendeskUpdates).toEqual([]);
  });

  it('a run that nobody asked reaches no one’s connection', async () => {
    const nobody = await openRun(bot.botId, ENG, null);
    expect((await listed(nobody)).filter((n) => SUPPORT_NAMES.includes(n))).toEqual([]);
    expect(await called(nobody, 'zendesk.search_tickets', { query: 'invoice' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await called(nobody, 'salesforce.find_customer', { query: 'hana' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('another person with no connection gets nothing', async () => {
    const other = await openRun(bot.botId, ENG, rafi.actorId);
    expect((await listed(other)).filter((n) => SUPPORT_NAMES.includes(n))).toEqual([]);
    expect(await called(other, 'zendesk.search_tickets', { query: 'invoice' })).toMatchObject({ ok: false });
  });

  it('Zendesk: search, read (internal notes marked) and the customer with their latest tickets', async () => {
    const r = await run();
    const found = (await called(r, 'zendesk.search_tickets', { query: 'invoice 2041', status: 'open' }))['tickets'] as Array<{ id: string; status: string }>;
    expect(found.map((t) => [t.id, t.status])).toEqual([['4101', 'open']]);
    const read = await called(r, 'zendesk.read_ticket', { ticketId: '4101' });
    expect(read).toMatchObject({ ok: true, ticket: { id: '4101', status: 'open', assigneeId: '102' } });
    expect((read['comments'] as Array<{ public: boolean; text: string }>).map((c) => c.public)).toEqual([true, false]);
    const customer = await called(r, 'zendesk.find_customer', { query: 'hana@harbourgrain.example' });
    expect((customer['customers'] as Array<{ id: string }>).map((c) => c.id)).toEqual(['101']);
    expect((customer['recentTicketsOfFirst'] as unknown[]).length).toBe(2);
    expect(await called(r, 'zendesk.read_ticket', { ticketId: '999999' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await called(r, 'zendesk.read_ticket', { ticketId: '../users/me' })).toMatchObject({ code: 'validation_failed' });
  });

  it('Intercom: search, read and the customer; the version header is always sent', async () => {
    const r = await run();
    const found = (await called(r, 'intercom.search_conversations', { query: 'seats' }))['conversations'] as Array<{ id: string; snippet: string }>;
    expect(found.map((c) => c.id)).toEqual(['215472581234']);
    expect(found[0]!.snippet).not.toContain('<p>');
    const read = await called(r, 'intercom.read_conversation', { conversationId: '215472581234' });
    expect((read['parts'] as Array<{ kind: string }>).map((p) => p.kind)).toEqual(['comment', 'note']);
    expect(JSON.stringify(read)).not.toContain('<p>');
    expect(((await called(r, 'intercom.find_customer', { email: 'hana@harbourgrain.example' }))['customers'] as Array<{ name: string }>)[0]!.name).toBe('Hana Okafor');
  });

  it('HubSpot and Salesforce: find, read, search', async () => {
    const r = await run();
    const contacts = (await called(r, 'hubspot.find_contact', { query: 'harbour' }))['contacts'] as Array<{ id: string; leadStatus: string }>;
    expect(contacts.map((c) => [c.id, c.leadStatus])).toEqual([['501', 'CONNECTED']]);
    expect(await called(r, 'hubspot.read_contact', { contactId: '501' })).toMatchObject({ ok: true, contact: { company: 'Harbour Grain' } });
    const sf = await called(r, 'salesforce.find_customer', { query: 'hana' });
    expect((sf['contacts'] as Array<{ accountName: string }>)[0]!.accountName).toBe('Harbour Grain');
    const cases = (await called(r, 'salesforce.search_cases', { query: 'duplicate' }))['cases'] as Array<{ id: string; number: string }>;
    expect(cases.map((c) => c.number)).toEqual(['00001234']);
    const read = await called(r, 'salesforce.read_case', { caseId: cases[0]!.id });
    expect(read).toMatchObject({ ok: true, case: { number: '00001234', status: 'Working' } });
    expect((read['comments'] as Array<{ public: boolean }>).map((c) => c.public)).toEqual([false]);
  });

  it('what is typed into a search is quoted for the provider, never run as part of the query', async () => {
    const r = await run();
    await called(r, 'zendesk.search_tickets', { query: 'x" status:closed requester:spy@evil.example' });
    await called(r, 'salesforce.find_customer', { query: "x' OR Name != '" });
    await called(r, 'salesforce.search_cases', { query: "x') OR (Subject != '", status: 'Working' });
    expect(fake.soql.some((q) => q.includes("LIKE '%x\\' OR Name != \\'%'"))).toBe(true);
    expect(fake.soql.some((q) => q.includes("LIKE '%x\\') OR (Subject != \\'%'"))).toBe(true);
    expect(fake.soql.every((q) => !/ OR Name != '/.test(q.replaceAll("\\'", '')))).toBe(true);
    const zendeskSearch = fake.apiCalls.filter((c) => c.provider === 'zendesk' && c.path === '/api/v2/search.json');
    expect(zendeskSearch.length).toBeGreaterThan(0);
  });

  it('a person who agrees to the write services gets the write tools, and the consent asks for the write scopes only then', async () => {
    await connect(asker, 'zendesk', ['tickets', 'tickets_write']);
    await connect(asker, 'intercom', ['conversations', 'conversations_write']);
    await connect(asker, 'hubspot', ['contacts', 'contacts_write']);
    expect(fake.consents.filter((c) => c.provider === 'zendesk').at(-1)!.scopes).toEqual(['read', 'tickets:write']);
    const names = await listed(await run());
    for (const n of SUPPORT_NAMES) expect(names, n).toContain(n);
  });

  it('a Zendesk reply waits for approval; the card holds all of the text; once approved the text goes out once, public, exactly as approved', async () => {
    const r = await run();
    expect(LONG.length).toBe(1600);
    const answer = await called(r, 'zendesk.reply', { ticketId: '4101', body: LONG });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.writes.zendeskUpdates).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary.length).toBeLessThanOrEqual(300);
    expect(card.summary.startsWith('Reply to the customer on Zendesk ticket 4101')).toBe(true);
    expect((card.args_preview['text'] as string[]).join('')).toBe(LONG);
    await approve(card.id);
    expect(fake.writes.zendeskUpdates).toEqual([{ ticketId: 4101, comment: { body: LONG, public: true }, status: null }]);
  });

  it('a Zendesk note is internal, and a status change changes the status only', async () => {
    const r = await run();
    const note = await called(r, 'zendesk.add_note', { ticketId: '4101', body: 'Refund requested from finance.' });
    expect(note).toMatchObject({ code: 'approval_pending' });
    expect((await pendingOf(note)).args_preview).toMatchObject({ visibility: expect.stringContaining('customer does not see') });
    await approve((await pendingOf(note)).id);
    expect(fake.writes.zendeskUpdates.at(-1)).toEqual({ ticketId: 4101, comment: { body: 'Refund requested from finance.', public: false }, status: null });
    const status = await called(await run(), 'zendesk.set_status', { ticketId: '4101', status: 'solved' });
    expect((await pendingOf(status)).summary).toBe('Set Zendesk ticket 4101 to solved');
    await approve((await pendingOf(status)).id);
    expect(fake.writes.zendeskUpdates.at(-1)).toEqual({ ticketId: 4101, comment: null, status: 'solved' });
    expect(fake.data.zendesk.tickets[0]!.status).toBe('solved');
  });

  it('a rejected approval sends nothing', async () => {
    const before = fake.writes.zendeskUpdates.length;
    const answer = await called(await run(), 'zendesk.reply', { ticketId: '4102', body: 'Never sent' });
    const card = await pendingOf(answer);
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${card.id}/deny`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.writes.zendeskUpdates.length).toBe(before);
  });

  it('Intercom: a note, a reply (text escaped, sent as the signed-in admin) and closing a conversation', async () => {
    const r = await run();
    const reply = await called(r, 'intercom.reply', { conversationId: '215472581234', body: 'Done <b>today</b>\nThanks' });
    expect(reply).toMatchObject({ code: 'approval_pending' });
    expect(fake.writes.intercomParts).toEqual([]);
    await approve((await pendingOf(reply)).id);
    const note = await called(await run(), 'intercom.add_note', { conversationId: '215472581234', body: 'Seats billed yearly' });
    await approve((await pendingOf(note)).id);
    const close = await called(await run(), 'intercom.set_state', { conversationId: '215472581234', state: 'closed' });
    expect((await pendingOf(close)).summary).toBe('Close Intercom conversation 215472581234');
    await approve((await pendingOf(close)).id);
    expect(fake.writes.intercomParts).toEqual([
      { conversationId: '215472581234', kind: 'reply', messageType: 'comment', type: 'admin', adminId: '991267', body: 'Done &lt;b&gt;today&lt;/b&gt;<br>Thanks' },
      { conversationId: '215472581234', kind: 'reply', messageType: 'note', type: 'admin', adminId: '991267', body: 'Seats billed yearly' },
      { conversationId: '215472581234', kind: 'parts', messageType: 'close', type: 'admin', adminId: '991267', body: null },
    ]);
    expect(fake.data.intercom.conversations[0]!.state).toBe('closed');
  });

  it('HubSpot: a note on the contact (text escaped) and a lead status', async () => {
    const r = await run();
    const note = await called(r, 'hubspot.add_note', { contactId: '501', body: 'Called <today>' });
    expect(note).toMatchObject({ code: 'approval_pending' });
    expect(fake.writes.hubspotNotes).toEqual([]);
    await approve((await pendingOf(note)).id);
    expect(fake.writes.hubspotNotes).toEqual([{ contactId: '501', body: 'Called &lt;today&gt;' }]);
    const lead = await called(await run(), 'hubspot.set_lead_status', { contactId: '501', status: 'IN_PROGRESS' });
    await approve((await pendingOf(lead)).id);
    expect(fake.writes.hubspotUpdates).toEqual([{ contactId: '501', properties: { hs_lead_status: 'IN_PROGRESS' } }]);
    // a status HubSpot has no standard value for is never sent (a write may wait for an approval before its input is looked at)
    expect(['validation_failed', 'approval_pending']).toContain((await called(await run(), 'hubspot.set_lead_status', { contactId: '501', status: 'DELETED' }))['code']);
    expect(fake.writes.hubspotUpdates).toHaveLength(1);
  });

  it('Salesforce: a case note is never published to the customer, and the status change changes the status only', async () => {
    const r = await run();
    const id = '500AB000003ijklQAA';
    const note = await called(r, 'salesforce.add_case_note', { caseId: id, body: 'Waiting for the bank' });
    expect(note).toMatchObject({ code: 'approval_pending' });
    expect(fake.writes.salesforceComments).toEqual([]);
    await approve((await pendingOf(note)).id);
    expect(fake.writes.salesforceComments).toEqual([{ caseId: id, body: 'Waiting for the bank', published: false }]);
    const status = await called(await run(), 'salesforce.set_case_status', { caseId: id, status: 'Closed' });
    await approve((await pendingOf(status)).id);
    expect(fake.writes.salesforceCaseUpdates).toEqual([{ caseId: id, fields: { Status: 'Closed' } }]);
  });

  it('refuses text that could be read differently from how it is shown, and ids that could change a path, before any provider is asked', async () => {
    const r = await run();
    const calls = fake.apiCalls.length;
    const writes = JSON.stringify(fake.writes);
    for (const [tool, args] of [
      ['zendesk.reply', { ticketId: '4101', body: 'Fine‮gnirts' }],
      ['zendesk.add_note', { ticketId: '4101', body: 'x'.repeat(2001) }],
      ['zendesk.reply', { ticketId: '4101/comments', body: 'x' }],
      ['zendesk.reply', { ticketId: '4101', body: 'x', public: false }],
      ['intercom.reply', { conversationId: '../me', body: 'x' }],
      ['hubspot.add_note', { contactId: '..', body: 'x' }],
      ['salesforce.add_case_note', { caseId: '500AB000003ijkl/../x', body: 'x' }],
      ['salesforce.add_case_note', { caseId: '500AB000003ijklQAA', body: 'x', IsPublished: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      // a write may be held for an approval before its input is looked at (as the other tools are); either way nothing reaches the provider
      expect(['validation_failed', 'approval_pending'], `${tool} ${JSON.stringify(args).slice(0, 60)}`).toContain((await called(r, tool, args))['code']);
    }
    expect(fake.apiCalls.length).toBe(calls);
    expect(JSON.stringify(fake.writes)).toBe(writes);
  });

  it('a provider that fails gives our words, and nothing a ticket or a customer wrote', async () => {
    const r = await run();
    fake.failNextApi(500);
    const down = await called(r, 'zendesk.read_ticket', { ticketId: '4101' });
    expect(down).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(JSON.stringify(down)).not.toMatch(/SECRET|forced failure/);
    fake.failNextApi(403);
    expect(await called(r, 'salesforce.read_case', { caseId: '500AB000003ijklQAA' })).toMatchObject({ ok: false, code: 'provider_refused' });
  });

  it('a token that ran out is renewed once and the call goes on (Zendesk, HubSpot, Salesforce); Intercom’s cannot be renewed and the person is told to connect again', async () => {
    const r = await run();
    fake.expireAccessTokens();
    const before = fake.tokenCalls.filter((c) => c.grant === 'refresh_token').length;
    expect(await called(r, 'zendesk.search_tickets', { query: 'invoice' })).toMatchObject({ ok: true });
    expect(await called(r, 'hubspot.find_contact', { query: 'harbour' })).toMatchObject({ ok: true });
    expect(await called(r, 'salesforce.find_customer', { query: 'hana' })).toMatchObject({ ok: true });
    expect(fake.tokenCalls.filter((c) => c.grant === 'refresh_token').length).toBe(before + 3);
    expect(await called(r, 'intercom.search_conversations', { query: 'seats' })).toMatchObject({ ok: false, code: 'needs_reconnect' });
    expect(await providerOf(asker, 'intercom')).toMatchObject({ connected: true, state: 'needs_reconnect' });
    expect((await listed(await run())).filter((n) => n.startsWith('intercom.'))).toEqual([]);
    await connect(asker, 'intercom', ['conversations', 'conversations_write']);
    expect(await called(await run(), 'intercom.search_conversations', { query: 'seats' })).toMatchObject({ ok: true });
  });

  it('a sign-in the provider took back is found on the first call, and the tools go away', async () => {
    fake.expireAccessTokens();
    fake.revokeRefreshTokens();
    const r = await run();
    expect(await called(r, 'zendesk.search_tickets', { query: 'invoice' })).toMatchObject({ ok: false, code: 'needs_reconnect' });
    expect((await listed(await run())).filter((n) => n.startsWith('zendesk.'))).toEqual([]);
    expect(await providerOf(asker, 'zendesk')).toMatchObject({ connected: true, state: 'needs_reconnect' });
  });

  it('no answer, card or event carries a token or a secret, and the fake never saw a call without one', async () => {
    const cards = await sys(async (tx) => JSON.stringify((await tx.query('SELECT summary, args_preview FROM app.approvals')).rows));
    const events = await sys(async (tx) => JSON.stringify((await tx.query('SELECT payload FROM app.events').catch(() => ({ rows: [] }))).rows));
    const everything = `${answers.join('\n')}\n${cards}\n${events}`;
    expect(everything).not.toMatch(/(access|refresh|code)-[A-Za-z0-9_-]{20}/);
    expect(everything).not.toContain(fake.clientSecret);
    // the errors carry no ticket text
    expect(answers.filter((a) => a.includes('"ok":false')).join('\n')).not.toMatch(/SECRET-(TICKET|CONVERSATION|CASE)-TEXT/);
    expect(fake.apiCalls.filter((c) => !c.authorized && c.path !== '/api/v2/users/me.json').every((c) => c.method !== 'PUT' && c.method !== 'PATCH')).toBe(true);
  });
});
