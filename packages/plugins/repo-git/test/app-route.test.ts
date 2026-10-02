import { request } from 'node:http';
import { APP_BRIDGE_CLIENT_JS, IssueAppTokenResponse, embeddedAppHeaders } from '@manythreads/shared';
import { ownerSql, personas, seedWorld, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Embedded apps over the real route (PLAN P4-10): the content route `/api/teams/:slug/repo/app/*` and the per-open token that stands in for
// the session cookie (a sandboxed frame has none). A server of its own, with a clock the test can move.

const { omar, nadia, tariq, lena, priya } = personas;
vi.setConfig({ testTimeout: 60_000 });

let server: TestServer;
let skew = 0;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
  await seedWorld(server.db);
}, 180_000);
afterAll(async () => {
  await server?.close();
});

const as = (p: { actorId: string; workspaceId: string } | null): Record<string, string> =>
  p ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }), 'content-type': 'application/json' } : {};
const call = async (who: Parameters<typeof as>[0], method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; headers: Headers; text: string }> => {
  const res = await fetch(`${server.url}${path}`, { method, headers: as(who), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, headers: res.headers, text };
};
/** A GET with no actor at all: what a sandboxed frame sends (no cookie, no header). */
const anonymous = (path: string) => call(null, 'GET', path);
/** The request line as written: a client library would resolve `..` before sending it. */
const raw = (path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(server.url);
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });

