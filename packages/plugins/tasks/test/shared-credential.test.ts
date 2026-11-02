import { ListProjectsResponse, Project } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startFakeGithub, startFakeK8s, startTestServer, type FakeGithub, type FakeK8s, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// One GitHub token for every project of an owner, and what happens when GitHub stops accepting a stored token, on a real server and database with a
// fake Kubernetes API (the pod's Secret) and a fake GitHub: the token is kept once, each project only points at it, a 401 turns every project on it
// into "token needs replacing" and marks the pod so the bots stop trying. (The pull request sync's own handling of a refused token is in pull-request.test.ts.)

const { omar } = personas;
const TOKEN = 'github_pat_TestTokenValue0123456789abcdef';
const ENV = ['MANYTHREADS_HERMES_PODS_TEST_K8S_URL', 'MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW', 'MANYTHREADS_TEST_GITHUB_API'];
const saved: Record<string, string | undefined> = {};
let server: TestServer;
let gh: FakeGithub;
let k8s: FakeK8s;
/** Repositories of the fake GitHub the token cannot write to (the tests change it while the server runs). */
const readOnly: string[] = ['tools'];

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
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', readOnlyRepos: readOnly });
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'] = k8s.url;
  process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/acme/';
  process.env['MANYTHREADS_TEST_GITHUB_API'] = gh.url;
  server = await startTestServer();
  await createPersonas(server.db);
  expect((await call('POST', '/api/teams/engineering/projects', { name: 'widgets', repoUrl: 'https://github.com/acme/widgets' })).status).toBe(201);
}, 180_000);

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await server?.close();
  await gh?.stop();
  await k8s?.stop();
});

