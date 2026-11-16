import { Readable } from 'node:stream';
import { createSystemPool, withSystem } from '@manythreads/kernel';
import { createApiClient, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdmin, type AdminIo } from '../src/cli/admin.ts';
import { parseFirstAdminArgs } from '../src/cli/first-admin.ts';

// P27-03: `admin first-admin`, `admin password-status`, `admin reset-password --generate` (the one-command install), and the sign-in that asks for a new password.

describe('parseFirstAdminArgs', () => {
  it('needs an email, names the workspace "My organization" by default and takes the display name from the email', () => {
    expect(parseFirstAdminArgs([])).toMatch(/--email/);
    expect(parseFirstAdminArgs(['--email', 'nobody'])).toMatch(/--email/);
    expect(parseFirstAdminArgs(['--email', 'Ada@Example.org'])).toEqual({ email: 'ada@example.org', workspace: 'My organization', name: 'ada' });
    expect(parseFirstAdminArgs(['--email', 'a@b.co', '--workspace', 'Acme', '--name', 'Ada L'])).toEqual({ email: 'a@b.co', workspace: 'Acme', name: 'Ada L' });
    expect(parseFirstAdminArgs(['--email', 'a@b.co', '--wat'])).toBe('unknown option --wat');
  });
});

describe('the first administrator of an empty install', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const sql = <T>(text: string, values: unknown[] = []): Promise<T[]> => withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });

  async function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = {
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      env: { NODE_ENV: 'test', MANYTHREADS_INTERNAL_URL: s.url },
      pool: () => createSystemPool(s.db.systemUrl, 2),
    };
    const code = await runAdmin(argv, io);
    const lines = Object.fromEntries(out.filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { code, out: out.join('\n'), err: err.join('\n'), lines };
  }

  const email = 'admin@example.org';
  let first = '';

  it('makes the workspace and its owner, no team and no runner, and prints the made-up password once', async () => {
    const r = await run(['first-admin', '--email', email, '--workspace', 'My organization']);
    expect(r.code).toBe(0);
    expect(r.lines['FIRST_ADMIN_STATUS']).toBe('created');
    expect(r.lines['FIRST_ADMIN_EMAIL']).toBe(email);
    first = r.lines['FIRST_ADMIN_PASSWORD'] ?? '';
    expect(first).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
    expect(r.err).not.toContain(first);
    expect(await sql('SELECT 1 FROM app.workspaces WHERE name = $1', ['My organization'])).toHaveLength(1);
    expect(await sql('SELECT 1 FROM app.teams')).toHaveLength(0);
    expect(await sql('SELECT 1 FROM app.bot_runners')).toHaveLength(0);
    const role = await sql<{ role: string }>('SELECT role FROM app.workspace_members');
    expect(role.map((x) => x.role)).toEqual(['owner']);
  });

  it('signs in with that password, and the session says the password must be changed', async () => {
    const c = createApiClient(s.url);
    const res = await c.post('/api/auth/password/sign-in', { email, password: first });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mustChangePassword?: boolean }).mustChangePassword).toBe(true);
    const session = (await (await c.get('/api/session')).json()) as { authenticated: boolean; mustChangePassword?: boolean };
    expect(session.authenticated).toBe(true);
    expect(session.mustChangePassword).toBe(true);
  });

  it('refuses everything but the session read, the password change and sign-out while the made-up password is still in use (a script gets nothing from the printed password)', async () => {
    const c = createApiClient(s.url);
    expect((await c.post('/api/auth/password/sign-in', { email, password: first })).status).toBe(200);
    const probes: Array<[string, string]> = [
      ['GET', '/api/workspace/onboarding'],
      ['GET', '/api/admin/bot-runners'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/teams'],
    ];
    for (const [method, path] of probes) {
      const res = method === 'GET' ? await c.get(path) : await c.post(path, {});
      const body = (await res.json()) as { error?: { code?: string } };
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(body.error?.code, `${method} ${path}`).toBe('password_change_required');
    }
    // a wrong current password is the route's own answer, so the change route is reached
    expect((await c.post('/api/auth/password/change', { currentPassword: 'not-it-at-all-1234', newPassword: 'another-long-passphrase' })).status).not.toBe(403);
    expect((await c.get('/api/session')).status).toBe(200);
    expect((await c.post('/api/auth/sign-out', {})).status).toBeLessThan(300);
    expect((await c.get('/api/session').then((r) => r.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  it('keeps the made-up password out of every event and audit line', async () => {
    const events = await sql<{ payload: unknown }>('SELECT payload FROM app.events');
    expect(JSON.stringify(events)).not.toContain(first);
  });

  it('says the first password is still in use, without printing it', async () => {
    const r = await run(['password-status', email]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('FIRST_PASSWORD=pending');
    expect(r.out + r.err).not.toContain(first);
    expect((await run(['password-status', 'nobody@example.org'])).out).toBe('FIRST_PASSWORD=unknown');
  });

  it('a second run makes nothing, changes no password and exits 0', async () => {
    const r = await run(['first-admin', '--email', 'someone-else@example.org']);
    expect(r.code).toBe(0);
    expect(r.lines['FIRST_ADMIN_STATUS']).toBe('exists');
    expect(r.lines['FIRST_ADMIN_PASSWORD']).toBeUndefined();
    expect(await sql('SELECT 1 FROM app.workspaces')).toHaveLength(1);
    expect(await sql('SELECT 1 FROM app.people')).toHaveLength(1);
    expect((await createApiClient(s.url).post('/api/auth/password/sign-in', { email, password: first })).status).toBe(200);
  });

  it('choosing a password clears the flag; the status reads "changed"; the old one stops working', async () => {
    const c = createApiClient(s.url);
    expect((await c.post('/api/auth/password/sign-in', { email, password: first })).status).toBe(200);
    const changed = await c.post('/api/auth/password/change', { currentPassword: first, newPassword: 'my-own-long-passphrase' });
    expect(changed.status).toBe(200);
    const session = (await (await c.get('/api/session')).json()) as { mustChangePassword?: boolean };
    expect(session.mustChangePassword).toBe(false);
    // the same session now reaches the rest of the API
    expect((await c.get('/api/workspace/onboarding')).status).toBe(200);
    expect((await run(['password-status', email])).out).toBe('FIRST_PASSWORD=changed');
    expect((await createApiClient(s.url).post('/api/auth/password/sign-in', { email, password: first })).status).toBe(401);
  });

  it('reset-password --generate prints a new password once, signs everyone out and asks for a change again', async () => {
    const r = await run(['reset-password', email, '--generate']);
    expect(r.code).toBe(0);
    const fresh = r.lines['NEW_PASSWORD'] ?? '';
    expect(fresh).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
    expect(r.lines['NEW_PASSWORD_EMAIL']).toBe(email);
    expect(r.err).not.toContain(fresh);
    expect((await run(['password-status', email])).out).toBe('FIRST_PASSWORD=pending');
    const c = createApiClient(s.url);
    expect(((await (await c.post('/api/auth/password/sign-in', { email, password: fresh })).json()) as { mustChangePassword?: boolean }).mustChangePassword).toBe(true);
    expect((await c.get('/api/workspace/onboarding')).status).toBe(403);
    const events = await sql<{ payload: unknown }>('SELECT payload FROM app.events');
    expect(JSON.stringify(events)).not.toContain(fresh);
  });

  it('refuses the wrong shapes with exit code 2 and an unknown person with 1', async () => {
    expect((await run(['reset-password', email])).code).toBe(2);
    expect((await run(['reset-password'])).code).toBe(2);
    expect((await run(['password-status'])).code).toBe(2);
    expect((await run(['first-admin'])).code).toBe(2);
    expect((await run(['reset-password', 'nobody@example.org', '--generate'])).code).toBe(1);
  });
});
