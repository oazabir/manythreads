import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_TOOLS, PUBLISH_TOOL, RECORD_TOOLS } from '@manythreads/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, profileFor } from '../src/config.ts';
import { parseRunRequest } from '../src/request.ts';
import { HERMES_SEED, kubeconfigFile, kubeFolder, prepareServerRun } from '../src/server-run.ts';

// What a run on an enrolled server is given (P26-15): the site answers the three questions with the run's own token, and the bridge builds the run's copy of the bot's profile.

const TOKEN = 'run-token-0123456789abcdef'; // secret-scan:ignore a made-up fixture
const KUBE = 'apiVersion: v1\nkind: Config\nclusters: []\n';

let site: Server;
let base = '';
const state = { mayPublish: true, deployer: false, models: ['smart', 'fast'] as string[], selfStatus: 200, seen: [] as string[] };
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'server-run-'));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  site = createServer((req, res) => {
    state.seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${TOKEN}` ? 'ok' : 'bad-auth'}`);
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'no' });
    if (req.url === '/api/runs/self') return state.selfStatus === 200 ? json(200, { teamSlug: 'eng', botSlug: 'builder', runId: 'r1', mayPublish: state.mayPublish }) : json(state.selfStatus, {});
    if (req.url === '/api/runs/self/kubeconfig') return state.deployer ? json(200, { kubeconfig: KUBE }) : json(404, {});
    if (req.url === '/api/llm/runs/run-1/v1/models') return json(200, { data: state.models.map((id) => ({ id })) });
    json(404, {});
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => site.close());
beforeEach(() => Object.assign(state, { mayPublish: true, deployer: false, models: ['smart', 'fast'], selfStatus: 200, seen: [] }));
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(over: { publisher?: boolean; tools?: boolean } = {}) {
  const root = tmp();
  const config = parseConfig({
    profiles: { s: { agent: 'claude-code', driver: 'acp', workdir: join(root, 'work', '.signin') } },
    server: {
      root,
      agents: { claude: { env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } }, codex: { fullAccess: 'allowed' }, hermes: { hermesHome: join(root, 'hermes') } },
      ...(over.tools === false ? {} : { toolsDir: '/opt/manythreads-bridge/current/tools' }),
      ...(over.publisher === false ? {} : { publisherSocket: '/run/manythreads-publisher/publisher.sock' }),
    },
  });
  return { root, config };
}
const requestWith = (token: string | null = TOKEN, extra: Record<string, unknown> = {}) => {
  const parsed = parseRunRequest({ input: 'work', manythreads: { bot: 'builder', runId: 'run-1', ...(token !== null ? { mcp: { url: `${base}/mcp`, token } } : {}), tools: [], ...extra } });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const prepare = (config: ReturnType<typeof setup>['config'], name: string, req = requestWith()) =>
  prepareServerRun(config, name, profileFor(config, name)!.profile, req, { siteUrl: base, log: () => undefined });
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []);

