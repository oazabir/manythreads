import { ListConnectorHealthResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { healthProblem } from '../src/admin-routes.ts';
import { countToolCall, isFailedAnswer } from '../src/usage.ts';
import { personas, startAdminWorld, TEAM_IDS, WS, type AdminWorld } from './admin-world.ts';

// Bundle D, P16-11 (decision D31): every tool call through a connection is counted by day and connection (calls and failures, nothing else), and the admin health route sums the
// last seven days. A real server, a fake Google and the real MCP gateway.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, tariq, lena, rafi, priya } = personas;
const ENG = TEAM_IDS.Engineering;

let x: AdminWorld;
beforeAll(async () => {
  x = await startAdminWorld();
}, 180_000);
afterAll(async () => {
  await x?.close();
});

describe('the small rules', () => {
  it('a failed answer is exactly { ok: false }', () => {
    expect(isFailedAnswer({ ok: false, code: 'not_found' })).toBe(true);
    expect(isFailedAnswer({ ok: true })).toBe(false);
    expect(isFailedAnswer('x')).toBe(false);
    expect(isFailedAnswer(null)).toBe(false);
  });

  it('the health sentence names the worst problem in plain words and stays quiet for a healthy provider', () => {
    expect(healthProblem({ needsReconnect: 1, calls7d: 0, failures7d: 0 })).toBe('1 person has to sign in again.');
    expect(healthProblem({ needsReconnect: 3, calls7d: 100, failures7d: 90 })).toBe('3 people have to sign in again.');
    expect(healthProblem({ needsReconnect: 0, calls7d: 10, failures7d: 6 })).toMatch(/More than half/);
    expect(healthProblem({ needsReconnect: 0, calls7d: 10, failures7d: 5 })).toBeNull();
    expect(healthProblem({ needsReconnect: 0, calls7d: 4, failures7d: 4 })).toBeNull();
    expect(healthProblem({ needsReconnect: 0, calls7d: 0, failures7d: 0 })).toBeNull();
  });

  it('a counter that cannot be written never fails the call that asked for it', async () => {
    const broken = { db: { system: () => Promise.reject(new Error('database is down')) } };
    await expect(countToolCall(broken, { workspaceId: WS, connectionId: '00000000-0000-7000-8000-000000000001', failed: true })).resolves.toBeUndefined();
  });
});

describe('counting calls through the gateway', () => {
  const GOOGLE_TOOLS = ['google_drive.search', 'google_drive.read'];
  let bot: { botId: string; actorId: string };
  const rows = (connectionId: string) =>
    x.sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.connection_usage_daily WHERE connection_id = $1', [connectionId])).rows);

  beforeAll(async () => {
    x.fake.account(nadia.email).files = [{ id: 'nadia-plan', name: 'Hiring plan', mimeType: 'text/plain', modified: '2026-10-29T10:00:00.000Z', text: 'Only Nadia keeps the hiring plan.' }];
    await x.connect(nadia, 'google', ['drive']);
    bot = await x.makeBot(ENG, 'usage-bot', [{ connection: 'person:*', tools: GOOGLE_TOOLS }]);
    await x.compile(ENG, bot.botId);
  });

  it('counts a call that worked and a call that did not, per day and connection, with only the two numbers kept', async () => {
    const id = (await x.connectionOf(nadia, 'google'))!.id;
    const run = await x.openRun(bot.botId, ENG, nadia.actorId);
    expect(await x.called(run, 'google_drive.search', { query: 'hiring' })).toMatchObject({ ok: true });
    expect(await x.called(run, 'google_drive.search', { query: 'roadmap' })).toMatchObject({ ok: true });
    expect(await x.called(run, 'google_drive.read', { fileId: 'no-such-file' })).toMatchObject({ ok: false });
    const counted = await rows(id);
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ provider: 'google', calls: 3, failures: 1 });
    // the row holds ids, a provider word, a day and two counts: nothing a call said or read
    expect(Object.keys(counted[0]!).sort()).toEqual(['calls', 'connection_id', 'day', 'failures', 'provider', 'workspace_id']);
  });

  it('a call that never reached a connection counts nothing', async () => {
    const run = await x.openRun(bot.botId, ENG, priya.actorId);
    expect(await x.called(run, 'google_drive.search', { query: 'plan' })).toMatchObject({ ok: false, code: 'not_connected' });
    const n = await x.sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.connection_usage_daily')).rows[0]!.n);
    expect(n).toBe(1);
  });

  it('no token, name or search word is in the counter or in the tool answers it counted', async () => {
    const all = await x.sys(async (tx) => JSON.stringify((await tx.query('SELECT * FROM app.connection_usage_daily')).rows));
    expect(all).not.toMatch(/hiring|roadmap|no-such-file|access-|refresh-/i);
  });

  it('the admin health route sums the last seven days per provider; a lead, a member and a guest are refused', async () => {
    const ok = await x.raw(omar, 'GET', '/api/admin/connections/health');
    expect(ok.status, await ok.clone().text()).toBe(200);
    const body = ListConnectorHealthResponse.parse(await ok.json());
    const google = body.rows.find((r) => r.connector === 'google')!;
    expect(google).toMatchObject({ area: 'connections', people: 1, shared: 0, needsReconnect: 0, calls7d: 3, failures7d: 1, refused7d: {}, problem: null });
    expect(google.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    for (const who of [tariq, nadia, lena]) expect((await x.raw(who, 'GET', '/api/admin/connections/health')).status, who.name).toBe(403);
    expect((await fetch(`${x.w.server.url}/api/admin/connections/health`)).status).toBe(401);
  });

  it('a provider whose people must sign in again, or whose calls mostly fail, says so', async () => {
    await x.connect(rafi, 'microsoft');
    const mine = (await x.connectionOf(rafi, 'microsoft'))!.id;
    await x.sys(async (tx) => {
      await tx.query(`UPDATE app.connection_oauth SET state = 'needs_reconnect' WHERE connection_id = $1`, [mine]);
      for (let i = 0; i < 6; i += 1) await tx.query('SELECT app.connection_usage_bump($1, false)', [mine]);
    });
    const body = ListConnectorHealthResponse.parse(await (await x.raw(omar, 'GET', '/api/admin/connections/health')).json());
    expect(body.rows.find((r) => r.connector === 'microsoft')).toMatchObject({ people: 1, needsReconnect: 1, calls7d: 6, failures7d: 6, problem: '1 person has to sign in again.' });
    await x.sys((tx) => tx.query(`UPDATE app.connection_oauth SET state = 'ok' WHERE connection_id = $1`, [mine]));
    const again = ListConnectorHealthResponse.parse(await (await x.raw(omar, 'GET', '/api/admin/connections/health')).json());
    expect(again.rows.find((r) => r.connector === 'microsoft')!.problem).toMatch(/More than half/);
  });

  it('days older than a week are left out of the sums', async () => {
    const id = (await x.connectionOf(nadia, 'google'))!.id;
    await x.sys((tx) => tx.query(`INSERT INTO app.connection_usage_daily (workspace_id, connection_id, provider, day, calls, failures) VALUES ($1, $2, 'google', (now() AT TIME ZONE 'utc')::date - 9, 50, 10)`, [WS, id]));
    const body = ListConnectorHealthResponse.parse(await (await x.raw(omar, 'GET', '/api/admin/connections/health')).json());
    expect(body.rows.find((r) => r.connector === 'google')).toMatchObject({ calls7d: 3, failures7d: 1 });
  });
});
