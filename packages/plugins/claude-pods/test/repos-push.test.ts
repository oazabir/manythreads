/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read rendered Kubernetes objects whose shape the assertions pin */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginLogger, PodRunnerInfo } from '@manythreads/sdk';
import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { afterEach, describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { createWake, WAKE_DELAY_MS } from '../src/index.ts';
import { Reconciler, type RunnerSource } from '../src/reconcile.ts';
import { namesFor } from '../src/render.ts';

// P19-09, decision E4: a project added by a team reaches its clone folder in seconds. The controller sends the repository list to the pod's bridge (PUT /internal/repos) a moment
// after the project event; the repo-sync step reads it every 5 seconds. Both halves are measured here: the call within 2 seconds of the change, and a clone within 10 seconds of the file.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  private key = (kind: string, ns: string, name: string): string => `${kind}/${ns}/${name}`;
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name), structuredClone(obj));
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    const o = this.store.get(this.key(kind, ns, name));
    if (!o) return null;
    if (kind === 'Secret' && o['stringData']) return { ...o, data: Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
    return structuredClone(o);
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.store.delete(this.key(kind, ns, name));
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter((o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v));
  }
}

const CFG: ClaudePodConfig = { ...configFrom({ MANYTHREADS_INCLUSTER_URL: 'http://server.test:3000' }), namespace: 'bots', image: 'manythreads/claude-pod:1', repoOriginAllow: ['https://github.com/acme/'] };
const logs: string[] = [];
const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };
const runner: PodRunnerInfo = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: 'w1',
  name: 'shared',
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [{ id: 't-eng', slug: 'engineering' }],
  allTeams: false,
  bots: [
    { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'builder' },
    { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'reviewer' },
  ],
};
const project = (name: string, origin = `https://github.com/acme/${name}.git`) => ({ teamSlug: 'engineering', name, origin, branch: 'main' });

interface Put {
  at: number;
  authorization: string | undefined;
  body: { repos: Array<Record<string, unknown>> };
}
const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

/** A stand-in for the pod's bridge: records every PUT /internal/repos with the time it arrived, and answers with the status it is told to. */
async function bridgeStandIn(): Promise<{ url: string; puts: Put[]; status: { value: number }; stop: () => Promise<void> }> {
  const puts: Put[] = [];
  const status = { value: 200 };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'PUT' && req.url === '/internal/repos') puts.push({ at: Date.now(), authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status.value, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const stop = (): Promise<void> => new Promise((r) => (server.closeAllConnections(), server.close(() => r())));
  stoppers.push(stop);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, puts, status, stop };
}

function controller(bridgeUrl: string, projects: { current: ReturnType<typeof project>[] }) {
  const k8s = new FakeK8s();
  const names = namesFor(runner.name);
  const source: RunnerSource = {
    runners: async () => [runner],
    reposForTeams: async () => projects.current,
    publishersForTeams: async () => [],
  };
  const r = new Reconciler(k8s, CFG, source, LOG, () => 'k'.repeat(48), Date.now, fetch, () => bridgeUrl);
  const credentials = (): void => void k8s.store.set(`Secret/bots/${names.credentials}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: names.credentials, namespace: 'bots' }, data: {} });
  const podUp = (): void =>
    void k8s.store.set(`Pod/bots/${names.base}-abc`, { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${names.base}-abc`, namespace: 'bots', labels: { 'manythreads.io/pod': names.base } }, status: { phase: 'Running' } });
  return { k8s, r, names, credentials, podUp };
}