const dbText = async (): Promise<string> =>
  JSON.stringify([await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.projects'), await ownerSql(server.db.ownerUrl, 'SELECT payload FROM app.events')]);

describe('one token for every project of an owner, and a token GitHub stops accepting', () => {
  const OWNER_KEY = 'manythreads-bots/hermes-engineering-push';
  const OWNER_DOC = '_owner.github.com.acme';
  const idOf = async (name: string): Promise<string> => {
    const list = ListProjectsResponse.parse((await call('GET', '/api/teams/engineering/projects')).body).items;
    return list.find((p) => p.name === name)!.id;
  };
  const pathOf = async (name: string) => `/api/teams/engineering/projects/${await idOf(name)}/push-credential`;
  const rowOf = async (name: string) => ListProjectsResponse.parse((await call('GET', '/api/teams/engineering/projects')).body).items.find((p) => p.name === name)!;
  const keys = () => Object.keys(k8s.secrets.get(OWNER_KEY)?.data ?? {}).sort();
  const doc = (name: string) => parsedDoc(k8s.secrets.get(OWNER_KEY)!.data![name]!);
  const checks = (): number => server.logs.filter((l) => /projects credential check: \d+ asked/.test((JSON.parse(l) as { msg?: string }).msg ?? '')).length;
  async function runCheck(): Promise<void> {
    const before = checks();
    await ownerSql(server.db.ownerUrl, `SELECT (app.enqueue_job('projects.credential-check', '{}'::jsonb, NULL, NULL)).id`);
    await ownerSql(server.db.ownerUrl, `SELECT pg_notify('manythreads_jobs', 'projects.credential-check')`);
    const deadline = Date.now() + 20_000;
    while (checks() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(checks(), 'the credential check ran').toBeGreaterThan(before);
  }

  it('keeps the token once for the owner, connects the owner’s other projects that it can write to, and names the ones it cannot', async () => {
    for (const [name, repoUrl] of [['gadgets', 'https://github.com/acme/gadgets'], ['tools', 'https://github.com/acme/tools'], ['elsewhere2', 'https://github.com/acme/elsewhere2']] as const) {
      expect((await call('POST', '/api/teams/engineering/projects', { name, repoUrl })).status).toBe(201);
    }
    // not under acme: never asked about, never touched
    await ownerSql(server.db.ownerUrl, `UPDATE app.projects SET repo_url = 'https://github.com/zed/other' WHERE name = 'elsewhere2'`);
    const set = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({ alsoConnected: ['gadgets'], notConnected: ['tools'], keptOwn: [] });
    expect(Project.parse((set.body as { project: unknown }).project).pushCredentialShared).toBe(true);
    // one document holds the token; each project only points at it
    expect(keys()).toEqual([OWNER_DOC, 'gadgets', 'widgets']);
    expect(doc(OWNER_DOC)).toMatchObject({ token: TOKEN });
    for (const name of ['widgets', 'gadgets']) {
      expect(doc(name)).toMatchObject({ via: OWNER_DOC, origin: `https://github.com/acme/${name}` });
      expect(doc(name)).not.toHaveProperty('token');
      expect(await rowOf(name)).toMatchObject({ pushCredentialShared: true, pushCredentialStatus: 'ok', pushUsername: 'octocat' });
    }
    for (const name of ['tools', 'elsewhere2']) expect(await rowOf(name)).toMatchObject({ pushCredentialShared: false, pushCredentialSetAt: null });
    expect(set.text).not.toContain(TOKEN);
    expect(await dbText()).not.toContain(TOKEN);
    expect(server.logs.join('\n')).not.toContain(TOKEN);
    // the project this token cannot write to is refused on its own, whether or not the box is ticked
    expect((await call('PUT', await pathOf('tools'), { username: 'octocat', token: TOKEN, shareWithOwner: true })).status).toBe(400);
  });

  it('turns every project on the token into "needs replacing" when GitHub answers 401, asks GitHub once for the lot, and marks the token in the pod', async () => {
    gh.calls.length = 0;
    gh.failNext(401, {}, 1);
    await runCheck();
    expect(gh.calls.filter((c) => c.path === '/user').length).toBe(1);
    for (const name of ['widgets', 'gadgets']) expect(await rowOf(name)).toMatchObject({ pushCredentialStatus: 'needs_replacing' });
    expect(doc(OWNER_DOC)).toMatchObject({ refused: true, token: TOKEN });
    expect(doc('widgets')).not.toHaveProperty('refused');
    // and it stops trying: another run asks GitHub nothing
    const asked = gh.calls.length;
    await ownerSql(server.db.ownerUrl, `SELECT (app.enqueue_job('projects.credential-check', '{}'::jsonb, NULL, NULL)).id`);
    await ownerSql(server.db.ownerUrl, `SELECT pg_notify('manythreads_jobs', 'projects.credential-check')`);
    await new Promise((r) => setTimeout(r, 1500));
    expect(gh.calls.length).toBe(asked);
    expect(server.logs.join('\n')).not.toContain(TOKEN);
  });

  it('saving a new token for one project replaces the owner’s token for all, clears the refusal and the status', async () => {
    const set = await call('PUT', await pathOf('gadgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({ alsoConnected: ['widgets'], notConnected: ['tools'] });
    expect(doc(OWNER_DOC)).not.toHaveProperty('refused');
    for (const name of ['widgets', 'gadgets']) expect(await rowOf(name)).toMatchObject({ pushCredentialStatus: 'ok', pushCredentialShared: true });
  });

  it('the test button asks about this project and turns the others on the same token over too', async () => {
    gh.failNext(401, {}, 1);
    const tested = await call('POST', `${await pathOf('widgets')}/test`);
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toMatchObject({ ok: false });
    for (const name of ['widgets', 'gadgets']) expect(await rowOf(name)).toMatchObject({ pushCredentialStatus: 'needs_replacing' });
    expect(doc(OWNER_DOC)).toMatchObject({ refused: true });
    expect((await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN })).status).toBe(200);
    // that save was for widgets alone: it leaves the owner token, which gadgets still points at
    expect(doc('widgets')).toMatchObject({ token: TOKEN });
    expect(doc('widgets')).not.toHaveProperty('via');
    expect(await rowOf('widgets')).toMatchObject({ pushCredentialShared: false, pushCredentialStatus: 'ok' });
    expect(keys()).toEqual([OWNER_DOC, 'gadgets', 'widgets']);
  });

  it('the owner’s token goes with its last project, and not before', async () => {
    expect((await call('DELETE', await pathOf('widgets'))).status).toBe(200);
    expect(keys()).toEqual([OWNER_DOC, 'gadgets']);
    expect((await call('DELETE', await pathOf('gadgets'))).status).toBe(200);
    expect(k8s.secrets.has(OWNER_KEY)).toBe(false);
    expect(await dbText()).not.toContain(TOKEN);
  });
});

describe('a shared save and the job that checks tokens are careful', () => {
  const OWNER_KEY = 'manythreads-bots/hermes-engineering-push';
  const OWNER_DOC = '_owner.github.com.acme';
  const rows = async () => ListProjectsResponse.parse((await call('GET', '/api/teams/engineering/projects')).body).items;
  const rowOf = async (name: string) => (await rows()).find((p) => p.name === name)!;
  const pathOf = async (name: string) => `/api/teams/engineering/projects/${(await rowOf(name)).id}/push-credential`;
  const doc = (name: string) => parsedDoc(k8s.secrets.get(OWNER_KEY)!.data![name]!);
  const checks = (): number => server.logs.filter((l) => /projects credential check: \d+ asked/.test((JSON.parse(l) as { msg?: string }).msg ?? '')).length;
  async function runCheck(): Promise<void> {
    const before = checks();
    await ownerSql(server.db.ownerUrl, `SELECT (app.enqueue_job('projects.credential-check', '{}'::jsonb, NULL, NULL)).id`);
    await ownerSql(server.db.ownerUrl, `SELECT pg_notify('manythreads_jobs', 'projects.credential-check')`);
    const deadline = Date.now() + 20_000;
    while (checks() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(checks(), 'the credential check ran').toBeGreaterThan(before);
  }
  const updates = async (projectId: string): Promise<number> =>
    (await ownerSql<{ payload: { projectId?: string } }>(server.db.ownerUrl, `SELECT payload FROM app.events WHERE type = 'project.project.updated'`)).filter((r) => r.payload.projectId === projectId).length;
  const clear = async (...names: string[]) => {
    for (const n of names) expect((await call('DELETE', await pathOf(n))).status).toBe(200);
  };

  it('refuses a save that would have to check more than 25 other projects, instead of cutting the list short', async () => {
    for (let i = 0; i < 26; i++) {
      await ownerSql(server.db.ownerUrl, `INSERT INTO app.projects (workspace_id, team_id, name, repo_url) VALUES ($1, $2, $3, $4)`, [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, `bulk-${i}`, `https://github.com/acme/bulk-${i}`]);
    }
    try {
      const res = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
      expect(res.status, res.text).toBe(409);
      expect(res.text).toContain('more than the 25');
      expect(k8s.secrets.has(OWNER_KEY)).toBe(false);
      expect(await rowOf('widgets')).toMatchObject({ pushCredentialSetAt: null });
    } finally {
      await ownerSql(server.db.ownerUrl, `DELETE FROM app.projects WHERE name LIKE 'bulk-%'`);
    }
  });

  it('leaves a project that has a token of its own as it was, and says so', async () => {
    expect((await call('PUT', await pathOf('gadgets'), { username: 'octocat', token: TOKEN })).status).toBe(200);
    const res = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ alsoConnected: [], keptOwn: ['gadgets'], notConnected: ['tools'] });
    expect(doc('gadgets')).toMatchObject({ token: TOKEN });
    expect(doc('gadgets')).not.toHaveProperty('via');
    expect(await rowOf('gadgets')).toMatchObject({ pushCredentialShared: false, pushCredentialStatus: 'ok' });
    expect(await rowOf('widgets')).toMatchObject({ pushCredentialShared: true });
    await clear('widgets', 'gadgets');
    expect(k8s.secrets.has(OWNER_KEY)).toBe(false);
  });

  it('a project the token cannot write to keeps its own mark, a good project stays good, nothing is written twice, and GitHub is asked about the token once', async () => {
    const set = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
    expect(set.body).toMatchObject({ alsoConnected: ['gadgets'] });
    readOnly.push('gadgets'); // the token loses write access to one repository
    try {
      const before = await rowOf('widgets');
      gh.calls.length = 0;
      await runCheck();
      expect(gh.calls.filter((c) => c.path === '/user').length, 'one question about who the token is, for both projects').toBe(1);
      expect(await rowOf('widgets')).toMatchObject({ pushCredentialStatus: 'ok', updatedAt: before.updatedAt });
      expect(await rowOf('gadgets')).toMatchObject({ pushCredentialStatus: 'needs_replacing' });
      expect(doc(OWNER_DOC)).not.toHaveProperty('refused'); // the token itself is fine
      const gadgets = (await rowOf('gadgets')).id;
      const events = await updates(gadgets);
      // again, and the test button of the good project: the other stays marked, and nothing new is written
      await runCheck();
      const tested = await call('POST', `${await pathOf('widgets')}/test`);
      expect(tested.body).toMatchObject({ ok: true });
      expect(await rowOf('gadgets')).toMatchObject({ pushCredentialStatus: 'needs_replacing' });
      expect(await rowOf('widgets')).toMatchObject({ pushCredentialStatus: 'ok', updatedAt: before.updatedAt });
      expect(await updates(gadgets)).toBe(events);
    } finally {
      readOnly.pop();
    }
  });

  it('asks GitHub before believing a refusal marked in the pod: a token GitHub accepts is cleared and stays good', async () => {
    k8s.secrets.get(OWNER_KEY)!.data![OWNER_DOC] = Buffer.from(JSON.stringify({ ...doc(OWNER_DOC), refused: true })).toString('base64');
    gh.calls.length = 0;
    await runCheck();
    expect(gh.calls.some((c) => c.path === '/user')).toBe(true);
    expect(doc(OWNER_DOC)).not.toHaveProperty('refused');
    expect(await rowOf('widgets')).toMatchObject({ pushCredentialStatus: 'ok' });
    // the same mark with GitHub answering 401 is a refusal: the owner's projects are marked and the mark stays
    k8s.secrets.get(OWNER_KEY)!.data![OWNER_DOC] = Buffer.from(JSON.stringify({ ...doc(OWNER_DOC), refused: true })).toString('base64');
    gh.failNext(401, {}, 1);
    await runCheck();
    expect(await rowOf('widgets')).toMatchObject({ pushCredentialStatus: 'needs_replacing' });
    expect(doc(OWNER_DOC)).toMatchObject({ refused: true });
    await clear('widgets', 'gadgets');
  });

  it('does not send a token to an address this server may not call', async () => {
    expect((await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN })).status).toBe(200);
    const was = process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'];
    process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/someone-else/';
    try {
      gh.calls.length = 0;
      await runCheck();
      expect(gh.calls).toEqual([]);
      expect(await rowOf('widgets')).toMatchObject({ pushCredentialStatus: 'ok' });
    } finally {
      process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = was;
    }
    await clear('widgets');
  });

  it('changes the pod and the rows together: a Secret that cannot be written leaves both as they were, then a retry drops the project the token cannot write to', async () => {
    expect((await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true })).status).toBe(200);
    const secretBefore = JSON.stringify(k8s.secrets.get(OWNER_KEY)!.data);
    const rowsBefore = JSON.stringify((await rows()).map((p) => [p.name, p.pushCredentialSetAt, p.pushCredentialShared, p.updatedAt]));
    readOnly.push('gadgets');
    try {
      k8s.failNext(10);
      const failed = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
      k8s.failNext(0);
      expect(failed.status, failed.text).toBe(409);
      expect(JSON.stringify(k8s.secrets.get(OWNER_KEY)!.data)).toBe(secretBefore);
      expect(JSON.stringify((await rows()).map((p) => [p.name, p.pushCredentialSetAt, p.pushCredentialShared, p.updatedAt]))).toBe(rowsBefore);
      const retry = await call('PUT', await pathOf('widgets'), { username: 'octocat', token: TOKEN, shareWithOwner: true });
      expect(retry.status, retry.text).toBe(200);
      expect(retry.body).toMatchObject({ alsoConnected: [], notConnected: ['gadgets', 'tools'] });
      expect(Object.keys(k8s.secrets.get(OWNER_KEY)!.data!).sort()).toEqual([OWNER_DOC, 'widgets']);
      expect(await rowOf('gadgets')).toMatchObject({ pushCredentialSetAt: null, pushCredentialShared: false });
    } finally {
      readOnly.pop();
    }
    await clear('widgets');
    expect(k8s.secrets.has(OWNER_KEY)).toBe(false);
  });
});
