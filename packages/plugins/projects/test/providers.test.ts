import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ListProjectsResponse } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, createPersonas, ownerSql, personas, startFakeK8s, startTestServer, type FakeK8s, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A project lives on GitHub, GitLab or the team's own GitLab, and says whose name its commits carry. On a real server and database, with a fake Kubernetes API
// (the pod's Secret) and a fake GitLab: the provider is decided by the address (or chosen for another host), the bot account's token is checked by GitLab
// before it is kept, the Secret's document carries the provider, the bot's login and numeric id and the commit choice, and a change of the choice reaches the
// pod without the token being touched.

const { omar } = personas;
const TOKEN = 'glpat-TestTokenValue0123456789abcdef';
const HOST = 'git.example.org';
const ENV = ['MANYTHREADS_HERMES_PODS_TEST_K8S_URL', 'MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW', 'MANYTHREADS_TEST_GITLAB_API'];
const saved: Record<string, string | undefined> = {};
let server: TestServer;
let k8s: FakeK8s;
let gitlab: Server;
/** Projects of the fake GitLab (by full path) and the access level the bot has on each. */
const levels = new Map<string, number>([['grp/sub/widgets', 30], ['grp/readonly', 20]]);

const parsedDoc = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  gitlab = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['private-token'] !== TOKEN) return json(401, { message: '401 Unauthorized' });
    if (url.pathname === '/user') return json(200, { username: 'deploy-bot', id: 4242 });
    if (url.pathname === '/personal_access_tokens/self') return json(200, { expires_at: '2099-01-31' });
    const m = /^\/projects\/(.+)$/.exec(url.pathname);
    const level = m ? levels.get(decodeURIComponent(m[1]!)) : undefined;
    if (level === undefined) return json(404, { message: '404 Project Not Found' });
    return json(200, { permissions: { project_access: { access_level: level }, group_access: null } });
  });
  await new Promise<void>((r) => gitlab.listen(0, '127.0.0.1', r));
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'] = k8s.url;
  process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = `https://${HOST}/,https://gitlab.com/`;
  process.env['MANYTHREADS_TEST_GITLAB_API'] = `http://127.0.0.1:${(gitlab.address() as AddressInfo).port}`;
  server = await startTestServer();
  await createPersonas(server.db);
}, 180_000);

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await server?.close();
  await new Promise<void>((r) => (gitlab ? gitlab.close(() => r()) : r()));
  await k8s?.stop();
});