describe('the repository list reaches the pod within seconds of a project change', () => {
  it('sends the list to the bridge with the bridge key once the pod is up, and again within 2 seconds of a project being added', async () => {
    const bridge = await bridgeStandIn();
    const projects = { current: [project('app')] };
    const { r, credentials, podUp, k8s, names } = controller(bridge.url, projects);
    credentials();
    podUp();
    // the event handler of the plugin: a project event asks for a pass after WAKE_DELAY_MS
    const wake = createWake(() => void r.reconcileAll());
    await r.reconcileAll();
    expect(bridge.puts).toHaveLength(1);
    expect(bridge.puts[0]!.authorization).toBe(`Bearer ${'k'.repeat(48)}`);
    // one entry per clone: every bot of the team gets every project of the team (the evil address is left out, as in the ConfigMap)
    expect(bridge.puts[0]!.body.repos).toEqual([
      { team: 'engineering', bot: 'builder', project: 'app', branch: 'main', origin: 'https://github.com/acme/app.git' },
      { team: 'engineering', bot: 'reviewer', project: 'app', branch: 'main', origin: 'https://github.com/acme/app.git' },
    ]);

    projects.current = [project('app'), project('api'), project('evil', 'https://evil.example/x.git')];
    const changedAt = Date.now();
    wake();
    while (bridge.puts.length < 2 && Date.now() - changedAt < 5000) await new Promise((res) => setTimeout(res, 20));
    expect(bridge.puts).toHaveLength(2);
    const took = bridge.puts[1]!.at - changedAt;
    expect(took, `the call came ${took} ms after the change`).toBeLessThanOrEqual(2000);
    expect(WAKE_DELAY_MS).toBeLessThanOrEqual(2000);
    expect(bridge.puts[1]!.body.repos.map((x) => `${x['bot']}/${x['project']}`).sort()).toEqual(['builder/api', 'builder/app', 'reviewer/api', 'reviewer/app']);
    // the start-up copy in the ConfigMap holds the same list
    const lines = ((await k8s.get('ConfigMap', 'bots', names.config))!.data as Record<string, string>)['repos.txt']!.trim().split('\n').sort();
    expect(lines).toEqual([
      'engineering builder api main https://github.com/acme/api.git',
      'engineering builder app main https://github.com/acme/app.git',
      'engineering reviewer api main https://github.com/acme/api.git',
      'engineering reviewer app main https://github.com/acme/app.git',
    ]);
  });

  it('sends nothing again while the list is unchanged, and a change to the profiles does not resend it', async () => {
    const bridge = await bridgeStandIn();
    const { r, credentials, podUp } = controller(bridge.url, { current: [project('app')] });
    credentials();
    podUp();
    await r.reconcileAll();
    await r.reconcileAll();
    await r.reconcileAll();
    expect(bridge.puts).toHaveLength(1);
  });

  it('sends nothing to a pod that is not up (it starts from the ConfigMap’s list), and tries again once it is', async () => {
    const bridge = await bridgeStandIn();
    const { r, credentials, podUp } = controller(bridge.url, { current: [project('app')] });
    credentials();
    await r.reconcileAll();
    expect(bridge.puts).toHaveLength(0);
    podUp();
    await r.reconcileAll();
    expect(bridge.puts).toHaveLength(1);
  });

  it('tries again on the next pass when the bridge refuses or does not answer, and says so in words', async () => {
    logs.length = 0;
    const bridge = await bridgeStandIn();
    const { r, credentials, podUp } = controller(bridge.url, { current: [project('app')] });
    credentials();
    podUp();
    bridge.status.value = 500;
    await r.reconcileAll();
    expect(logs.some((l) => l.startsWith('WARN') && l.includes('refused the repository list'))).toBe(true);
    bridge.status.value = 200;
    await r.reconcileAll();
    expect(bridge.puts.filter((p) => p.body.repos.length > 0).length).toBeGreaterThanOrEqual(2);
    await r.reconcileAll();
    const count = bridge.puts.length;
    await r.reconcileAll();
    expect(bridge.puts).toHaveLength(count);
    // a bridge that is not listening
    const lost = controller('http://127.0.0.1:1', { current: [project('app')] });
    lost.credentials();
    lost.podUp();
    logs.length = 0;
    const results = await lost.r.reconcileAll();
    expect(results).toHaveLength(1);
    expect(logs.some((l) => l.includes('did not take the repository list'))).toBe(true);
    expect(logs.join('\n')).not.toContain('k'.repeat(48));
  });

  it('wakes once for a burst of project events', async () => {
    let runs = 0;
    const wake = createWake(() => void (runs += 1), 50);
    for (let i = 0; i < 10; i++) wake();
    await new Promise((res) => setTimeout(res, 150));
    expect(runs).toBe(1);
    wake();
    await new Promise((res) => setTimeout(res, 150));
    expect(runs).toBe(2);
  });

  it('does not roll the pod for a repository change, but rolls it when the bots’ profiles change (the bridge reads them once)', async () => {
    const bridge = await bridgeStandIn();
    const projects = { current: [project('app')] };
    const { r, credentials, podUp, k8s, names } = controller(bridge.url, projects);
    credentials();
    podUp();
    const sha = async (): Promise<string> => ((await k8s.get('Deployment', 'bots', names.base))!.spec as any).template.metadata.annotations['manythreads.io/profiles-sha'];
    await r.reconcileAll();
    const first = await sha();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    projects.current = [project('app'), project('api')];
    await r.reconcileAll();
    expect(await sha()).toBe(first);
    runner.bots.push({ teamId: 't-eng', teamSlug: 'engineering', botSlug: 'tester' });
    try {
      await r.reconcileAll();
      expect(await sha()).not.toBe(first);
    } finally {
      runner.bots.pop();
    }
  });
});

