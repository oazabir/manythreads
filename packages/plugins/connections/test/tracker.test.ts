import { createAppPool, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { ListPersonConnectionsResponse, McpRunMintResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeTrackers, type FakeTrackers } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { compileBot } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';
import { PERSON_TOOL_DEFS } from '../src/person-tools.ts';

// P16-06: the work-tracker tools through the real MCP gateway, as a bot that a person asked, against the fake trackers (packages/test-utils/src/fake-trackers.ts): the
// sign-in (the real code flow through the plugin's own routes), the services the person agreed to, and the approval every write waits for, with the card an approver reads.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const WS = omar.workspaceId;

let w: RepoWorld;
let fake: FakeTrackers;
let sysPool: pg.Pool;
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

const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** A whole sign-in: start, the person says yes at the fake tracker, the browser arrives back. */
async function connect(who: Who & { email: string }, provider: PersonProviderId, services?: string[]): Promise<URL> {
  fake.signInAs(who.email);
  const start = await raw(who, 'POST', `/api/me/connections/${provider}/start`, services ? { services } : {});
  expect(start.status, await start.clone().text()).toBe(200);
  const consent = await fetch(StartPersonConnectionResponse.parse(await start.json()).url, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get('location')!);
  const arrive = await raw(who, 'GET', `${back.pathname}${back.search}`);
  expect(arrive.status, await arrive.clone().text()).toBe(302);
  return new URL(arrive.headers.get('location')!, 'http://site.invalid');
}

const declared: Declared = new Map(PERSON_TOOL_DEFS.map((t) => [t.name, { destructive: false }] as const));
const TRACKER = PERSON_TOOL_DEFS.filter((t) => ['jira', 'linear', 'githubissues', 'asana'].includes(t.provider)).map((t) => t.name);

async function makeBot(slug: string): Promise<{ botId: string; actorId: string }> {
  return sys(async (tx) => {
    const botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
         VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
        [WS, ENG, slug, JSON.stringify([{ connection: 'person:*', tools: TRACKER }])],
      )
    ).rows[0]!.id;
    const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [WS, botId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actorId, WS]);
    return { botId, actorId };
  });
}
async function openRun(botId: string, askerActorId: string): Promise<McpRunMintResponse> {
  const appPool = createAppPool(w.server.db.appUrl);
  const pool = createSystemPool(w.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
    const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({ botId, teamId: ENG, workspaceId: WS, trigger: 'conversation', askerActorId });
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
const called = async (run: McpRunMintResponse, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  JSON.parse((await rpc(run, 'tools/call', { name, arguments: args })).result!.content![0]!.text) as Record<string, unknown>;
const pendingOf = (answer: Record<string, unknown>) =>
  sys(async (tx) => (await tx.query<{ id: string; summary: string; args_preview: Record<string, unknown> }>('SELECT id, summary, args_preview FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]!);
async function approve(id: string): Promise<void> {
  const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${id}/approve`, {});
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string | null }>('SELECT outcome FROM app.approvals WHERE id = $1', [id])).rows[0]!.outcome)) === 'ran' || null, 30_000, 'the approval to be marked as run');
}

let bot: { botId: string; actorId: string };

beforeAll(async () => {
  fake = await startFakeTrackers({ accounts: [nadia.email] });
  for (const [k, v] of Object.entries(fake.env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  bot = await makeBot('tracker-bot');
  await asPlugin((tx) => compileBot(tx, declared, { workspaceId: WS, teamId: ENG, botId: bot.botId }));
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

describe('connecting a tracker', () => {
  it('lists the four trackers with their services, the write service marked as one that writes', async () => {
    const res = await w.call(nadia, 'GET', '/api/me/connections/providers');
    const list = ListPersonConnectionsResponse.parse(res.body).providers;
    const by = (id: string) => list.find((p) => p.id === id)!;
    expect(by('jira')).toMatchObject({ label: 'Jira', configured: true, connected: false });
    expect(by('jira').services.map((s) => [s.id, s.writes])).toEqual([['issues', false], ['issues_write', true]]);
    expect(by('linear').services.map((s) => s.id)).toEqual(['issues', 'issues_write']);
    expect(by('githubissues').services.map((s) => [s.id, s.writes])).toEqual([['issues', true]]);
    expect(by('asana').services.map((s) => s.id)).toEqual(['tasks', 'tasks_write']);
  });

  it('asks each tracker for its own scopes, with the separator and the proof it wants, and keeps what the tracker says was granted', async () => {
    await connect(nadia, 'linear', ['issues']);
    expect(fake.consents.at(-1)).toMatchObject({ tracker: 'linear', scopes: ['read'], hasChallenge: false });
    await connect(nadia, 'githubissues');
    expect(fake.consents.at(-1)).toMatchObject({ tracker: 'githubissues', scopes: ['repo'], hasChallenge: true });
    expect(fake.tokenCalls.filter((c) => c.tracker === 'githubissues').at(-1)).toMatchObject({ ok: true, pkce: true });
    await connect(nadia, 'jira', ['issues']);
    expect(fake.consents.at(-1)!.scopes).toEqual(expect.arrayContaining(['offline_access', 'read:me', 'read:jira-work']));
    const list = ListPersonConnectionsResponse.parse((await w.call(nadia, 'GET', '/api/me/connections/providers')).body).providers;
    expect(list.find((p) => p.id === 'linear')).toMatchObject({ connected: true, state: 'ok', accountLabel: nadia.email });
    expect(list.find((p) => p.id === 'githubissues')!.accountLabel).toBe(nadia.email.split('@')[0]);
  });
});

describe('the tools, as a bot that the person asked', () => {
  it('offers only the tools of the services agreed to; a write without its service is refused with plain words', async () => {
    const run = await openRun(bot.botId, nadia.actorId);
    const tools = await listed(run);
    expect(tools).toEqual(expect.arrayContaining(['linear.search_issues', 'linear.read_issue', 'jira.search_issues', 'github_issues.comment']));
    for (const name of ['linear.comment', 'linear.create_issue', 'jira.comment', 'asana.search_tasks']) expect(tools, name).not.toContain(name);
    // a person never connected Asana: a read of it says so in plain words
    expect(await called(run, 'asana.search_tasks', { query: 'launch' })).toMatchObject({ ok: false, code: 'not_connected' });
    // a write waits for a person first (that is the platform order); nothing reaches the tracker meanwhile
    const answer = await called(run, 'linear.comment', { issue: 'ENG-7', text: 'hello' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.writes).toEqual([]);
  });

  it('a read runs as the asker, and the tracker saw the sealed token only as a bearer of this person', async () => {
    const run = await openRun(bot.botId, nadia.actorId);
    const found = await called(run, 'linear.search_issues', { query: 'export' });
    expect(found['issues']).toEqual([expect.objectContaining({ identifier: 'ENG-7' })]);
    expect(fake.calls.filter((c) => c.tracker === 'linear').every((c) => c.authorized)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/access-|refresh-/);
  });

  it('a comment waits for approval with a card that names the tracker and the issue first, then runs once', async () => {
    await connect(nadia, 'linear', ['issues', 'issues_write']);
    const run = await openRun(bot.botId, nadia.actorId);
    const text = 'Please check the export again. '.repeat(30);
    const answer = await called(run, 'linear.comment', { issue: 'ENG-7', text });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.writes).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Linear: comment on ENG-7');
    expect(card.args_preview).toMatchObject({ tracker: 'Linear', target: 'ENG-7', textChars: text.length });
    expect(String(card.args_preview['text']).length).toBeLessThanOrEqual(300);
    await approve(card.id);
    expect(fake.writes).toEqual([{ tracker: 'linear', kind: 'comment', target: 'ENG-7', account: nadia.email, text }]);
  });

  it('a GitHub issue is opened and closed only after approval, and an invalid id never reaches the tracker', async () => {
    const run = await openRun(bot.botId, nadia.actorId);
    const before = fake.calls.length;
    const bad = await rpc(run, 'tools/call', { name: 'github_issues.read_issue', arguments: { repo: 'acme/..', number: 1 } });
    expect(bad.result!.content![0]!.text).toMatch(/not valid: repo:/);
    expect(fake.calls).toHaveLength(before);

    const created = await called(run, 'github_issues.create_issue', { repo: 'acme/widgets', title: 'Tooltip is cut off', text: 'On the narrow layout.' });
    expect(created).toMatchObject({ code: 'approval_pending' });
    const card = await pendingOf(created);
    expect(card.summary).toBe('GitHub: open an issue in acme/widgets');
    expect(card.args_preview).toMatchObject({ title: 'Tooltip is cut off', text: 'On the narrow layout.' });
    await approve(card.id);
    expect(fake.writes.at(-1)).toMatchObject({ tracker: 'githubissues', kind: 'create', text: 'Tooltip is cut off' });

    // an approved call ends its run, so the next write comes in a new one
    const second = await openRun(bot.botId, nadia.actorId);
    const closingRpc = await rpc(second,'tools/call', { name: 'github_issues.change_status', arguments: { repo: 'acme/widgets', number: 12, status: 'closed' } });
    expect(closingRpc.result?.content, JSON.stringify(closingRpc)).toBeDefined();
    const closing = JSON.parse(closingRpc.result!.content![0]!.text) as Record<string, unknown>;
    expect((await pendingOf(closing)).summary).toBe('GitHub: close acme/widgets#12');
    expect(fake.data.github.issues.find((i) => i.number === 12)!.state).toBe('open');
    await approve((await pendingOf(closing)).id);
    expect(fake.data.github.issues.find((i) => i.number === 12)!.state).toBe('closed');
  });

  it('a sign-in that Linear says is lost inside its answer is renewed once and the call goes on; a second refusal says so in our words', async () => {
    const run = await openRun(bot.botId, nadia.actorId);
    const renewals = () => fake.tokenCalls.filter((c) => c.tracker === 'linear' && c.grant === 'refresh_token' && c.ok).length;
    const before = renewals();
    fake.failNextGraphql('authentication error', 1);
    expect(await called(run, 'linear.search_issues', { query: 'export' })).toMatchObject({ ok: true });
    expect(renewals()).toBe(before + 1);
    fake.failNextGraphql('authentication error', 2);
    const refused = await called(run, 'linear.search_issues', { query: 'export' });
    expect(refused).toMatchObject({ ok: false, code: 'provider_refused' });
    expect(JSON.stringify(refused)).not.toMatch(/SECRET|ENG-7/);
    expect(renewals()).toBe(before + 2);
    fake.failNextGraphql('ratelimited', 1);
    expect(await called(run, 'linear.search_issues', { query: 'export' })).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });

  it('a Jira card names the site the change goes to, after the issue and the act, and the call uses the same site', async () => {
    await connect(nadia, 'jira', ['issues', 'issues_write']);
    const run = await openRun(bot.botId, nadia.actorId);
    const answer = await called(run, 'jira.comment', { key: 'ENG-101', text: 'Looking into it.' });
    expect(answer).toMatchObject({ code: 'approval_pending' });
    const card = await pendingOf(answer);
    expect(card.summary).toMatch(/^Jira: comment on ENG-101 on kahf \(127\.0\.0\.1:\d+\)$/);
    expect(card.summary.length).toBeLessThanOrEqual(300);
    expect(card.args_preview).toMatchObject({ tracker: 'Jira', target: 'ENG-101', site: expect.stringMatching(/^kahf \(127\.0\.0\.1:\d+\)$/) });
    await approve(card.id);
    expect(fake.writes.at(-1)).toMatchObject({ tracker: 'jira', kind: 'comment', target: 'ENG-101', text: 'Looking into it.' });
  });
});