const SECRET = 'manythreads-bots/hermes-engineering-push';
const create = (body: unknown) => call('POST', '/api/teams/engineering/projects', body);
const list = async () => ListProjectsResponse.parse((await call('GET', '/api/teams/engineering/projects')).body).items;
const dbText = async (): Promise<string> => JSON.stringify([await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.projects'), await ownerSql(server.db.ownerUrl, 'SELECT payload FROM app.events')]);

describe('which provider a project is on', () => {
  it('decides by the address for github.com and gitlab.com, and asks for a choice for any other host', async () => {
    const gh = await create({ name: 'on-github', repoUrl: 'https://github.com/acme/widgets' });
    expect(gh.status, gh.text).toBe(201);
    expect((gh.body['project'] as Record<string, unknown>)).toMatchObject({ provider: 'github', commitAs: 'bot' });
    const gl = await create({ name: 'on-gitlab', repoUrl: 'https://gitlab.com/grp/sub/widgets', commitAs: 'requester' });
    expect(gl.status, gl.text).toBe(201);
    expect((gl.body['project'] as Record<string, unknown>)).toMatchObject({ provider: 'gitlab', commitAs: 'requester' });

    const custom = { name: 'own-gitlab', repoUrl: `https://${HOST}/grp/sub/widgets` };
    expect((await create(custom)).status).toBe(400);
    const chosen = await create({ ...custom, provider: 'gitlab' });
    expect(chosen.status, chosen.text).toBe(201);
    expect((chosen.body['project'] as Record<string, unknown>)).toMatchObject({ provider: 'gitlab' });
  });

  it('refuses a provider that contradicts the address, and an address that does not fit the provider', async () => {
    expect((await create({ name: 'wrong-1', repoUrl: 'https://github.com/acme/widgets', provider: 'gitlab' })).status).toBe(400);
    expect((await create({ name: 'wrong-2', repoUrl: 'https://gitlab.com/solo', provider: 'gitlab' })).status).toBe(400);
    // a GitHub address has exactly <owner>/<repo>: a nested path is no GitHub repository
    expect((await create({ name: 'wrong-3', repoUrl: `https://${HOST}/a/b/c`, provider: 'github' })).status).toBe(400);
  });
});

describe('the bot account of a GitLab project', () => {
  const path = async (name: string) => `/api/teams/engineering/projects/${(await list()).find((p) => p.name === name)!.id}`;

  it('is checked by GitLab, kept in the pod with its provider, login, id and the commit choice, and the choice can change without the token', async () => {
    const set = await call('PUT', `${await path('own-gitlab')}/push-credential`, { username: 'Deploy-Bot', token: TOKEN });
    expect(set.status, set.text).toBe(200);
    const row = (await list()).find((p) => p.name === 'own-gitlab')!;
    expect(row).toMatchObject({ provider: 'gitlab', pushUsername: 'deploy-bot', pushCredentialStatus: 'ok', commitAs: 'bot' });
    expect(row.pushCredentialExpiresAt).toMatch(/^2099-01-31/);
    const doc = parsedDoc(k8s.secrets.get(SECRET)!.data!['own-gitlab']!);
    expect(doc).toMatchObject({ origin: `https://${HOST}/grp/sub/widgets`, token: TOKEN, provider: 'gitlab', login: 'deploy-bot', userId: '4242', commitAs: 'bot' });

    const changed = await call('PATCH', await path('own-gitlab'), { commitAs: 'requester' });
    expect(changed.status, changed.text).toBe(200);
    const after = parsedDoc(k8s.secrets.get(SECRET)!.data!['own-gitlab']!);
    expect(after).toMatchObject({ token: TOKEN, commitAs: 'requester', userId: '4242' });
    expect((await list()).find((p) => p.name === 'own-gitlab')).toMatchObject({ commitAs: 'requester', pushCredentialStatus: 'ok' });
    expect(await dbText()).not.toContain(TOKEN);
  });

  it('tests the stored token against GitLab', async () => {
    const r = await call('POST', `${await path('own-gitlab')}/push-credential/test`);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ok: true, login: 'deploy-bot' });
  });

  it('refuses a token of another account, one without the Developer role, a project the bot cannot see and a token GitLab turns down — keeping nothing', async () => {
    const before = JSON.stringify(k8s.secrets.get(SECRET)?.data);
    const other = await call('PUT', `${await path('on-gitlab')}/push-credential`, { username: 'someone-else', token: TOKEN });
    expect(other.status).toBe(400);
    expect(other.text).toMatch(/different GitLab account/);
    // a project the fake GitLab does not know: the bot cannot see it
    expect((await create({ name: 'hidden-gitlab', repoUrl: 'https://gitlab.com/grp/hidden' })).status).toBe(201);
    const invisible = await call('PUT', `${await path('hidden-gitlab')}/push-credential`, { username: 'deploy-bot', token: TOKEN });
    expect(invisible.status).toBe(400);
    const bad = await call('PUT', `${await path('own-gitlab')}/push-credential`, { username: 'deploy-bot', token: 'glpat-NotTheRightToken0123456789' });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/GitLab refused/);
    levels.set('grp/sub/widgets', 20);
    const reporter = await call('PUT', `${await path('own-gitlab')}/push-credential`, { username: 'deploy-bot', token: TOKEN });
    expect(reporter.status).toBe(400);
    expect(reporter.text).toMatch(/Developer/);
    levels.set('grp/sub/widgets', 30);
    expect(JSON.stringify(k8s.secrets.get(SECRET)?.data)).toBe(before);
  });

  it('keeps a GitLab project out of owner sharing, and drops the token (and the bot id) when the provider changes', async () => {
    const shared = await call('PUT', `${await path('own-gitlab')}/push-credential`, { username: 'deploy-bot', token: TOKEN, shareWithOwner: true });
    expect(shared.status).toBe(400);
    const moved = await call('PATCH', await path('own-gitlab'), { provider: 'github', repoUrl: `https://${HOST}/acme/widgets` });
    expect(moved.status, moved.text).toBe(200);
    expect((await list()).find((p) => p.name === 'own-gitlab')).toMatchObject({ provider: 'github', pushCredentialSetAt: null, pushUsername: null });
    expect(k8s.secrets.get(SECRET)?.data?.['own-gitlab']).toBeUndefined();
  });
});
