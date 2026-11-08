import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSaas, type FakeSaas, type StandInModule } from '../src/index.ts';
import { call, startReceiver, type Receiver } from './helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

let saas: FakeSaas;
let control: string;
let receiver: Receiver;

beforeAll(async () => {
  saas = await startFakeSaas({
    seedKey: 'control-seed',
    seedGrants: [
      { provider: 'google', email: 'nadia@kahf.example' },
      { provider: 'microsoft', email: 'nadia@kahf.example' },
    ],
  });
  control = saas.control.url;
  receiver = await startReceiver();
});
afterAll(async () => {
  await saas.stop();
  await receiver.close();
});
beforeEach(async () => {
  await call(`${control}/__fake/reset`, { method: 'POST' });
  receiver.received.length = 0;
  receiver.answer = () => ({ status: 200, body: '{}' });
});

const post = (path: string, body: unknown = {}) => call(`${control}/__fake${path}`, { method: 'POST', body });

describe('the control port', () => {
  it('answers health, env and state, and says nothing it should not', async () => {
    expect((await call(`${control}/__fake/health`)).json).toEqual({ ok: true });
    const env = (await call(`${control}/__fake/env`)).json as Record<string, string>;
    expect(env['MANYTHREADS_OAUTH_GOOGLE_FAKE_BASE']).toBe(saas.workspace.url);
    expect(env['MANYTHREADS_OAUTH_JIRA_FAKE_BASE']).toBe(saas.trackers.url);
    expect(env['MANYTHREADS_OAUTH_ZENDESK_FAKE_BASE']).toBe(saas.support.urls.zendesk);
    expect(env['MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE']).toBe(saas.telegram.url);
    expect(env['FAKE_SAAS_CONTROL']).toBe(control);
    expect((await call(`${control}/__fake/nope`)).status).toBe(404);
    expect((await call(`${control}/elsewhere`)).status).toBe(404);
  });

  it('state holds calls, writes and sent Telegram messages, and never a token, a code or a client secret', async () => {
    const google = saas.seedTokens('google', 'nadia@kahf.example');
    const microsoft = saas.seedTokens('microsoft', 'nadia@kahf.example');
    await call(`${saas.workspace.url}/oauth2/v3/userinfo`, { token: google.accessToken });
    await call(`${saas.workspace.url}/calendar/v3/calendars/primary/events`, { token: google.accessToken, body: { summary: 'x', start: { dateTime: '2026-11-09T10:00:00Z' }, end: { dateTime: '2026-11-09T11:00:00Z' } } });
    await fetch(`${saas.workspace.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: google.refreshToken, client_id: saas.workspace.clientId, client_secret: saas.workspace.clientSecret }) });
    await call(`${saas.telegram.url}/bot${saas.telegram.bots[0]!.token}/sendMessage`, { body: { chat_id: 7, text: 'a reply' } });
    const wrong = await call(`${saas.telegram.url}/bot9:wrong/getMe`);
    expect(wrong.status).toBe(401);

    const state = await call(`${control}/__fake/state`);
    const text = state.text;
    expect(state.json.workspace.apiCalls.length).toBeGreaterThan(0);
    expect(state.json.workspace.createdEvents).toHaveLength(1);
    expect(state.json.telegram.sent).toHaveLength(1);
    expect(state.json.telegram.sent[0].text).toBe('a reply');
    expect(state.json.telegram.calls.some((c: { authorized: boolean }) => !c.authorized)).toBe(true);
    for (const secret of [google.accessToken, google.refreshToken, microsoft.accessToken, microsoft.refreshToken, saas.telegram.bots[0]!.token, saas.workspace.clientSecret, saas.trackers.clientSecret, saas.support.clientSecret]) {
      expect(text, 'a secret leaked into /__fake/state').not.toContain(secret);
    }
  });

  it('reset empties what was recorded, restores data and forgets the webhooks sent', async () => {
    await post('/accounts/nadia@kahf.example', { files: [{ id: 'f9', name: 'F9', mimeType: 'text/plain', modified: '2026-11-01T00:00:00Z', text: 'x' }] });
    await post('/send-webhook', { provider: 'generic', url: `${receiver.url}/h`, secret: 's', kind: 'a.b' });
    expect((await call(`${control}/__fake/state`)).json.webhooksSent).toHaveLength(1);
    expect((await post('/reset')).status).toBe(200);
    const state = (await call(`${control}/__fake/state`)).json;
    expect(state.webhooksSent).toEqual([]);
    expect(state.workspace.apiCalls).toEqual([]);
    expect(saas.workspace.account('nadia@kahf.example').files.map((f) => f.id)).not.toContain('f9');
  });

  it('reset restores the tracker and support data a test changed', async () => {
    const jiraBefore = saas.trackers.data.jira.issues.length;
    saas.trackers.data.jira.issues.push({ key: 'ENG-99', summary: 'x', description: '', status: 'To Do', type: 'Bug', assignee: null, comments: [] });
    const zdBefore = saas.support.data.zendesk.tickets.length;
    saas.support.data.zendesk.tickets.length = 0;
    await post('/reset');
    expect(saas.trackers.data.jira.issues).toHaveLength(jiraBefore);
    expect(saas.support.data.zendesk.tickets).toHaveLength(zdBefore);
  });

  it('send-webhook signs a call, posts it to the url and returns the answer without the secret', async () => {
    receiver.answer = () => ({ status: 202, body: '{"ignored":true}' });
    const r = await post('/send-webhook', { provider: 'zendesk', url: `${receiver.url}/hooks/apps/e1`, secret: 'zd-secret-value', kind: 'ticket.created', title: 'Where is my order' });
    expect(r.status).toBe(200);
    expect(r.json.responses[0]).toMatchObject({ status: 202, body: '{"ignored":true}' });
    expect(r.text).not.toContain('zd-secret-value');
    const got = receiver.received[0]!;
    expect(got.headers['x-zendesk-webhook-signature']).toBeDefined();
    expect(got.body).toContain('Where is my order');
    expect((await call(`${control}/__fake/state`)).json.webhooksSent[0]).toMatchObject({ provider: 'zendesk', kind: 'ticket.created', tamper: 'none', target: `${receiver.url}/hooks/apps/e1`, statuses: [202] });
  });

  it('send-webhook: replay posts twice, an unknown provider, kind or tamper is 400, a missing secret is 400', async () => {
    const base = { provider: 'github', url: `${receiver.url}/h`, secret: 's', kind: 'push' };
    expect((await post('/send-webhook', { ...base, tamper: 'replay' })).json.responses).toHaveLength(2);
    expect((await post('/send-webhook', { ...base, provider: 'nope' })).status).toBe(400);
    expect((await post('/send-webhook', { ...base, kind: 'nope' })).status).toBe(400);
    expect((await post('/send-webhook', { ...base, tamper: 'nope' })).status).toBe(400);
    expect((await post('/send-webhook', { ...base, secret: '' })).status).toBe(400);
    expect((await call(`${control}/__fake/send-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: undefined })).status).toBe(400);
  });

  it('telegram/send posts the Update with the secret header set by setWebhook', async () => {
    const token = saas.telegram.bots[0]!.token;
    await call(`${saas.telegram.url}/bot${token}/setWebhook`, { body: { url: `${receiver.url}/hooks/bridges/telegram/a1`, secret_token: 'Hdr_Secret-1' } });
    const r = await post('/telegram/send', { fromUserId: 55, username: 'nadia', text: '/start 12345678' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ delivered: true, responses: [{ status: 200 }] });
    expect(receiver.received[0]!.headers['x-telegram-bot-api-secret-token']).toBe('Hdr_Secret-1');
    const wrong = await post('/telegram/send', { fromUserId: 55, text: 'x', secretHeader: 'wrong' });
    expect(wrong.json.responses).toHaveLength(1);
    expect((await post('/telegram/fail-next', { status: 429, retryAfter: 3, method: 'sendMessage' })).status).toBe(200);
    expect((await call(`${saas.telegram.url}/bot${token}/sendMessage`, { body: { chat_id: 1, text: 'x' } })).json.parameters).toEqual({ retry_after: 3 });
  });

  it('PATCH accounts upserts files, events, pages and mails, trashes and removes files, and sets the calendar sharing', async () => {
    const email = 'rafi@kahf.example';
    const patch = (body: unknown) => call(`${control}/__fake/accounts/${email}`, { method: 'PATCH', body });
    const r = await patch({
      files: [{ id: 'd1', name: 'D1', mimeType: 'text/plain', modified: '2026-11-01T00:00:00Z', text: 't' }, { id: 'd2', name: 'D2', mimeType: 'text/plain', modified: '2026-11-01T00:00:00Z', text: 't' }],
      events: [{ id: 'e1', title: 'E1', start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' }],
      pages: [{ id: 'pg1', title: 'Page 1', blocks: ['x'] }],
      mails: [{ id: 'mail-x', from: 'a@b.test', to: email, subject: 'S', date: 'Fri, 30 Oct 2026 10:12:00 +0000', text: 'body' }],
      shareCalendar: false,
    });
    expect(r.json).toMatchObject({ ok: true, shareCalendar: false });
    const data = saas.workspace.account(email);
    expect(data.files.map((f) => f.id)).toEqual(expect.arrayContaining(['d1', 'd2']));
    expect(data.events.map((e) => e.id)).toContain('e1');
    expect(data.pages.find((p) => p.id === 'pg1')?.lastEdited).toBeDefined();
    expect(data.mails.map((x) => x.id)).toContain('mail-x');
    await patch({ trashFiles: ['d1'], removeFiles: ['d2'] });
    expect(data.files.find((f) => f.id === 'd1')?.trashed).toBe(true);
    expect(data.files.find((f) => f.id === 'd2')).toBeUndefined();
    await patch({ shareCalendar: true });
    expect(data.shareCalendar).toBe(true);
  });

  it('PUT drive permissions changes what the permission list answers and what the change feed reports; wrong shapes are 400, a missing file 404', async () => {
    const email = 'nadia@kahf.example';
    await call(`${control}/__fake/accounts/${email}`, { method: 'PATCH', body: { files: [{ id: 'shared-1', name: 'S1', mimeType: 'text/plain', modified: '2026-11-01T00:00:00Z', text: 't' }] } });
    const token = saas.seedTokens('google', email).accessToken;
    const start = (await call(`${saas.workspace.url}/drive/v3/changes/startPageToken`, { token })).json.startPageToken as string;
    const put = (body: unknown, id = 'shared-1') => call(`${control}/__fake/drive/${id}/permissions`, { method: 'PUT', body });
    expect((await put({ permissions: [{ type: 'anyone' }] })).status).toBe(200);
    expect((await call(`${saas.workspace.url}/drive/v3/files/shared-1/permissions`, { token })).json.permissions.map((p: { type: string }) => p.type)).toEqual(['user', 'anyone']);
    expect((await call(`${saas.workspace.url}/drive/v3/changes?pageToken=${start}`, { token })).json.changes.map((c: { fileId: string }) => c.fileId)).toEqual(['shared-1']);
    expect((await put({ account: email, permissions: [] })).status).toBe(200);
    expect((await put({ permissions: 'anyone' })).status).toBe(400);
    expect((await put({ permissions: [{ type: 'everyone' }] })).status).toBe(400);
    expect((await put({ permissions: [] }, 'missing')).status).toBe(404);
  });

  it('sign-in-as, deny-next-consent, expire-tokens, revoke-refresh-tokens and fail-next reach the stand-ins', async () => {
    await post('/sign-in-as', { email: 'rafi@kahf.example' });
    const consent = await fetch(`${saas.workspace.url}/o/oauth2/v2/auth?client_id=${saas.workspace.clientId}&redirect_uri=http://x.test/cb&response_type=code&state=s1&scope=openid&access_type=offline`, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    await post('/deny-next-consent');
    const denied = await fetch(`${saas.workspace.url}/o/oauth2/v2/auth?client_id=${saas.workspace.clientId}&redirect_uri=http://x.test/cb&response_type=code&state=s2`, { redirect: 'manual' });
    expect(denied.headers.get('location')).toContain('error=access_denied');

    const token = saas.seedTokens('google', 'nadia@kahf.example').accessToken;
    await post('/fail-next', { service: 'workspace', status: 503, count: 2 });
    expect((await call(`${saas.workspace.url}/oauth2/v3/userinfo`, { token })).status).toBe(503);
    expect((await call(`${saas.workspace.url}/oauth2/v3/userinfo`, { token })).status).toBe(503);
    expect((await call(`${saas.workspace.url}/oauth2/v3/userinfo`, { token })).status).toBe(200);
    await post('/fail-next', { service: 'trackers', status: 500 });
    await post('/fail-next', { service: 'support', status: 500 });
    expect((await post('/fail-next', { service: 'nope', status: 500 })).status).toBe(400);

    await post('/expire-tokens');
    expect((await call(`${saas.workspace.url}/oauth2/v3/userinfo`, { token })).status).toBe(401);
    await post('/revoke-refresh-tokens');
  });
});

describe('who may use the control port', () => {
  it('with a control key every call without it is 401, with it the call works', async () => {
    const keyed = await startFakeSaas({ controlKey: 'key-123', only: [] });
    try {
      expect((await call(`${keyed.control.url}/__fake/health`)).status).toBe(401);
      expect((await call(`${keyed.control.url}/__fake/health`, { headers: { 'x-fake-saas-key': 'wrong-123' } })).status).toBe(401);
      expect((await call(`${keyed.control.url}/__fake/health`, { headers: { 'x-fake-saas-key': 'key-123' } })).status).toBe(200);
    } finally {
      await keyed.stop();
    }
  });

  it('refuses to start when NODE_ENV=production (the library and the CLI)', async () => {
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(startFakeSaas({ only: [] })).rejects.toThrow(/NODE_ENV=production/);
    } finally {
      if (before === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before;
    }
    const cli = spawnSync(resolve(ROOT, 'node_modules/.bin/tsx'), [resolve(ROOT, 'tools/fake-saas/src/cli.ts')], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 30_000 });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('refuses to start when NODE_ENV=production');
    expect(cli.stdout).not.toContain('FAKE_SAAS');
  });
});