const rawFull = (path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(server.url);
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET', headers: as(nadia) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });

const INDEX = '<!doctype html><title>Demo</title><script src="__manythreads.js"></script><script src="js/app.js"></script><p id="x">demo</p>';
const commit = async (who: typeof omar, slug: string, changes: unknown[], message: string) => {
  const res = await call(who, 'POST', `/api/teams/${slug}/repo/commit`, { changes, message });
  expect([200, 201]).toContain(res.status);
};
const put = (path: string, content: string) => ({ op: 'put', path, content });
const issue = async (who: Parameters<typeof as>[0], slug: string, path: string) => call(who, 'POST', `/api/teams/${slug}/repo/app-token`, { path });
const tokenFor = async (slug = 'engineering', path = 'apps/demo', who = nadia): Promise<{ token: string; url: string }> => {
  const res = await issue(who, slug, path);
  expect(res.status).toBe(200);
  return IssueAppTokenResponse.parse(res.body);
};

describe('the app content route', () => {
  it('serves the files of an app folder with their types, a folder as its index.html, and the bridge client', async () => {
    await commit(omar, 'engineering', [put('apps/demo/index.html', INDEX), put('apps/demo/js/app.js', 'document.getElementById("x").textContent = "ready";\n'), put('apps/demo/style.css', 'p{color:red}'), put('apps/other/index.html', '<p>other</p>')], 'Add the demo apps');
    const page = await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/index.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.text).toBe(INDEX);
    // the strict headers ride on every answer under the route
    expect(page.headers.get('content-security-policy')).toBe(embeddedAppHeaders()['content-security-policy']);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/js/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/style.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
    // a folder, with or without the slash, answers its index.html
    expect((await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/')).text).toBe(INDEX);
    expect((await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo')).text).toBe(INDEX);
    const bridge = await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/__manythreads.js');
    expect(bridge.status).toBe(200);
    expect(bridge.text).toBe(APP_BRIDGE_CLIENT_JS);
    // a missing file is 404 (with the headers), a bad path too
    const missing = await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/nope.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect((await call(nadia, 'GET', '/api/teams/engineering/repo/app/apps/demo/.git/config')).status).toBe(404);
  });

  // C1 of the Phase 4 review: `/repo/%61pp/...` reached the handler with no CSP and no sandbox (same-origin script execution for a victim who clicked it).
  it('answers no spelling of the path without the CSP and sandbox: a 404, or the headers', async () => {
    await commit(omar, 'engineering', [put('apps/evil/index.html', '<script>document.title = "pwned"</script>')], 'Add an app');
    const csp = embeddedAppHeaders()['content-security-policy'] ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    const canonical = await rawFull('/api/teams/engineering/repo/app/apps/evil/index.html');
    expect(canonical.status).toBe(200);
    expect(canonical.headers['content-security-policy']).toBe(csp);
    for (const url of [
      '/api/teams/engineering/repo/%61pp/apps/evil/index.html',
      '/api/teams/engineering/repo/ap%70/apps/evil/index.html',
      '/api/teams/engineering/repo/%2561pp/apps/evil/index.html',
      '/api/teams/engineering/repo/%41PP/apps/evil/index.html',
      '/api/teams/engineering/repo/App/apps/evil/index.html',
      '/api/teams/engineering/repo//app/apps/evil/index.html',
      '/api/teams/engineering//repo/app/apps/evil/index.html',
      '/api/teams/%65ngineering/repo/%61pp/apps/evil/index.html',
      '/api/teams/engineering/repo/app/apps/%65vil/index.html',
      '/api/teams/engineering/repo/app/apps/evil/index%2ehtml',
      '/api/teams/engineering/repo/app/apps/evil%2Findex.html',
    ]) {
      const res = await rawFull(url);
      if (res.status === 404) continue;
      expect(res.headers['content-security-policy'], url).toBe(csp);
      expect(res.headers['content-security-policy'], url).toContain('sandbox allow-scripts');
    }
    expect((await rawFull('/api/teams/engineering/repo/%61pp/apps/evil/index.html')).status).toBe(404);
    expect((await rawFull('/api/teams/engineering/repo/ap%70/apps/evil/index.html')).status).toBe(404);
    // a token on a non-canonical spelling authenticates nobody
    const { token } = await tokenFor('engineering', 'apps/evil');
    expect((await raw(`/api/teams/engineering/repo/%61pp/~mta.${token}/apps/evil/index.html`)).status).toBe(404);
  });

  it('is the team\'s: a member of another team, a guest and nobody get 403 or 401', async () => {
    expect((await call(tariq, 'GET', '/api/teams/engineering/repo/app/apps/demo/index.html')).status).toBe(403);
    expect((await call(lena, 'GET', '/api/teams/engineering/repo/app/apps/demo/index.html')).status).toBe(403);
    expect((await anonymous('/api/teams/engineering/repo/app/apps/demo/index.html')).status).toBe(401);
  });
});

describe('the per-open token', () => {
  it('is issued to a person who can read the team, and opens that app with no cookie and no header', async () => {
    const issued = await tokenFor();
    expect(issued.url).toMatch(/^\/api\/teams\/engineering\/repo\/app\/~mta\.v1\.[\w-]+\.[\w-]+\/apps\/demo\/index\.html$/);
    expect(new Date(IssueAppTokenResponse.parse((await issue(nadia, 'engineering', 'apps/demo')).body).expiresAt).getTime() - Date.now()).toBeGreaterThan(290_000);

    const page = await anonymous(issued.url);
    expect(page.status).toBe(200);
    expect(page.text).toBe(INDEX);
    expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    // what the page asks for next resolves against its own address, so the token comes along
    const resolve = (rel: string): string => new URL(rel, `http://x${issued.url}`).pathname;
    expect((await anonymous(resolve('__manythreads.js'))).text).toBe(APP_BRIDGE_CLIENT_JS);
    expect((await anonymous(resolve('js/app.js'))).status).toBe(200);
    expect((await anonymous(resolve('style.css'))).status).toBe(200);
  });

  it('never reaches the server log: the token segment of the request line is redacted (L4)', async () => {
    const { url, token } = await tokenFor();
    expect((await anonymous(url)).status).toBe(200);
    const bad = url.replace(token, `${token.slice(0, -2)}xx`);
    expect((await anonymous(bad)).status).toBe(403);
    const lines = server.logs.filter((l) => l.includes('/repo/app/'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('~mta.[redacted]'))).toBe(true);
    for (const line of server.logs) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(token.slice(0, 20));
    }
  });

  it('is refused to people who cannot read the team, and for an unknown team', async () => {
    expect((await issue(tariq, 'engineering', 'apps/demo')).status).toBe(403); // Marketing, not Engineering
    expect((await issue(lena, 'engineering', 'apps/demo')).status).toBe(403); // a guest
    expect((await issue(nadia, 'marketing', 'apps/demo')).status).toBe(403);
    expect((await issue(null, 'engineering', 'apps/demo')).status).toBe(401);
    expect((await issue(omar, 'no-such-team', 'apps/demo')).status).toBe(404); // an admin sees every team
    expect((await issue(nadia, 'no-such-team', 'apps/demo')).status).toBe(403);
    // the request is strict
    expect((await issue(nadia, 'engineering', '')).status).toBe(400);
    expect((await issue(nadia, 'engineering', '../etc')).status).toBe(400);
    expect((await call(nadia, 'POST', '/api/teams/engineering/repo/app-token', { path: 'apps/demo', extra: 1 })).status).toBe(400);
  });

  it('expires: five minutes after it was issued the same address answers 403', async () => {
    const { url } = await tokenFor();
    expect((await anonymous(url)).status).toBe(200);
    skew += 4 * 60_000;
    expect((await anonymous(url)).status).toBe(200);
    skew += 61_000;
    const expired = await anonymous(url);
    expect(expired.status).toBe(403);
    expect(expired.body).toEqual({ error: { code: 'forbidden', message: 'This app link has expired or is not valid. Reopen the app.' } });
    // a person with a session still opens the app by asking again
    expect((await anonymous((await tokenFor()).url)).status).toBe(200);
    skew = 0;
  });

  it('opens one app only: another folder, a path out of it and a sibling with the same prefix are 403', async () => {
    await commit(omar, 'engineering', [put('apps/demo2/index.html', '<p>demo two</p>')], 'Add a sibling app');
    const { url } = await tokenFor();
    const swap = (to: string): string => url.replace('/apps/demo/index.html', to);
    for (const path of [swap('/apps/other/index.html'), swap('/apps/demo2/index.html'), swap('/bots/coder/BOT.md'), swap('/TEAM.md'), swap('/apps/demo/../other/index.html'), swap('/apps/demo/%2e%2e/other/index.html'), swap('/apps//demo/index.html')]) {
      const res = await raw(path);
      expect(res.status, path).toBe(403);
    }
    // the token of the neighbour opens the neighbour, not this one
    const other = await tokenFor('engineering', 'apps/other');
    expect((await anonymous(other.url)).text).toBe('<p>other</p>');
    expect((await anonymous(other.url.replace('/apps/other/', '/apps/demo/'))).status).toBe(403);
  });

  it('opens one team only: the same address under another team\'s slug is 403, and a tampered token is 403', async () => {
    await commit(tariq, 'marketing', [put('apps/demo/index.html', '<p>marketing demo</p>')], 'Add the marketing demo');
    const { url, token } = await tokenFor();
    expect((await anonymous(url.replace('/teams/engineering/', '/teams/marketing/'))).status).toBe(403);
    // Nadia is not in Marketing: even a token for the right path of Marketing cannot be issued to her
    expect((await issue(nadia, 'marketing', 'apps/demo')).status).toBe(403);
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await anonymous(url.replace(token, flipped))).status).toBe(403);
    const payload = token.split('.')[1] ?? '';
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), t: 'marketing' })).toString('base64url');
    expect((await anonymous(url.replace('/teams/engineering/', '/teams/marketing/').replace(payload, forged))).status).toBe(403);
  });

  it('is the person\'s, checked again on every read: when the person loses the team, the token stops working', async () => {
    const { url } = await tokenFor('engineering', 'apps/demo', priya);
    expect((await anonymous(url)).status).toBe(200);
    await ownerSql(server.db.ownerUrl, `DELETE FROM app.team_members WHERE actor_id = $1 AND team_id = (SELECT id FROM app.teams WHERE slug = 'engineering')`, [priya.actorId]);
    expect((await anonymous(url)).status).toBe(403);
  });

  it('writes nothing: a token does not authorise a commit or a read of another route', async () => {
    const { url, token } = await tokenFor();
    const asUrl = (path: string): string => path;
    expect((await call(null, 'POST', url, { changes: [] })).status).toBe(404); // no such write route under /app/
    expect((await anonymous(asUrl(`/api/teams/engineering/repo/blob?path=apps/demo/index.html&token=${token}`))).status).toBe(401);
    expect((await anonymous(`/api/teams/engineering/repo/tree/~mta.${token}`)).status).toBe(404);
  });
});
