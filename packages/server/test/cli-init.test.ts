/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Http,
  InitError,
  checkPasswordLength,
  ensureLlmKey,
  ensureRunner,
  ensureTeam,
  generatePassword,
  initEnvFromEnv,
  parseInitArgs,
  runInit,
  type InitEnv,
} from '../src/cli/init.ts';

describe('parseInitArgs', () => {
  it('needs an email and fills the rest with defaults', () => {
    expect(parseInitArgs([])).toMatch(/--email/);
    expect(parseInitArgs(['--email', 'nobody'])).toMatch(/--email/);
    expect(parseInitArgs(['--email', 'Ada@Example.org'])).toEqual({ email: 'ada@example.org', name: 'ada', workspace: 'My workspace', team: 'General', noRunnerTest: false });
  });
  it('reads every option and refuses an unknown one', () => {
    expect(parseInitArgs(['--email', 'a@b.c', '--name', 'Ada L', '--workspace', 'W', '--team', 'T', '--brain-profile', 'brain-x', '--no-runner-test'])).toEqual({
      email: 'a@b.c',
      name: 'Ada L',
      workspace: 'W',
      team: 'T',
      profileName: 'brain-x',
      noRunnerTest: true,
    });
    expect(parseInitArgs(['--email', 'a@b.c', '--wat'])).toBe('unknown option --wat');
  });
});

describe('passwords', () => {
  it('makes a long password from an alphabet with no look-alikes', () => {
    const p = generatePassword();
    expect(p).toHaveLength(24);
    expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
    expect(generatePassword()).not.toBe(p);
    expect(() => checkPasswordLength(p)).not.toThrow();
  });
  it('refuses a short one with exit code 2', () => {
    try {
      checkPasswordLength('short');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InitError);
      expect((err as InitError).exitCode).toBe(2);
    }
  });
});

describe('initEnvFromEnv', () => {
  it('derives the addresses and trims trailing slashes', () => {
    const e = initEnvFromEnv({
      PORT: '3100',
      MANYTHREADS_HERMES_URL: 'http://hermes:8642/',
      MANYTHREADS_HERMES_API_KEY: 'k',
      MANYTHREADS_LITELLM_URL: 'http://litellm:4000/',
      MANYTHREADS_LITELLM_MASTER_KEY: 'm',
    });
    expect(e).toMatchObject({
      baseUrl: 'http://127.0.0.1:3100',
      hermesUrl: 'http://hermes:8642',
      llmBaseUrl: 'http://litellm:4000/v1',
      mcpUrl: 'http://127.0.0.1:3100/mcp',
      model: 'smart',
      profilesDir: '/hermes-profiles',
    });
  });
});

/** A tiny server that records what it was asked and answers from a table. */
function stub(routes: Record<string, (body: any) => { status: number; body?: unknown; headers?: Record<string, string | string[]> }>) {
  const seen: { method: string; url: string; body: any; headers: Record<string, string | string[] | undefined> }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const key = `${req.method} ${req.url?.split('?')[0]}`;
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      const h = routes[key];
      const out = h ? h(body) : { status: 404, body: { error: { message: `no route ${key}` } } };
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('Http', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('keeps the session cookie and sends the CSRF token back as a header', async () => {
    const s = await stub({
      'POST /api/auth/password/sign-in': () => ({ status: 200, headers: { 'set-cookie': ['manythreads_session=abc; Path=/; HttpOnly', 'manythreads_csrf=tok%2B1; Path=/'] }, body: { ok: true } }),
      'GET /api/me': () => ({ status: 200, body: { ok: true } }),
    });
    close = s.close;
    const http = new Http(s.url);
    await http.call('POST', '/api/auth/password/sign-in', { email: 'a@b.c', password: 'x' });
    await http.call('GET', '/api/me');
    const second = s.seen[1]!;
    expect(String(second.headers['cookie'])).toContain('manythreads_session=abc');
    expect(second.headers['x-csrf-token']).toBe('tok+1');
  });

  it('answers with the status and parsed JSON, or a short raw text for a body that is not JSON', async () => {
    const s = await stub({});
    close = s.close;
    const r = await new Http(s.url).call('GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/no route/);
  });
});

describe('ensureTeam and ensureRunner', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('uses the first team when there is one, and makes one when there is none', async () => {
    const s = await stub({ 'GET /api/teams': () => ({ status: 200, body: { teams: [{ slug: 'ops' }] } }) });
    close = s.close;
    expect(await ensureTeam(new Http(s.url), 'General')).toBe('ops');
    expect(s.seen.map((x) => x.method)).toEqual(['GET']);
    await s.close();
    const t = await stub({
      'GET /api/teams': () => ({ status: 200, body: { teams: [] } }),
      'POST /api/teams': (b) => ({ status: 201, body: { team: { slug: String(b.name).toLowerCase() } } }),
    });
    close = t.close;
    expect(await ensureTeam(new Http(t.url), 'General')).toBe('general');
  });

  const spec = { name: 'hermes', label: 'Hermes', baseUrl: 'http://hermes:8642', apiKey: 'key-12345678', profileRule: 'mt-{bot}' };

  it('makes the runner open to every team and the default', async () => {
    const s = await stub({
      'GET /api/admin/bot-runners': () => ({ status: 200, body: { items: [] } }),
      'POST /api/admin/bot-runners': () => ({ status: 201, body: { runner: { id: 'r1' } } }),
      'PUT /api/admin/bot-runners/default': () => ({ status: 200, body: {} }),
    });
    close = s.close;
    expect(await ensureRunner(new Http(s.url), spec)).toEqual({ id: 'r1', profileRule: 'mt-{bot}', made: true });
    expect(s.seen[1]!.body).toMatchObject({ name: 'hermes', kind: 'hermes_gateway', baseUrl: 'http://hermes:8642', teams: { all: true }, profileRule: 'mt-{bot}' });
    expect(s.seen[2]!.body).toEqual({ runnerId: 'r1' });
  });

  it('updates a runner of that name (a key or address that changed) instead of making a second one', async () => {
    const s = await stub({
      'GET /api/admin/bot-runners': () => ({ status: 200, body: { items: [{ id: 'r9', name: 'hermes', profileRule: 'x-{bot}', baseUrl: 'http://old', isDefault: false }] } }),
      'PATCH /api/admin/bot-runners/r9': () => ({ status: 200, body: {} }),
      'PUT /api/admin/bot-runners/default': () => ({ status: 200, body: {} }),
    });
    close = s.close;
    const out = await ensureRunner(new Http(s.url), spec);
    expect(out.id).toBe('r9');
    expect(out.made).toBe(false);
    expect(s.seen.map((x) => `${x.method} ${x.url}`)).toEqual(['GET /api/admin/bot-runners', 'PATCH /api/admin/bot-runners/r9', 'PUT /api/admin/bot-runners/default']);
  });

  it('says what went wrong, without the key', async () => {
    const s = await stub({
      'GET /api/admin/bot-runners': () => ({ status: 200, body: { items: [] } }),
      'POST /api/admin/bot-runners': () => ({ status: 400, body: { error: { message: 'bad profile rule' } } }),
    });
    close = s.close;
    await expect(ensureRunner(new Http(s.url), spec)).rejects.toThrow(/HTTP 400: bad profile rule/);
    await expect(ensureRunner(new Http(s.url), spec)).rejects.not.toThrow(/key-12345678/);
  });
});