describe('the run\'s copy of a bot\'s profile', () => {
  it('names the server\'s folders and commands (the text the pod renderer builds with), and the commands Claude may run without a question', async () => {
    const { root, config } = setup();
    const p = await prepare(config, 'claude--eng--builder');
    expect(p.instructions).toContain(`Your working folder is ${root}/work/eng/builder`);
    expect(p.instructions).toContain(`${root}/work/eng/repos/<project>.git`);
    expect(p.instructions).toContain('mt-git record-push');
    expect(p.instructions).toContain('mt-publish check <project>');
    expect(p.instructions).toContain('/etc/manythreads-bridge');
    expect(p.instructions).toContain('Chromium');
    expect(p.extraAllowedTools).toEqual([...GIT_TOOLS, ...RECORD_TOOLS, PUBLISH_TOOL]);
    expect(p.env).toMatchObject({ MT_PUBLISH_SOCKET: '/run/manythreads-publisher/publisher.sock', MANYTHREADS_RUN_TOKEN: TOKEN });
    expect(p.env?.['PATH']?.startsWith('/opt/manythreads-bridge/current/tools:')).toBe(true);
    expect(state.seen).toEqual(['GET /api/runs/self ok', 'GET /api/runs/self/kubeconfig ok']);
  });

  it('a bot that may not publish is not told how, does not get the tool or the socket', async () => {
    state.mayPublish = false;
    const { config } = setup();
    const p = await prepare(config, 'claude--eng--builder');
    expect(p.instructions).not.toContain('mt-publish check');
    expect(p.extraAllowedTools).toEqual([...GIT_TOOLS, ...RECORD_TOOLS]);
    expect(p.env?.['MT_PUBLISH_SOCKET']).toBeUndefined();
    expect(p.env?.['MANYTHREADS_RUN_TOKEN']).toBeUndefined(); // no use for it: the adapter gets the token in its MCP header only
  });

  it('a server with no publisher installed never says a bot may publish, whatever the site answers', async () => {
    const { config } = setup({ publisher: false });
    const p = await prepare(config, 'claude--eng--builder');
    expect(p.instructions).not.toContain('mt-publish check');
    expect(p.env?.['MT_PUBLISH_SOCKET']).toBeUndefined();
  });

  it('Codex gets plain git and the record commands in its text and no Claude tool list', async () => {
    const { config } = setup();
    const p = await prepare(config, 'codex--eng--builder');
    expect(p.extraAllowedTools).toBeUndefined();
    expect(p.instructions).toContain('Commit with plain `git`');
    expect(p.instructions).toContain('mt-git record-fetch');
  });

  it('keeps what the template gave (env, sign-in folder) and does not change the profile it was given', async () => {
    const { config } = setup();
    const base = profileFor(config, 'claude--eng--builder')!.profile;
    const before = JSON.stringify(base);
    const p = await prepare(config, 'claude--eng--builder');
    expect(p.env?.['PLAYWRIGHT_BROWSERS_PATH']).toBe('/opt/pw');
    expect(JSON.stringify(base)).toBe(before);
  });

  it('a name that is not a server name, or a bridge with no server section, is handed back as it came', async () => {
    const { config } = setup();
    const plain = config.profiles['s']!;
    expect(await prepareServerRun(config, 's', plain, requestWith(), { siteUrl: base, log: () => undefined })).toBe(plain);
    const none = parseConfig({ profiles: { s: { agent: 'codex', workdir: '/w' } } });
    expect(await prepareServerRun(none, 'claude--a--b', none.profiles['s']!, requestWith(), { siteUrl: base, log: () => undefined })).toBe(none.profiles['s']);
  });

  it('a site that cannot be asked means "no", never a failed run', async () => {
    const { config } = setup();
    const p = await prepareServerRun(config, 'claude--eng--builder', profileFor(config, 'claude--eng--builder')!.profile, requestWith(), { siteUrl: 'http://127.0.0.1:1', log: () => undefined });
    expect(p.instructions).not.toContain('mt-publish check');
    expect(p.env?.['KUBECONFIG']).toBeUndefined();
    state.selfStatus = 500;
    const q = await prepare(config, 'claude--eng--builder');
    expect(q.env?.['MT_PUBLISH_SOCKET']).toBeUndefined();
  });

  it('asks nothing without a run token', async () => {
    const { config } = setup();
    const p = await prepare(config, 'claude--eng--builder', requestWith(null));
    expect(state.seen).toEqual([]);
    expect(p.instructions).not.toContain('mt-publish check');
  });
});

describe('the deployer\'s kubeconfig', () => {
  it('is written 0600 in a private folder of this run, named in KUBECONFIG of this run\'s profile only, and its text is not in the instructions', async () => {
    state.deployer = true;
    const { root, config } = setup();
    const p = await prepare(config, 'claude--eng--deployer');
    const file = kubeconfigFile(root, 'eng', 'deployer', 'run-1');
    expect(p.env?.['KUBECONFIG']).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(KUBE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    expect(p.instructions).toContain(`your kubeconfig (${file})`);
    expect(p.instructions).not.toContain('apiVersion');
    // another bot of the same server: nothing
    state.deployer = false;
    const other = await prepare(config, 'claude--eng--builder');
    expect(other.env?.['KUBECONFIG']).toBeUndefined();
    expect(filesUnder(kubeFolder(root)).filter((f) => f.includes('--builder'))).toEqual([]);
  });

  it('is removed when the run is over, and a run\'s id is never used as a path', async () => {
    state.deployer = true;
    const { root, config } = setup();
    const ends: Array<() => void> = [];
    const withEnd = (req: ReturnType<typeof requestWith>) =>
      prepareServerRun(config, 'claude--eng--deployer', profileFor(config, 'claude--eng--deployer')!.profile, req, { siteUrl: base, log: () => undefined, onEnd: (fn) => ends.push(fn) });
    const p = await withEnd(requestWith());
    const file = p.env?.['KUBECONFIG'] ?? '';
    expect(existsSync(file)).toBe(true);
    for (const fn of ends.splice(0)) fn();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(file, '..'))).toBe(false);
    // a run id that is a path goes to a random folder inside the bot's own, never outside it
    const hostile = await withEnd(requestWith(TOKEN, { runId: '../../../etc' }));
    const hostileFile = hostile.env?.['KUBECONFIG'] ?? '';
    expect(hostileFile.startsWith(`${kubeFolder(root)}/eng--deployer/`)).toBe(true);
    expect(hostileFile).not.toContain('..');
    for (const fn of ends.splice(0)) fn();
    expect(filesUnder(kubeFolder(root))).toEqual([]);
  });

  it('two runs of the same bot at once have two files: the end of one leaves the other\'s', async () => {
    state.deployer = true;
    const { config } = setup();
    const endsA: Array<() => void> = [];
    const mk = (runId: string, ends: Array<() => void>) =>
      prepareServerRun(config, 'claude--eng--deployer', profileFor(config, 'claude--eng--deployer')!.profile, requestWith(TOKEN, { runId }), { siteUrl: base, log: () => undefined, onEnd: (fn) => ends.push(fn) });
    const endsB: Array<() => void> = [];
    const a = (await mk('run-a', endsA)).env?.['KUBECONFIG'] ?? '';
    const b = (await mk('run-b', endsB)).env?.['KUBECONFIG'] ?? '';
    expect(a).not.toBe(b);
    for (const fn of endsA) fn();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    for (const fn of endsB) fn();
  });
});