describe('ports and extension points', () => {
  const freeRun = async (count: number): Promise<number> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const base = 20_000 + Math.floor(Math.random() * 30_000);
      const probes = await Promise.all(
        Array.from({ length: count }, (_, i) => new Promise<boolean>((done) => {
          const s = createServer();
          s.once('error', () => done(false));
          s.listen(base + i, '127.0.0.1', () => s.close(() => done(true)));
        })),
      );
      if (probes.every(Boolean)) return base;
    }
    throw new Error('no free run of ports');
  };

  it('with a base port the first stand-in takes it, the control port is base + 1, the others follow', async () => {
    const base = await freeRun(10);
    const s = await startFakeSaas({ port: base });
    try {
      expect(new URL(s.workspace.url).port).toBe(String(base));
      expect(new URL(s.control.url).port).toBe(String(base + 1));
      expect(new URL(s.trackers.url).port).toBe(String(base + 2));
      expect(Object.values(s.support.urls).map((u) => Number(new URL(u).port))).toEqual([base + 3, base + 4, base + 5, base + 6]);
      expect(new URL(s.telegram.url).port).toBe(String(base + 7));
    } finally {
      await s.stop();
    }
  });

  it('the public host is what the addresses say while the bind is wide', async () => {
    const s = await startFakeSaas({ host: '0.0.0.0', publicHost: 'stand-in.test' });
    try {
      expect(s.workspace.url).toMatch(/^http:\/\/stand-in\.test:\d+$/);
      expect(s.control.url).toMatch(/^http:\/\/stand-in\.test:\d+$/);
      expect(s.telegram.url).toMatch(/^http:\/\/stand-in\.test:\d+$/);
      expect(Object.values(s.support.urls).every((u) => u.startsWith('http://stand-in.test:'))).toBe(true);
      expect(s.trackers.env()['MANYTHREADS_OAUTH_JIRA_FAKE_BASE']).toMatch(/^http:\/\/stand-in\.test:/);
    } finally {
      await s.stop();
    }
  });

  it('a module added to the list gets a port, its env in env(), its state, and its control actions at /__fake/<id>/...', async () => {
    let reset = 0;
    const extra: StandInModule = {
      id: 'confluence',
      async start() {
        return {
          id: 'confluence',
          api: {},
          urls: { url: 'http://127.0.0.1:1' },
          env: () => ({ MANYTHREADS_OAUTH_CONFLUENCE_FAKE_BASE: 'http://127.0.0.1:1' }),
          state: () => ({ pages: 3 }),
          reset: () => void reset++,
          control: async (r) => (r.method === 'POST' && r.path === '/page' ? { status: 201, body: { got: r.body, query: r.query.get('q') } } : null),
          stop: async () => undefined,
        };
      },
    };
    const s = await startFakeSaas({ only: [extra] });
    try {
      expect(s.env()['MANYTHREADS_OAUTH_CONFLUENCE_FAKE_BASE']).toBe('http://127.0.0.1:1');
      expect((await call(`${s.control.url}/__fake/state`)).json.confluence).toEqual({ pages: 3 });
      const r = await call(`${s.control.url}/__fake/confluence/page?q=1`, { method: 'POST', body: { a: 1 } });
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ got: { a: 1 }, query: '1' });
      expect((await call(`${s.control.url}/__fake/confluence/other`, { method: 'POST', body: {} })).status).toBe(404);
      await call(`${s.control.url}/__fake/reset`, { method: 'POST' });
      expect(reset).toBe(1);
    } finally {
      await s.stop();
    }
  });

  it('the registry lists each stand-in once, workspace first, in the order the ports are handed out', async () => {
    const { PROVIDER_MODULES } = await import('../src/providers/registry.ts');
    const ids = PROVIDER_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 4)).toEqual(['workspace', 'trackers', 'support', 'telegram']);
  });
});

describe('startOutsideSaas', () => {
  let outside: Awaited<ReturnType<typeof import('../../../e2e/fixtures/outside.ts').startOutsideSaas>> | undefined;
  afterEach(async () => {
    await outside?.stop();
    outside = undefined;
  });

  it('starts fake-saas and the fake GitHub, signs consents in as the account, and hands the server its variables', async () => {
    const { startOutsideSaas, startOutside } = await import('../../../e2e/fixtures/outside.ts');
    expect(typeof startOutside).toBe('function');
    outside = await startOutsideSaas({ account: 'omar@kahf.example' });
    expect(outside.env['MANYTHREADS_OAUTH_GOOGLE_FAKE_BASE']).toBe(outside.saas.workspace.url);
    expect(outside.env['MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE']).toBe(outside.saas.telegram.url);
    expect(outside.env['MANYTHREADS_TEST_GITHUB_API']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(outside.env['FAKE_SAAS_CONTROL']).toBe(outside.control);
    expect(outside.google).toBe(outside.saas.workspace);
    expect(outside.google.account('omar@kahf.example').files.length).toBeGreaterThan(0);
    expect((await call(`${outside.control}/__fake/health`)).status).toBe(200);
  });
});
