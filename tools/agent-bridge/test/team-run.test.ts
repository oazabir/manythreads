import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { startBridge, type Bridge } from '../src/server.ts';
import { startTeamSync } from '../src/server-team-sync.ts';
import { cleanTeamCodex } from '../src/server-team.ts';
import { parseHeader } from '../src/team-user.ts';
import { auth, KEY } from './support.ts';

// P26-22 through the real run manager: a team's run is started through `sudo -n -- <helper> run <team> <kind>` with the run's environment on the first line of standard input, and the bridge
// writes nothing into the team's home itself. `sudo` here is a script that notes how it was called, reads that first line and then becomes the fake ACP agent, the way the real helper
// becomes the real adapter (the real thing as root is run by install/container-test/run.sh).

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, '..', '..', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');
const TOKEN = 'run-token-0123456789abcdef'; // secret-scan:ignore a made-up fixture
const KUBE = 'apiVersion: v1\nkind: Config\nclusters: []\n';

let site: Server;
let base = '';
const siteState = { deployer: false };
const dirs: string[] = [];
let bridge: Bridge | undefined;
beforeAll(async () => {
  site = createServer((req, res) => {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (req.url === '/api/runs/self') return json(200, { teamSlug: 'eng', botSlug: 'builder', runId: 'r1', mayPublish: true });
    if (req.url === '/api/runs/self/kubeconfig') return siteState.deployer ? json(200, { kubeconfig: KUBE }) : json(404, {});
    json(404, {});
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => site.close());
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  siteState.deployer = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'team-run-'));
  dirs.push(dir);
  const root = join(dir, 'data');
  const capture = join(dir, 'capture');
  mkdirSync(capture, { recursive: true });
  const sudo = join(dir, 'fake-sudo');
  // the arguments go to a file, one run per file (the first word after `--` is the helper); the first line of standard input too; then the fake agent takes over standard input
  writeFileSync(
    sudo,
    `#!/bin/sh
n=$(ls "${capture}" | wc -l)
printf '%s\\n' "$*" > "${capture}/argv.$n"
case "$4" in
  ensure-user) exit 0 ;;
esac
IFS= read -r line
printf '%s' "$line" > "${capture}/header.$n"
FAKE_ACP_FLAVOR=claude FAKE_ACP_STATE_DIR="${dir}/fake-state" exec "${process.execPath}" --import "${TSX}" "${FAKE_CLI}"
`,
  );
  chmodSync(sudo, 0o755);
  const config = parseConfig({
    profiles: { 'claude-signin': { agent: 'claude-code', driver: 'acp', workdir: join(root, 'signin') } },
    server: { root, agents: { claude: { authHome: join(root, 'auth', 'claude'), acp: { command: '/not/used/claude-agent-acp' } }, codex: { authHome: join(root, 'auth', 'codex'), acp: { command: '/not/used/codex-acp' } } }, teamUsers: { helper: '/opt/manythreads-bridge/helper/mt-team-helper', sudo }, publisherSocket: '/run/p.sock' },
    killGraceSeconds: 0.5,
    budgetGraceSeconds: 0.2,
    cancelGraceSeconds: 2,
  });
  return { dir, root, capture, config };
}

