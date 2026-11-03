import { createAppPool, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { CreateConnectionResponse, McpRunMintResponse, PutConnectionCredentialResponse, UpdateConnectionResponse } from '@manythreads/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeK8s, type FakeK8s } from '../../../test-utils/src/fake-k8s.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { compileBot } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';

// P8-03/P8-04: setting a connection up through the routes (admin only, credentials sealed and never returned) and a bot using a cluster connection through the
// MCP endpoint: the cluster hands out a short-lived token for the call, the bot sees the answer and none of the credentials. The cluster is a local double.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
const BOOTSTRAP = 'bootstrap-token-SENTINEL-77c1';

let w: RepoWorld;
let sysPool: pg.Pool;
let k8s: FakeK8s;

const declared: Declared = new Map([
  ['email.read', { destructive: false }],
  ['ssh.run', { destructive: false }],
  ['kubernetes.get', { destructive: false }],
]);
const ids = new Map<string, string>();
const mk = (who: typeof omar, slug: string, kind: string, name: string, extra: Record<string, unknown> = {}) =>
  w.call<{ connection?: { id: string } }>(who, 'POST', '/api/teams/engineering/connections', { slug, kind, name, ...extra }).then((res) => {
    if (res.body.connection) ids.set(slug, res.body.connection.id);
    return res;
  });
const put = async (who: typeof omar, slug: string, creds: Record<string, string>) => {
  let last = await w.call(who, 'PUT', `/api/connections/${ids.get(slug)}/credentials/${Object.keys(creds)[0]}`, { value: Object.values(creds)[0] });
  for (const [name, value] of Object.entries(creds).slice(1)) last = await w.call(who, 'PUT', `/api/connections/${ids.get(slug)}/credentials/${name}`, { value });
  return last;
};
const patch = (who: typeof omar, slug: string, body: Record<string, unknown>) => w.call(who, 'PATCH', `/api/connections/${ids.get(slug)}`, body);
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

async function makeBot(slug: string, connections: unknown): Promise<{ botId: string; actorId: string }> {
  return sys(async (tx) => {
    const botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
         VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
        [omar.workspaceId, ENG, slug, JSON.stringify(connections)],
      )
    ).rows[0]!.id;
    const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, botId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actorId, omar.workspaceId]);
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
    const { run, token } = await service.open({ botId, teamId: ENG, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId });
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
const called = async (run: McpRunMintResponse, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  JSON.parse((await rpc(run, 'tools/call', { name, arguments: args })).result!.content![0]!.text) as Record<string, unknown>;
const listed = async (run: McpRunMintResponse): Promise<string[]> => ((await rpc(run, 'tools/list')).result?.tools ?? []).map((t) => t.name);

beforeAll(async () => {
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  k8s = await startFakeK8s();
  k8s.pods.push({ metadata: { name: 'api-7d9', namespace: 'apps', managedFields: [] }, status: { phase: 'Running' } });
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  await k8s?.stop();
  await w?.close();
});

describe('setting a connection up', () => {
  it('only a workspace admin can; the answer has no credential; a kind the server does not know is refused', async () => {
    expect((await mk(nadia, 'cluster', 'kubernetes', 'Prod cluster')).status).toBe(403);
    expect((await mk(omar, 'x', 'nonsense', 'X')).status).toBe(400);
    expect((await mk(omar, 'x', 'kubernetes', 'X', { extra: 1 })).status).toBe(400);
    const made = await mk(omar, 'cluster', 'kubernetes', 'Prod cluster', { environment: 'production' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(CreateConnectionResponse.parse(made.body).connection).toMatchObject({ slug: 'cluster', kind: 'kubernetes', status: 'disabled', hasCredentials: false, scope: 'team' });
    expect((await mk(omar, 'cluster', 'kubernetes', 'again')).status).toBe(409);
  });

  it('credentials are sealed and never come back; names the kind does not take are refused; a non-admin cannot', async () => {
    expect((await put(nadia, 'cluster', { token: BOOTSTRAP })).status).toBe(403);
    const stray = await w.call(omar, 'PUT', `/api/connections/${ids.get('cluster')}/credentials/password`, { value: BOOTSTRAP });
    expect(stray.status).toBe(400);
    expect(JSON.stringify(stray.body)).not.toContain(BOOTSTRAP);
    const done = await put(omar, 'cluster', { api_url: k8s.url, token: BOOTSTRAP, service_account: 'bot-reader', namespace: 'apps' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(PutConnectionCredentialResponse.parse(done.body).connection).toMatchObject({ hasCredentials: true, status: 'disabled' });
    expect(JSON.stringify(done.body)).not.toContain(BOOTSTRAP);
    const stored = await sys(async (tx) => (await tx.query<{ ciphertext: Buffer }>(`SELECT s.ciphertext FROM app.connection_secrets cs JOIN app.secrets s ON s.id = cs.secret_id WHERE cs.name = 'token'`)).rows);
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(row.ciphertext.toString('latin1')).not.toContain('SENTINEL');
    const on = await patch(omar, 'cluster', { status: 'enabled' });
    expect(on.status).toBe(200);
    expect(UpdateConnectionResponse.parse(on.body).connection.status).toBe('enabled');
    expect((await patch(nadia, 'cluster', { status: 'disabled' })).status).toBe(403);
  });
});

describe('a bot reads a cluster through the connection', () => {
  it('is offered kubernetes.get when granted, gets an answer made with a token minted for the call, and never sees the credentials', async () => {
    const bot = await makeBot('cluster-reader', [{ connection: 'cluster', tools: ['kubernetes.get'] }]);
    await sys((tx) => compileBot(tx as unknown as PluginTx, declared, { workspaceId: omar.workspaceId, teamId: ENG, botId: bot.botId }).then(() => undefined));
    const run = await openRun(bot.botId, nadia.actorId);
    expect(await listed(run)).toContain('kubernetes.get');
    expect(await listed(run)).not.toContain('ssh.run');

    const before = k8s.tokenRequests.length;
    const out = await called(run, 'kubernetes.get', { resource: 'pods' });
    expect(out['ok'], JSON.stringify(out)).toBe(true);
    expect(JSON.stringify(out)).toContain('api-7d9');
    expect(JSON.stringify(out)).not.toContain('managedFields');
    expect(JSON.stringify(out)).not.toContain(BOOTSTRAP);
    expect(k8s.tokenRequests.length).toBe(before + 1);
    const request = k8s.tokenRequests.at(-1)!;
    expect(request).toMatchObject({ namespace: 'apps', serviceAccount: 'bot-reader', bearer: `Bearer ${BOOTSTRAP}` });
    expect(request.expirationSeconds).toBeLessThanOrEqual(3600);
    // every call asks again: a token is per task, not kept
    await called(run, 'kubernetes.get', { resource: 'pods' });
    expect(k8s.tokenRequests.length).toBe(before + 2);
    expect(k8s.calls.some((c) => c === 'GET /api/v1/namespaces/apps/pods')).toBe(true);

    // outside the connection's namespaces: refused before the cluster is asked
    const calls = k8s.calls.length;
    const refused = await called(run, 'kubernetes.get', { resource: 'pods', namespace: 'kube-system' });
    expect(refused).toMatchObject({ ok: false, code: 'refused' });
    expect(k8s.calls.length).toBe(calls + 1); // only the token request

    // arguments are checked against the schema the model was shown
    const bad = await rpc(run, 'tools/call', { name: 'kubernetes.get', arguments: { resource: 'secrets' } });
    expect(JSON.stringify(bad)).not.toContain('"ok":true');

    expect(w.server.logs.join('\n')).not.toContain(BOOTSTRAP);
  });

  it('a cluster that stretches token life gives the bot an error and no data', async () => {
    const bot = await makeBot('cluster-reader-2', [{ connection: 'cluster', tools: ['kubernetes.get'] }]);
    await sys((tx) => compileBot(tx as unknown as PluginTx, declared, { workspaceId: omar.workspaceId, teamId: ENG, botId: bot.botId }).then(() => undefined));
    const run = await openRun(bot.botId, nadia.actorId);
    k8s.tokenLifetimeOverride = 30 * 24 * 3600;
    try {
      const out = await called(run, 'kubernetes.get', { resource: 'pods' });
      expect(out).toMatchObject({ ok: false });
      expect(JSON.stringify(out)).not.toContain('api-7d9');
    } finally {
      k8s.tokenLifetimeOverride = null;
    }
  });

  it('a switched-off connection offers nothing', async () => {
    const bot = await makeBot('cluster-reader-3', [{ connection: 'cluster', tools: ['kubernetes.get'] }]);
    await sys((tx) => compileBot(tx as unknown as PluginTx, declared, { workspaceId: omar.workspaceId, teamId: ENG, botId: bot.botId }).then(() => undefined));
    const run = await openRun(bot.botId, nadia.actorId);
    expect((await patch(omar, 'cluster', { status: 'disabled' })).status).toBe(200);
    try {
      expect(await listed(run)).not.toContain('kubernetes.get');
      expect(await called(run, 'kubernetes.get', { resource: 'pods' })).toMatchObject({ ok: false });
    } finally {
      await patch(omar, 'cluster', { status: 'enabled' });
    }
  });
});

describe('a server connection that is not set up', () => {
  it('is offered, and says plainly what is missing instead of running anything', async () => {
    expect((await mk(omar, 'servers', 'ssh', 'Servers')).status).toBe(201);
    expect((await put(omar, 'servers', { user: 'deploy', hosts: 'web1.example.com' })).status).toBe(200);
    expect((await patch(omar, 'servers', { status: 'enabled' })).status).toBe(200);
    const bot = await makeBot('server-runner', [{ connection: 'servers', tools: ['ssh.run'], needsApproval: [] }]);
    await sys((tx) => compileBot(tx as unknown as PluginTx, declared, { workspaceId: omar.workspaceId, teamId: ENG, botId: bot.botId }).then(() => undefined));
    const run = await openRun(bot.botId, nadia.actorId);
    expect(await listed(run)).toContain('ssh.run');
    const out = await called(run, 'ssh.run', { host: 'web1.example.com', command: 'uptime' });
    expect(out).toMatchObject({ ok: false, code: 'not_set_up' });
    expect(String(out['message'])).toMatch(/ca_url/);
    expect(String(out['message'])).not.toContain('deploy');
  });
});

describe('removing a connection', () => {
  it('takes its sealed credentials, the bots’ grants and the broker rows with it', async () => {
    const before = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    const gone = await w.call(omar, 'DELETE', `/api/connections/${ids.get('cluster')}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const after = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    expect(after).toBe(before - 4);
    const grants = await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.connection_grants g JOIN app.actors a ON a.id = g.actor_id WHERE g.tool = 'kubernetes.get'`)).rows.length);
    expect(grants).toBe(0);
    // the broker's rows go when the 'deleted' notice is handled, a moment after the request
    let broker = -1;
    for (let i = 0; i < 100 && broker !== 0; i++) {
      broker = await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.capability_grants WHERE capability = 'kubernetes.get'`)).rows.length);
      if (broker !== 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(broker).toBe(0);
    expect((await w.call(omar, 'DELETE', `/api/connections/${ids.get('cluster')}`)).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', `/api/connections/${ids.get('servers')}`)).status).toBe(403);
  });
});