describe('Hermes on a server', () => {
  it('has its own home with a config that names the run proxy through the environment: no secret in the file, the run\'s address and token in the environment', async () => {
    const { root, config } = setup();
    const p = await prepare(config, 'hermes--eng--analyst', requestWith(TOKEN, { model: { alias: 'fast' } }));
    const home = join(root, 'hermes', 'eng--analyst');
    expect(p.env?.['HERMES_HOME']).toBe(home);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(HERMES_SEED);
    expect(statSync(join(home, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(HERMES_SEED).not.toContain(TOKEN);
    expect(p.env?.['MANYTHREADS_LLM_URL']).toBe(`${base}/api/llm/runs/run-1/v1`);
    expect(p.env?.['MANYTHREADS_LLM_MODEL']).toBe('fast');
    expect(p.env?.['MANYTHREADS_RUN_TOKEN']).toBe(TOKEN);
    expect(p.extraAllowedTools).toBeUndefined();
    // no file of the bridge's holds the token
    for (const f of filesUnder(root)) expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
  });

  it('takes the first model the key may call when the bot names none or one it may not call; a failing list falls back to the alias', async () => {
    const { config } = setup();
    expect((await prepare(config, 'hermes--eng--analyst')).env?.['MANYTHREADS_LLM_MODEL']).toBe('smart');
    expect((await prepare(config, 'hermes--eng--analyst', requestWith(TOKEN, { model: { alias: 'gone' } }))).env?.['MANYTHREADS_LLM_MODEL']).toBe('smart');
    state.models = [];
    expect((await prepare(config, 'hermes--eng--analyst', requestWith(TOKEN, { model: { alias: 'gone' } }))).env?.['MANYTHREADS_LLM_MODEL']).toBe('gone');
  });

  it('writes the config again only when it differs, and never touches a home outside its own folder', async () => {
    const { root, config } = setup();
    const home = join(root, 'hermes', 'eng--analyst');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.yaml'), 'something else\n');
    writeFileSync(join(home, 'memory.md'), 'kept\n');
    await prepare(config, 'hermes--eng--analyst');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(HERMES_SEED);
    expect(readFileSync(join(home, 'memory.md'), 'utf8')).toBe('kept\n');
    expect(JSON.stringify(readdirSync(root))).not.toContain('.hermes');
  });
});

describe('the run manager on a server', () => {
  it('hands the driver the run\'s own copy of the profile (text, tools, environment) and the adapter gets the run token in its environment', async () => {
    const { RunManager } = await import('../src/runs.ts');
    const { SessionStore } = await import('../src/sessions.ts');
    const { adapterEnv } = await import('../src/acp/adapter.ts');
    state.deployer = true;
    const { root, config } = setup();
    let seen: { instructions: string | null; env: NodeJS.ProcessEnv; tools: string[] | undefined } | undefined;
    const manager = new RunManager({
      config,
      sessions: new SessionStore(join(root, 'state')),
      tmpRoot: root,
      log: () => undefined,
      serverRun: { siteUrl: base },
      drivers: {
        acp: {
          run: async (job) => {
            seen = { instructions: job.request.instructions, env: adapterEnv(job, null), tools: job.profile.extraAllowedTools };
            return { ok: true, output: 'done', usage: null };
          },
        },
      },
    });
    const req = requestWith();
    const { run } = manager.create('claude--eng--deployer', req, JSON.stringify(req), null);
    await vi.waitFor(() => expect(run.status).not.toBe('running'), { timeout: 10_000, interval: 10 });
    manager.close();
    expect(run.status).toBe('completed');
    expect(seen?.instructions).toContain('## Where you run');
    expect(seen?.instructions).toContain(`${root}/work/eng/deployer`);
    expect(seen?.env['KUBECONFIG']).toBe(kubeconfigFile(root, 'eng', 'deployer', 'run-1'));
    // the run is over: neither the deployer's login nor the run's token is left on the disk
    await vi.waitFor(() => expect(filesUnder(kubeFolder(root))).toEqual([]), { timeout: 5000, interval: 10 });
    for (const f of filesUnder(root)) expect(readFileSync(f, 'utf8'), f).not.toContain(TOKEN);
    expect(seen?.env['MANYTHREADS_RUN_TOKEN']).toBe(TOKEN);
    expect(seen?.tools).toContain(PUBLISH_TOOL);
  });
});