async function runOnce(t: ReturnType<typeof setup>, profile: string, token = TOKEN): Promise<{ status: string }> {
  process.env['AGENT_BRIDGE_API_KEY'] = KEY;
  process.env['FAKE_ACP_FLAVOR'] = 'claude';
  bridge = await startBridge({ config: t.config, apiKey: KEY, stateDir: join(t.dir, 'state'), port: 0, log: () => undefined, tmpRoot: t.dir, siteUrl: base });
  const res = await fetch(`${bridge.url}/p/${profile}/v1/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'work', manythreads: { bot: 'builder', runId: 'run-1', tools: [], mcp: { url: `${base}/mcp`, token } } }),
  });
  const { run_id } = (await res.json()) as { run_id: string };
  const end = Date.now() + 20_000;
  for (;;) {
    const s = (await (await fetch(`${bridge.url}/p/${profile}/v1/runs/${run_id}`, { headers: auth })).json()) as { status: string };
    if (s.status !== 'running' && s.status !== 'queued') return s;
    if (Date.now() > end) throw new Error('the run did not end');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const read = (file: string): string => readFileSync(file, 'utf8');

describe('a team\'s run through the helper', () => {
  it('is started as `sudo -n -- <helper> run <team> <kind>`, the user is made first, and nothing is written into the team\'s home by the bridge', async () => {
    const t = setup();
    const end = await runOnce(t, 'claude--eng--builder');
    expect(end.status).toBe('completed');
    const calls = [0, 1].map((n) => read(join(t.capture, `argv.${n}`)).trim());
    expect(calls[0]).toBe('-n -- /opt/manythreads-bridge/helper/mt-team-helper ensure-user eng');
    expect(calls[1]).toBe('-n -- /opt/manythreads-bridge/helper/mt-team-helper run eng claude');
    // the bridge made no folder of the team's: the helper does, as the team's user
    expect(existsSync(join(t.root, 'work', 'eng'))).toBe(false);
  });

  it('the run token and the run\'s environment are in the header (standard input), never in an argument; the bridge\'s own key and variables are not anywhere', async () => {
    const t = setup();
    process.env['GITHUB_TOKEN'] = 'ghp_should_never_travel'; // secret-scan:ignore a made-up fixture
    try {
      await runOnce(t, 'claude--eng--builder');
    } finally {
      delete process.env['GITHUB_TOKEN'];
    }
    const argv = read(join(t.capture, 'argv.1'));
    expect(argv).not.toContain(TOKEN);
    const text = read(join(t.capture, 'header.1'));
    const parsed = parseHeader(text, { root: t.root, team: 'eng', kind: 'claude' });
    expect(parsed).toMatchObject({ ok: true, dropped: [] });
    if (!parsed.ok) return;
    expect(parsed.header.cwd).toBe(join(t.root, 'work', 'eng', 'builder'));
    expect(parsed.header.env['MANYTHREADS_RUN_TOKEN']).toBe(TOKEN);
    expect(parsed.header.env['CLAUDE_CONFIG_DIR']).toBe(join(t.root, 'auth', 'claude'));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('ghp_should_never_travel');
    expect(Object.keys(parsed.header.env)).not.toContain('HOME');
  });

  it('the deployer\'s kubeconfig goes to the helper as a file of the team\'s home and a folder to remove at the end; the bridge writes none', async () => {
    const t = setup();
    siteState.deployer = true;
    await runOnce(t, 'claude--eng--builder');
    const parsed = parseHeader(read(join(t.capture, 'header.1')), { root: t.root, team: 'eng', kind: 'claude' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const file = join(t.root, 'work', 'eng', 'kube', 'builder', 'run-1', 'config');
    expect(parsed.header.files).toEqual([{ path: file, text: KUBE, mode: '0600' }]);
    expect(parsed.header.removeAtEnd).toEqual([join(t.root, 'work', 'eng', 'kube', 'builder', 'run-1')]);
    expect(parsed.header.env['KUBECONFIG']).toBe(file);
    expect(existsSync(join(t.root, 'work'))).toBe(false);
    expect(existsSync(join(t.root, 'kube'))).toBe(false);
  });

  it('a Codex run (P31-01) names the team\'s own Codex home, never the machine\'s main copy, and the helper takes that header', async () => {
    const t = setup();
    await runOnce(t, 'codex--eng--builder');
    expect(read(join(t.capture, 'argv.1')).trim()).toBe('-n -- /opt/manythreads-bridge/helper/mt-team-helper run eng codex');
    const text = read(join(t.capture, 'header.1'));
    const parsed = parseHeader(text, { root: t.root, team: 'eng', kind: 'codex' });
    expect(parsed).toMatchObject({ ok: true, dropped: [] });
    if (!parsed.ok) return;
    expect(parsed.header.env['CODEX_HOME']).toBe(join(t.root, 'work', 'eng', '.codex'));
    expect(text).not.toContain(join(t.root, 'auth', 'codex'));
  });

  it('at start-up every team\'s copy of the Codex sign-in is removed: one `run <team> clean-codex` per team, never a word like "all"', async () => {
    const t = setup();
    const passwd = join(t.dir, 'passwd');
    writeFileSync(passwd, [`mt-team-eng:x:990:990::${join(t.root, 'work', 'eng')}:/usr/sbin/nologin`, `mt-team-mkt:x:991:991::${join(t.root, 'work', 'mkt')}:/usr/sbin/nologin`, 'root:x:0:0::/root:/bin/bash', ''].join('\n'));
    const logs: string[] = [];
    await cleanTeamCodex(t.config.server as never, (l) => logs.push(l), passwd);
    // the fake sudo numbers its files by how many are there already (an argv and a header per call)
    const calls = readdirSync(t.capture).filter((f) => f.startsWith('argv.')).sort().map((f) => read(join(t.capture, f)).trim());
    expect(calls).toEqual(['-n -- /opt/manythreads-bridge/helper/mt-team-helper run eng clean-codex', '-n -- /opt/manythreads-bridge/helper/mt-team-helper run mkt clean-codex']);
    expect(parseHeader(read(join(t.capture, 'header.0')), { root: t.root, team: 'eng', kind: 'clean-codex' })).toMatchObject({ ok: true });
  });

  it('a profile that is not a server-mode name (the sign-in profile) does not go through the helper', async () => {
    const t = setup();
    // the sign-in profile has no site questions and no team: it is the bridge's own user's
    process.env['AGENT_BRIDGE_API_KEY'] = KEY;
    bridge = await startBridge({ config: t.config, apiKey: KEY, stateDir: join(t.dir, 'state'), port: 0, log: () => undefined, tmpRoot: t.dir, siteUrl: base });
    const res = await fetch(`${bridge.url}/p/claude-signin/v1/runs/none`, { headers: auth });
    expect(res.status).toBe(404);
    expect(existsSync(join(t.capture, 'argv.0'))).toBe(false);
  });
});

describe('the repository sync of a team', () => {
  it('starts one step per team as that team\'s user with only its lines, restarts it when its lines change, and stops it when the team leaves the list', async () => {
    const t = setup();
    const started: Array<{ team: string; text: string }> = [];
    const stopped: string[] = [];
    const logs: string[] = [];
    const sync = startTeamSync({
      server: t.config.server as never,
      restartMs: 20,
      log: (l) => logs.push(l),
      start: (team, text) => {
        started.push({ team, text });
        let end!: (v: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError: string | null }) => void;
        const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError: string | null }>((r) => (end = r));
        return {
          signal: () => {
            stopped.push(team);
            end({ code: null, signal: 'SIGTERM', stderrTail: '', spawnError: null });
          },
          write: () => true,
          endInput: () => undefined,
          done,
        };
      },
    });
    // the user is made by the helper's ensure-user (the fake sudo exits 0)
    const eng = { team: 'eng', bot: 'builder', project: 'site', branch: 'main', origin: 'https://github.com/acme/site' };
    const mkt = { team: 'marketing', bot: 'writer', project: 'blog', branch: null, origin: 'https://github.com/acme/blog' };
    sync.update([eng, mkt]);
    await until(() => started.length === 2);
    expect(started.find((s) => s.team === 'eng')?.text).toBe('eng builder site main https://github.com/acme/site\n');
    expect(started.find((s) => s.team === 'marketing')?.text).toBe('marketing writer blog - https://github.com/acme/blog\n');
    expect(started.find((s) => s.team === 'eng')?.text).not.toContain('marketing');
    sync.update([eng, mkt]);
    await new Promise((r) => setTimeout(r, 60));
    expect(started).toHaveLength(2);
    sync.update([{ ...eng, project: 'site2' }, mkt]);
    await until(() => started.length === 3);
    expect(started[2]).toMatchObject({ team: 'eng' });
    expect(stopped).toEqual(['eng']);
    sync.update([mkt]);
    await until(() => stopped.length === 2);
    expect(stopped).toEqual(['eng', 'eng']);
    await sync.close();
  });
});

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