describe('ensureLlmKey', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());
  const base = (url: string): InitEnv => ({
    baseUrl: '',
    hermesUrl: '',
    hermesKey: '',
    llmKey: 'sk-hermes',
    hindsightLlmKey: 'sk-hindsight',
    litellmUrl: url,
    litellmMasterKey: 'sk-master',
    llmBaseUrl: '',
    model: 'smart',
    mcpUrl: '',
    profilesDir: '',
  });

  it('makes the two virtual keys with the master key in a header, each limited to its aliases, and says so without printing a key', async () => {
    const s = await stub({
      'GET /key/info': () => ({ status: 404, body: {} }),
      'POST /key/generate': () => ({ status: 200, body: {} }),
    });
    close = s.close;
    const said: string[] = [];
    await ensureLlmKey(base(s.url), (l) => said.push(l));
    const gens = s.seen.filter((x) => x.method === 'POST');
    expect(gens.map((g) => g.body.models)).toEqual([['smart', 'fast', 'code'], ['fast']]);
    expect(gens.every((g) => g.headers['authorization'] === 'Bearer sk-master')).toBe(true);
    expect(said.join('\n')).not.toMatch(/sk-/);
    expect(said).toHaveLength(2);
  });

  it('does nothing for a key that exists, and nothing at all without the gateway settings', async () => {
    const s = await stub({ 'GET /key/info': () => ({ status: 200, body: {} }) });
    close = s.close;
    await ensureLlmKey(base(s.url), () => undefined);
    expect(s.seen.every((x) => x.method === 'GET')).toBe(true);
    const spy = vi.spyOn(globalThis, 'fetch');
    await ensureLlmKey({ ...base(''), litellmUrl: '' }, () => undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('treats "already exists" as done and any other refusal as a line for the person', async () => {
    const s = await stub({
      'GET /key/info': () => ({ status: 404, body: {} }),
      'POST /key/generate': (b) => (b.key === 'sk-hermes' ? { status: 400, body: { error: 'key already exists' } } : { status: 500, body: {} }),
    });
    close = s.close;
    const said: string[] = [];
    await ensureLlmKey(base(s.url), (l) => said.push(l));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/memory engine could not be created \(HTTP 500\)/);
  });
});

describe('runInit', () => {
  it('refuses a missing email before it touches anything', async () => {
    const err: string[] = [];
    const code = await runInit([], { stdin: (async function* () {})(), out: () => undefined, err: (l) => err.push(l), env: {} }, false, () => {
      throw new Error('no pool must be made');
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/--email/);
  });

  it('brain-profile needs the password on standard input', async () => {
    const err: string[] = [];
    const code = await runInit(['--email', 'a@b.c'], { stdin: (async function* () {})(), out: () => undefined, err: (l) => err.push(l), env: {} }, true, () => {
      throw new Error('no pool');
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/Pipe the administrator's password/);
  });
});