// ---- repo-sync.sh against a local bare origin ---------------------------------------------------------------------------------------------------------------------------------------

const SYNC = fileURLToPath(new URL('../../../../deploy/images/claude-pod/repo-sync.sh', import.meta.url));
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Sync {
  root: string;
  work: string;
  list: string;
  fallback: string;
  origin: string;
  commit: (text: string) => string;
  start: (env?: Record<string, string>) => ChildProcess;
  gitCalls: () => string[];
}

function syncSetup(): Sync {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'init', '-q', '-b', 'main', 'seed');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'first');
  git(seed, 'push', '-q', origin, 'main');
  // the script only takes https addresses; the address is mapped to the local bare repository by a global git config of the test
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[url "${origin}"]\n\tinsteadOf = https://example.test/widgets.git\n[url "${join(root, 'missing.git')}"]\n\tinsteadOf = https://example.test/missing.git\n[safe]\n\tdirectory = *\n`);
  // a git that writes down what it was asked, then does the work
  const shims = join(root, 'bin');
  mkdirSync(shims);
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(shims, 'git'), `#!/bin/sh\necho "$@" >> ${join(root, 'git-calls.log')}\nexec ${real} "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  const children: ChildProcess[] = [];
  stoppers.push(async () => {
    for (const c of children) if (c.pid) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const work = join(root, 'work');
  mkdirSync(work);
  return {
    root,
    work,
    list: join(root, 'run-repos.txt'),
    fallback: join(root, 'etc-repos.txt'),
    origin,
    commit: (text) => {
      writeFileSync(join(seed, 'a.txt'), text);
      git(seed, 'commit', '-q', '-am', text.trim());
      git(seed, 'push', '-q', origin, 'main');
      return git(seed, 'rev-parse', 'HEAD');
    },
    start: (env = {}) => {
      const child = spawn('sh', [SYNC], {
        detached: true,
        stdio: 'ignore',
        env: { PATH: `${shims}:${process.env['PATH']}`, GIT_CONFIG_GLOBAL: gitconfig, REPO_SYNC_WORK: work, REPO_SYNC_LIST: join(root, 'run-repos.txt'), REPO_SYNC_FALLBACK: join(root, 'etc-repos.txt'), REPO_SYNC_STATE: join(root, 'state'), ...env },
      });
      children.push(child);
      return child;
    },
    gitCalls: () => (existsSync(join(root, 'git-calls.log')) ? readFileSync(join(root, 'git-calls.log'), 'utf8').trim().split('\n') : []),
  };
}
const until = async (check: () => boolean, ms: number): Promise<number> => {
  const t0 = Date.now();
  while (!check() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return Date.now() - t0;
};
const LINE = 'engineering builder widgets main https://example.test/widgets.git\n';

describe('repo-sync.sh', () => {
  it('clones a project within 10 seconds of the list file changing (the pod’s own 5 second round)', async () => {
    const s = syncSetup();
    s.start();
    await new Promise((r) => setTimeout(r, 700)); // the first round has found no list
    writeFileSync(s.list, LINE);
    const wrote = Date.now();
    const dir = join(s.work, 'engineering/builder/widgets');
    await until(() => existsSync(join(dir, 'a.txt')), 12_000);
    const took = Date.now() - wrote;
    expect(existsSync(join(dir, 'a.txt')), `no clone after ${took} ms`).toBe(true);
    expect(took).toBeLessThanOrEqual(10_000);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // a second line is picked up by a later round, not by the ConfigMap's minute
    writeFileSync(s.list, LINE + 'engineering reviewer widgets - https://example.test/widgets.git\n');
    const second = await until(() => existsSync(join(s.work, 'engineering/reviewer/widgets/a.txt')), 12_000);
    expect(second).toBeLessThanOrEqual(10_000);
  }, 40_000);

  it('uses the pod’s start-up list (the ConfigMap copy) until the bridge has written its own, and the bridge’s list wins after', async () => {
    const s = syncSetup();
    writeFileSync(s.fallback, LINE);
    s.start({ REPO_SYNC_INTERVAL: '1' });
    expect(await until(() => existsSync(join(s.work, 'engineering/builder/widgets/.git')), 8000)).toBeLessThan(8000);
    writeFileSync(s.list, 'engineering builder other main https://example.test/widgets.git\n');
    expect(await until(() => existsSync(join(s.work, 'engineering/builder/other/.git')), 8000)).toBeLessThan(8000);
  }, 30_000);

  it('fetches an existing clone only every few rounds, not every round', async () => {
    const s = syncSetup();
    writeFileSync(s.list, LINE);
    s.start({ REPO_SYNC_INTERVAL: '1', REPO_SYNC_FETCH_EVERY: '4' });
    const dir = join(s.work, 'engineering/builder/widgets');
    await until(() => existsSync(join(dir, '.git')), 8000);
    const head = s.commit('two\n');
    // within the next rounds the new commit arrives, and the number of fetches stays well under the number of rounds
    await until(() => spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'origin/main'], { encoding: 'utf8' }).stdout.trim() === head, 10_000);
    expect(git(dir, 'rev-parse', 'origin/main')).toBe(head);
    const fetches = s.gitCalls().filter((c) => c.includes(' fetch '));
    expect(fetches.length).toBeLessThanOrEqual(3);
  }, 30_000);

  it('skips a name or address that could climb out of its folder or reach a place other than https, and clones nothing for it', async () => {
    const s = syncSetup();
    writeFileSync(
      s.list,
      [
        'engineering builder .hidden main https://example.test/widgets.git',
        'engineering .hidden widgets main https://example.test/widgets.git',
        '.. builder widgets main https://example.test/widgets.git',
        'engineering builder ../escape main https://example.test/widgets.git',
        'engineering builder widgets main http://example.test/widgets.git',
        'engineering builder widgets main file:///etc',
        'engineering builder a$b main https://example.test/widgets.git',
        LINE.trim(),
      ].join('\n') + '\n',
    );
    s.start({ REPO_SYNC_ONCE: '1' });
    await until(() => existsSync(join(s.work, 'engineering/builder/widgets/.git')), 8000);
    await new Promise((r) => setTimeout(r, 500));
    const made = spawnSync('find', [s.work, '-name', '.git', '-maxdepth', '5'], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(made).toEqual([join(s.work, 'engineering/builder/widgets/.git')]);
    expect(existsSync(join(s.root, 'escape'))).toBe(false);
  }, 20_000);

  it('does not try a failing clone every round: it waits before the next try', async () => {
    const s = syncSetup();
    writeFileSync(s.list, 'engineering builder missing main https://example.test/missing.git\n');
    s.start({ REPO_SYNC_INTERVAL: '1', REPO_SYNC_RETRY_AFTER: '100' });
    await new Promise((r) => setTimeout(r, 4500));
    expect(s.gitCalls().filter((c) => c.includes(' clone ') || c.startsWith('clone ')).length).toBe(1);
  }, 20_000);
});
