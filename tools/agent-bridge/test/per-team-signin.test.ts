import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, profileFor, serverSigninScope, serverSigninUnreadable, type BridgeConfig } from '../src/config.ts';
import { helloFor } from '../src/server-mode.ts';
import { startBridge, type Bridge } from '../src/server.ts';
import { loadSigninScope, saveSigninScope } from '../src/signin-scope.ts';
import { ownSigninFolderOk, parseHelperConfig, programFor, signinFactsOf, signinFoldersOf, underTerminal } from '../src/team-helper.ts';
import { FACTS_UNKNOWN, SigninGate } from '../src/signin.ts';
import { parseHeader, teamSigninDir, type HeaderContext } from '../src/team-user.ts';
import { teamNotSignedInHere } from '../src/runs.ts';
import { KEY } from './support.ts';

// P35-10b: one sign-in per team on an enrolled server (docs/plans/per-team-sign-in.md sections 4 and 7). The pure rules (the header the root helper takes, the programs of the sign-in
// kinds) and the bridge's half through a fake `sudo` that notes how it was called and plays the helper: it reads the header from the pipe, takes the team's own folder from it and
// becomes the fake agent, its terminal sign-in program, or the end of a start-nothing kind. No root, no real account: every folder is a scratch one, every name ends in example.test.

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, '..', '..', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');
const ROOT = '/srv/mt';
const CODE = 'fake-code#state'; // secret-scan:ignore a made-up fixture
const API_KEY = 'sk-fake-team-key-0123456789'; // secret-scan:ignore a made-up fixture

const ctx = (kind: HeaderContext['kind']): HeaderContext => ({ root: ROOT, team: 'eng', kind });
/** A header as the bridge writes it; `perTeam` adds `signIn: per_team` (the bridge says which choice the run is of). */
const header = (env: Record<string, string>, more: Record<string, unknown> = {}, perTeam = false): string =>
  JSON.stringify({ v: 1, cwd: `${ROOT}/work/eng`, env, files: [], removeAtEnd: [], ...(perTeam ? { signIn: 'per_team' } : {}), ...more });
const ownClaude = `${ROOT}/work/eng/.signin/claude`;
const ownCodex = `${ROOT}/work/eng/.signin/codex`;

describe('the header rule of a team\'s own sign-in (parseHeader)', () => {
  it('a run of a per-team runner names the team\'s own folder and never the shared one; a run of a shared runner the shared one and never its own (a leftover .signin decides nothing)', () => {
    expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }, {}, true), ctx('claude'))).toMatchObject({ ok: true, header: { signIn: 'per_team' } });
    expect(parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude` }), ctx('claude'))).toMatchObject({ ok: true });
    const refused = parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude` }, {}, true), ctx('claude'));
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.error).toContain(ownClaude);
    expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }), ctx('claude'))).toMatchObject({ ok: false });
    // another team's own folder is never this team's; a made-up mode is refused
    expect(parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/work/mkt/.signin/claude` }, {}, true), ctx('claude'))).toMatchObject({ ok: false });
    expect(parseHeader(header({}, { signIn: 'shared' }), ctx('claude'))).toMatchObject({ ok: false });
  });

  it('Codex: the copy-in home only for a shared Codex run; its own .signin/codex for a per-team run and for the Codex sign-in kinds', () => {
    expect(parseHeader(header({ CODEX_HOME: `${ROOT}/work/eng/.codex` }), ctx('codex'))).toMatchObject({ ok: true });
    expect(parseHeader(header({ CODEX_HOME: `${ROOT}/work/eng/.codex` }, {}, true), ctx('codex'))).toMatchObject({ ok: false });
    expect(parseHeader(header({ CODEX_HOME: ownCodex }, {}, true), ctx('codex'))).toMatchObject({ ok: true });
    expect(parseHeader(header({ CODEX_HOME: ownCodex }), ctx('codex'))).toMatchObject({ ok: false });
    for (const kind of ['codex-key', 'codex-logout'] as const) {
      expect(parseHeader(header({ CODEX_HOME: ownCodex }), ctx(kind))).toMatchObject({ ok: true });
      expect(parseHeader(header({ CODEX_HOME: `${ROOT}/work/eng/.codex` }), ctx(kind))).toMatchObject({ ok: false });
      expect(parseHeader(header({}), ctx(kind))).toMatchObject({ ok: false });
    }
    expect(parseHeader(header({ CODEX_HOME: ownCodex }, {}, true), ctx('claude'))).toMatchObject({ ok: false });
    expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }, {}, true), ctx('hermes'))).toMatchObject({ ok: false });
  });

  it('the Claude sign-in kinds need the team\'s own Claude folder; clean-signin and signin-facts name exactly one own folder and refuse any header that names a shared one', () => {
    for (const kind of ['claude-login', 'claude-logout'] as const) {
      expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }), ctx(kind))).toMatchObject({ ok: true });
      expect(parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude` }), ctx(kind))).toMatchObject({ ok: false });
    }
    for (const kind of ['clean-signin', 'signin-facts'] as const) {
      expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }), ctx(kind))).toMatchObject({ ok: true });
      expect(parseHeader(header({ CODEX_HOME: ownCodex }), ctx(kind))).toMatchObject({ ok: true });
      expect(parseHeader(header({}), ctx(kind))).toMatchObject({ ok: false });
      expect(parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude, CODEX_HOME: ownCodex }), ctx(kind))).toMatchObject({ ok: false });
      // the review's case: a shared folder beside an own one is refused, whatever the other says
      expect(parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude`, CODEX_HOME: ownCodex }), ctx(kind))).toMatchObject({ ok: false });
      expect(parseHeader(header({ CODEX_HOME: `${ROOT}/work/eng/.codex` }), ctx(kind))).toMatchObject({ ok: false });
    }
  });

  it('refuses a file written into .signin or the folder itself, and .signin in removeAtEnd', () => {
    const file = (path: string) => header({}, { files: [{ path, text: 'x', mode: '0600' }] });
    expect(parseHeader(file(`${ROOT}/work/eng/.signin/claude/.credentials.json`), ctx('claude'))).toMatchObject({ ok: false });
    expect(parseHeader(file(`${ROOT}/work/eng/.signin`), ctx('claude'))).toMatchObject({ ok: false });
    expect(parseHeader(file(`${ROOT}/work/eng/kube/b/r/config`), ctx('claude'))).toMatchObject({ ok: true });
    // a folder that only starts with the same letters is not .signin
    expect(parseHeader(file(`${ROOT}/work/eng/.signin-notes`), ctx('claude'))).toMatchObject({ ok: true });
    for (const p of [`${ROOT}/work/eng/.signin`, `${ROOT}/work/eng/.signin/codex`]) expect(parseHeader(header({}, { removeAtEnd: [p] }), ctx('claude'))).toMatchObject({ ok: false });
  });
});

describe('the helper\'s sign-in kinds (no root: the pure parts)', () => {
  const cfg = parseHelperConfig(JSON.stringify({ dataRoot: ROOT, agents: { claude: { command: '/opt/a/claude-agent-acp' }, codex: { command: '/opt/a/codex-acp', cli: '/opt/a/codex' } } }));

  it('the table takes Codex\'s own program as `cli`, and only for Codex, as an absolute path', () => {
    expect(cfg.agents.codex?.cli).toBe('/opt/a/codex');
    expect(() => parseHelperConfig(JSON.stringify({ dataRoot: ROOT, agents: { claude: { command: '/opt/a/c', cli: '/opt/a/claude' } } }))).toThrow(/Codex only/);
    expect(() => parseHelperConfig(JSON.stringify({ dataRoot: ROOT, agents: { codex: { command: '/opt/a/c', cli: 'codex' } } }))).toThrow(/absolute/);
  });

  it('claude-login and claude-logout run the adapter\'s own program under a terminal the helper makes (`script -e`), with fixed words only', () => {
    const login = programFor(cfg, 'claude-login', '/usr/bin/script');
    expect(login?.argv.slice(0, 5)).toEqual(['/usr/bin/script', '-q', '-e', '-f', '-c']);
    expect(login?.argv[6]).toBe('/dev/null');
    expect(() => programFor(cfg, 'claude-login', null)).toThrow(/script is needed/);
    // what `script` hands to its shell, run here with `echo` in place of the adapter: the measured words and nothing else, a quote in a path still one word
    const said = (argv: readonly string[]): string => spawnSync('/bin/sh', ['-c', argv[5]!], { encoding: 'utf8' }).stdout.trim();
    const echo = parseHelperConfig(JSON.stringify({ dataRoot: ROOT, agents: { claude: { command: '/bin/echo', args: ["it's"] } } }));
    expect(said(programFor(echo, 'claude-login', '/usr/bin/script')!.argv)).toBe("it's --cli auth login --claudeai");
    expect(said(programFor(echo, 'claude-logout', '/usr/bin/script')!.argv)).toBe("it's --cli auth logout");
    expect(underTerminal('/usr/bin/script', ['/bin/echo', 'a b'])[0]).toBe('/usr/bin/script');
  });

  it('codex-key reads the key from standard input (no argument holds it), codex-logout is Codex\'s own, clean-signin and signin-facts start nothing', () => {
    expect(programFor(cfg, 'codex-key')?.argv).toEqual(['/opt/a/codex', 'login', '--with-api-key']);
    expect(programFor(cfg, 'codex-logout')?.argv).toEqual(['/opt/a/codex', 'logout']);
    expect(programFor(cfg, 'clean-signin')).toBeNull();
    expect(programFor(cfg, 'signin-facts')).toBeNull();
    const noCli = parseHelperConfig(JSON.stringify({ dataRoot: ROOT, agents: { codex: { command: '/opt/a/codex-acp' } } }));
    expect(() => programFor(noCli, 'codex-key')).toThrow(/--update/);
  });

  it('the team\'s own folders a header names are made by the team user (.signin first); the machine\'s folders are not', () => {
    const own = parseHeader(header({ CLAUDE_CONFIG_DIR: ownClaude }, {}, true), ctx('claude'));
    if (!own.ok) throw new Error(own.error);
    expect(signinFoldersOf(own.header, ROOT, 'eng')).toEqual([`${ROOT}/work/eng/.signin`, ownClaude]);
    const shared = parseHeader(header({ CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude` }), ctx('claude'));
    if (!shared.ok) throw new Error(shared.error);
    expect(signinFoldersOf(shared.header, ROOT, 'eng')).toEqual([]);
  });

  it('root acts on a team\'s own folder only when .signin and the folder are plain folders (no link) and .signin is the team user\'s; another path is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'per-team-'));
    const uid = process.getuid?.() ?? 0;
    try {
      const own = teamSigninDir(dir, 'eng', 'claude');
      expect(ownSigninFolderOk(dir, 'eng', own, uid)).toBe(true); // nothing there yet: nothing to remove
      mkdirSync(own, { recursive: true });
      expect(ownSigninFolderOk(dir, 'eng', own, uid)).toBe(true);
      expect(ownSigninFolderOk(dir, 'eng', own, uid + 1)).toBe(false);
      expect(ownSigninFolderOk(dir, 'eng', join(dir, 'work', 'eng', '.signin', 'other'), uid)).toBe(false);
      expect(ownSigninFolderOk(dir, 'eng', join(dir, 'auth', 'claude'), uid)).toBe(false);
      mkdirSync(join(dir, 'elsewhere'));
      symlinkSync(join(dir, 'elsewhere'), teamSigninDir(dir, 'eng', 'codex'));
      expect(ownSigninFolderOk(dir, 'eng', teamSigninDir(dir, 'eng', 'codex'), uid)).toBe(false);
      // a .signin that is itself a link (another team's, the machine's) is never acted on
      mkdirSync(join(dir, 'work', 'mkt'), { recursive: true });
      symlinkSync(join(dir, 'work', 'eng', '.signin'), join(dir, 'work', 'mkt', '.signin'));
      expect(ownSigninFolderOk(dir, 'mkt', teamSigninDir(dir, 'mkt', 'claude'), uid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('signin-facts prints the dates and the shape of a sign-in file, never a token', () => {
    const TOKEN = 'sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE'; // secret-scan:ignore a made-up fixture
    const claude = signinFactsOf('claude', JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN, expiresAt: 1_900_000_000_000, scopes: ['user:inference'] } }), 5);
    expect(claude).toEqual({ exists: true, valid: true, expiresAt: 1_900_000_000_000, refreshedAt: null, mtimeMs: 5 });
    expect(JSON.stringify(claude)).not.toContain(TOKEN);
    expect(signinFactsOf('claude', 'not json', 1)).toMatchObject({ exists: true, valid: false });
    expect(signinFactsOf('codex', null, null)).toEqual({ exists: false, valid: false, expiresAt: null, refreshedAt: null, mtimeMs: null });
  });
});

describe('the gate of a team\'s own sign-in (no file the bridge can read)', () => {
  const twoAtOnce = async (gate: SigninGate): Promise<number> => {
    let live = 0;
    let most = 0;
    const one = () => gate.run(async () => {
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 60));
      live -= 1;
    });
    await Promise.all([one(), one()]);
    return most;
  };

  it('facts it cannot learn hold one run of the team at a time, so two runs never both renew; facts far from a renewal let them go together', async () => {
    let refreshed = 0;
    const unknown = new SigninGate('/nowhere', Date.now, 'claude-code', { facts: () => FACTS_UNKNOWN, refresh: async () => void (refreshed += 1) });
    expect(await twoAtOnce(unknown)).toBe(1);
    expect(refreshed).toBeGreaterThanOrEqual(2);
    const far = { exists: true, valid: true, scopeOk: true, expiresAt: Date.now() + 86_400_000, refreshedAt: null, mtimeMs: 1 };
    expect(await twoAtOnce(new SigninGate('/nowhere', Date.now, 'claude-code', { facts: () => far, refresh: async () => undefined }))).toBe(2);
    const near = { ...far, expiresAt: Date.now() + 60_000 };
    expect(await twoAtOnce(new SigninGate('/nowhere', Date.now, 'claude-code', { facts: () => near, refresh: async () => undefined }))).toBe(1);
  });
});

// ---- through the bridge ----------------------------------------------------------------------------------------------------------------------------------------------------

let bridge: Bridge | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  dir: string;
  root: string;
  capture: string;
  shared: { claude: string; codex: string };
  config: BridgeConfig;
  logs: string[];
  calls(): Array<{ argv: string; header: string }>;
}

function world(o: { teamUsers?: boolean } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'per-team-signin-'));
  dirs.push(dir);
  const root = join(dir, 'data');
  const capture = join(dir, 'capture');
  mkdirSync(capture, { recursive: true });
  const shared = { claude: join(dir, 'shared-claude'), codex: join(dir, 'shared-codex') };
  for (const d of Object.values(shared)) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'auth.json'), JSON.stringify({ signedIn: true, kind: 'account' }));
  }
  const sudo = join(dir, 'fake-sudo');
  const node = `"${process.execPath}" --import "${TSX}" "${FAKE_CLI}"`;
  // `-n -- <helper> run <team> <kind>`: $4 the command, $5 the team, $6 the kind. The header names the team's own folder, which is the fake's state folder.
  writeFileSync(
    sudo,
    `#!/bin/sh
n=$(ls "${capture}" | grep -c '^argv\\.')
printf '%s\\n' "$*" > "${capture}/argv.$n"
[ "$4" = ensure-user ] && exit 0
IFS= read -r line
printf '%s' "$line" > "${capture}/header.$n"
state=$(printf '%s' "$line" | sed -n 's/.*"\\(CLAUDE_CONFIG_DIR\\|CODEX_HOME\\)":"\\([^"]*\\)".*/\\2/p')
[ -n "$state" ] || state="${dir}/none"
export FAKE_ACP_STATE_DIR="$state" FAKE_ACP_SIGNED_OUT=1 FAKE_ACP_SIGNIN_CODE='${CODE}'
case "$6" in
  claude|codex) mkdir -p "$state"; date +%s%N > "${capture}/start.$n"; trap 'date +%s%N > "${capture}/end.$n"; exit 0' TERM INT HUP; FAKE_ACP_FLAVOR="$6" ${node}; rc=$?; date +%s%N > "${capture}/end.$n"; exit $rc ;;
  signin-facts) exit 1 ;;
  claude-login) mkdir -p "$state"; FAKE_ACP_FLAVOR=claude exec ${node} --cli auth login --claudeai ;;
  claude-logout) FAKE_ACP_FLAVOR=claude exec ${node} --cli auth logout ;;
  codex-key) IFS= read -r key; printf '%s' "$key" > "${capture}/key.$n"; mkdir -p "$state"; printf '{"signedIn":true,"kind":"account"}' > "$state/auth.json"; exit 0 ;;
  codex-logout) printf '{"signedIn":false,"kind":"none"}' > "$state/auth.json"; exit 0 ;;
  clean-signin) rm -rf "$state"; exit 0 ;;
esac
exit 64
`,
  );
  chmodSync(sudo, 0o755);
  const fake = { command: process.execPath, args: ['--import', TSX, FAKE_CLI] };
  const config = parseConfig({
    profiles: {
      'claude-signin': { agent: 'claude-code', driver: 'acp', workdir: join(root, 'signin'), authHome: join(root, 'auth', 'claude'), acp: fake, env: { FAKE_ACP_FLAVOR: 'claude', FAKE_ACP_STATE_DIR: shared.claude } },
      'codex-signin': { agent: 'codex', driver: 'acp', workdir: join(root, 'signin'), authHome: join(root, 'auth', 'codex'), acp: fake, env: { FAKE_ACP_FLAVOR: 'codex', FAKE_ACP_STATE_DIR: shared.codex } },
    },
    server: {
      root,
      agents: { claude: { authHome: join(root, 'auth', 'claude'), acp: { command: '/not/used/claude-agent-acp' } }, codex: { authHome: join(root, 'auth', 'codex'), acp: { command: '/not/used/codex-acp' } } },
      ...(o.teamUsers === false ? {} : { teamUsers: { helper: '/opt/manythreads-bridge/helper/mt-team-helper', sudo } }),
    },
    killGraceSeconds: 0.5,
    budgetGraceSeconds: 0.2,
    cancelGraceSeconds: 2,
  });
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    dir,
    root,
    capture,
    shared,
    config,
    logs: [],
    calls: () =>
      readdirSync(capture)
        .filter((f) => f.startsWith('argv.'))
        .map((f) => Number(f.slice(5)))
        .sort((a, b) => a - b)
        .map((n) => ({ argv: read(join(capture, `argv.${n}`)).trim(), header: read(join(capture, `header.${n}`)) })),
  };
}

async function start(w: World, o: { scopeFile?: string; teamsHere?: string[]; cleanSignin?: (team: string) => Promise<boolean>; teamFacts?: () => Promise<null> } = {}): Promise<Bridge> {
  process.env['AGENT_BRIDGE_API_KEY'] = KEY;
  bridge = await startBridge({
    config: w.config,
    apiKey: KEY,
    stateDir: join(w.dir, 'state'),
    port: 0,
    log: (l) => w.logs.push(l),
    tmpRoot: w.dir,
    siteUrl: 'http://site.example.test',
    signinScopeFile: o.scopeFile ?? join(w.dir, 'state', 'signin-scope.json'),
    teamsHere: () => o.teamsHere ?? ['eng', 'mkt'],
    ...(o.cleanSignin ? { cleanSignin: o.cleanSignin } : {}),
    ...(o.teamFacts ? { teamFacts: o.teamFacts } : {}),
    afterCodexSignOut: async () => undefined,
    auth: { startWaitMs: 4000, pushWaitMs: 800 },
  });
  return bridge;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function api(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${bridge!.url}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runOnce(profile: string): Promise<Json> {
  const res = await api('POST', `/p/${profile}/v1/runs`, { input: 'hello', manythreads: { bot: 'builder', runId: 'run-1', tools: [] } });
  const id = res.body['run_id'] as string;
  return until(() => api('GET', `/p/${profile}/v1/runs/${id}`).then((r) => r.body), (s) => s['status'] !== 'running', 20_000);
}

describe('a server where each team signs in, through the bridge', () => {
  it('a team is refused while the server has one sign-in, and on a server without team users', async () => {
    const w = world();
    await start(w);
    const one = await api('GET', '/v1/auth/status?agent=claude-code&team=eng');
    expect(one.status).toBe(409);
    expect(one.body['error']['code']).toBe('one_sign_in');
    await bridge!.close();
    const solo = world({ teamUsers: false });
    await start(solo);
    expect((await api('GET', '/v1/auth/status?agent=claude-code&team=eng')).body['error']['code']).toBe('no_team_users');
    const scope = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] });
    expect(scope.status).toBe(409);
    expect(scope.body['error']['code']).toBe('no_team_users');
    expect(await helloFor(solo.config)).toMatchObject({ teamUsers: false });
    expect(await helloFor(w.config)).toMatchObject({ teamUsers: true });
  });

  it('to per team: the shared sign-in is signed out for real first, the choice is kept in the state folder, and every bot\'s profile is made again with the team\'s own folder', async () => {
    const w = world();
    // a profile made before the switch is cached: the switch must forget it
    expect(profileFor(w.config, 'claude--eng--builder')?.profile.authHome).toBe(join(w.root, 'auth', 'claude'));
    await start(w);
    const out = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] });
    expect(out).toMatchObject({ status: 200, body: { scope: 'per_team', signedOut: 1 } });
    expect(JSON.parse(readFileSync(join(w.shared.claude, 'auth.json'), 'utf8'))).toMatchObject({ signedIn: false });
    expect(serverSigninScope(w.config, 'claude')).toBe('per_team');
    expect(serverSigninScope(w.config, 'codex')).toBe('shared');
    expect(JSON.parse(readFileSync(join(w.dir, 'state', 'signin-scope.json'), 'utf8'))).toMatchObject({ claude: 'per_team', codex: 'shared' });
    const made = profileFor(w.config, 'claude--eng--builder')?.profile;
    expect(made?.env?.['CLAUDE_CONFIG_DIR']).toBe(teamSigninDir(w.root, 'eng', 'claude'));
    expect(made?.authHome).toBeUndefined();
    // a restart reads the kept choice
    const again = world().config;
    loadSigninScope(again, join(w.dir, 'state', 'signin-scope.json'));
    expect(serverSigninScope(again, 'claude')).toBe('per_team');
    // the shared folder takes no new sign-in now
    expect((await api('POST', '/v1/auth/login?agent=claude-code', { methodId: 'x' })).body['error']['code']).toBe('team_needed');
  });

  it('a signed-out team\'s run is refused at once with the plain sentence; the team signs in as its own user through the helper\'s terminal kind; then its run goes', async () => {
    const w = world();
    await start(w);
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] })).status).toBe(200);
    const refused = await runOnce('claude--eng--builder');
    expect(refused).toMatchObject({ status: 'failed', error: teamNotSignedInHere('eng', 'claude') });
    // the probe ran as the team user, with the team's own folder as Claude's home, and the helper takes that header
    const probe = w.calls().find((c) => c.argv.endsWith('run eng claude'));
    expect(probe).toBeDefined();
    const parsed = parseHeader(probe!.header, { root: w.root, team: 'eng', kind: 'claude' });
    expect(parsed).toMatchObject({ ok: true, header: { env: { CLAUDE_CONFIG_DIR: teamSigninDir(w.root, 'eng', 'claude') } } });

    const status = await api('GET', '/v1/auth/status?agent=claude-code&team=eng');
    expect(status.body['auth']).toMatchObject({ state: 'signed_out' });
    const method = (status.body['auth']['methods'] as Json[]).find((m) => m['how'] === 'paste_code');
    expect(method).toBeDefined();
    const login = await api('POST', '/v1/auth/login?agent=claude-code&team=eng', { methodId: method!['id'] });
    expect(login.status).toBe(200);
    const waiting = await until(() => api('GET', '/v1/auth/status?agent=claude-code&team=eng').then((r) => r.body['auth']['attempt'] as Json), (a) => a?.['state'] === 'needs_input');
    expect(waiting['action']).toMatchObject({ type: 'paste_code' });
    expect(String(waiting['action']['url'])).toMatch(/^https:\/\/claude\.example\.test\//);
    const terminal = w.calls().find((c) => c.argv.endsWith('run eng claude-login'));
    expect(terminal).toBeDefined();
    expect(parseHeader(terminal!.header, { root: w.root, team: 'eng', kind: 'claude-login' })).toMatchObject({ ok: true });
    const answered = await api('POST', '/v1/auth/login/answer?agent=claude-code&team=eng', { attemptId: waiting['id'], code: CODE });
    expect(answered.status).toBe(200);
    await until(() => api('GET', '/v1/auth/status?agent=claude-code&team=eng').then((r) => r.body['auth'] as Json), (a) => a['state'] === 'signed_in');
    // the code went to the program and to no header and no argument
    for (const c of w.calls()) expect(`${c.argv}${c.header}`).not.toContain(CODE);
    const ran = await runOnce('claude--eng--builder');
    expect(ran['status']).toBe('completed');
    const run = w.calls().filter((c) => c.argv.endsWith('run eng claude')).pop();
    expect(JSON.parse(run!.header)['env']['CLAUDE_CONFIG_DIR']).toBe(teamSigninDir(w.root, 'eng', 'claude'));

    // the team's own sign-out: only its own folder, as its own user
    const out = await api('POST', '/v1/auth/logout?agent=claude-code&team=eng', {});
    expect(out.body['auth']).toMatchObject({ state: 'signed_out' });
    expect(JSON.parse(readFileSync(join(w.shared.claude, 'auth.json'), 'utf8'))).toMatchObject({ signedIn: false });
  }, 60_000);

  it('Codex with an API key: the key goes on the helper\'s pipe after the header (`codex-key`), and is in no header, no argument and no log line', async () => {
    const w = world();
    await start(w);
    expect((await api('POST', '/v1/signin/scope?agent=codex', { scope: 'per_team', teams: [] })).status).toBe(200);
    const status = await api('GET', '/v1/auth/status?agent=codex&team=eng');
    const method = (status.body['auth']['methods'] as Json[]).find((m) => m['how'] === 'api_key');
    expect(method).toBeDefined();
    const login = await api('POST', '/v1/auth/login?agent=codex&team=eng', { methodId: method!['id'] });
    expect(login.body['attempt']).toMatchObject({ state: 'needs_input', action: { type: 'give_key' } });
    await api('POST', '/v1/auth/login/answer?agent=codex&team=eng', { attemptId: login.body['attempt']['id'], apiKey: API_KEY });
    await until(() => api('GET', '/v1/auth/status?agent=codex&team=eng').then((r) => r.body['auth'] as Json), (a) => a['attempt']?.['state'] === 'done' || a['state'] === 'signed_in');
    const call = w.calls().findIndex((c) => c.argv.endsWith('run eng codex-key'));
    expect(call).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(w.capture, `key.${call}`), 'utf8')).toBe(API_KEY);
    for (const c of w.calls()) expect(`${c.argv}${c.header}`).not.toContain(API_KEY);
    expect(w.logs.join('\n')).not.toContain(API_KEY);
    expect(parseHeader(w.calls()[call]!.header, { root: w.root, team: 'eng', kind: 'codex-key' })).toMatchObject({ ok: true });
  }, 60_000);

  it('back to one sign-in: each listed team is signed out as its own user, every team\'s own folder of that agent is removed as its user (clean-signin), and the choice is shared again', async () => {
    const w = world();
    await start(w);
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] })).status).toBe(200);
    // team eng is signed in on its own
    mkdirSync(teamSigninDir(w.root, 'eng', 'claude'), { recursive: true });
    writeFileSync(join(teamSigninDir(w.root, 'eng', 'claude'), 'auth.json'), JSON.stringify({ signedIn: true, kind: 'account' }));
    const out = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: ['eng'] });
    expect(out).toMatchObject({ status: 200, body: { scope: 'shared', signedOut: 1 } });
    const cleaned = w.calls().filter((c) => c.argv.includes('clean-signin'));
    expect(cleaned.map((c) => c.argv.split(' ').slice(-2).join(' '))).toEqual(['eng clean-signin', 'mkt clean-signin']);
    for (const c of cleaned) expect(parseHeader(c.header, { root: w.root, team: c.argv.split(' ').at(-2)!, kind: 'clean-signin' })).toMatchObject({ ok: true });
    expect(existsSync(teamSigninDir(w.root, 'eng', 'claude'))).toBe(false);
    expect(serverSigninScope(w.config, 'claude')).toBe('shared');
    expect(profileFor(w.config, 'claude--eng--builder')?.profile.authHome).toBe(join(w.root, 'auth', 'claude'));
    // the same choice twice is nothing to do
    expect(await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: [] })).toMatchObject({ status: 200, body: { signedOut: 0 } });
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'nope' })).status).toBe(400);
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: ['../x'] })).status).toBe(400);
  }, 60_000);
});

describe('the kept choice and an honest switch (review of P35-10b)', () => {
  it('the choice is written before it changes: a state folder that cannot be written refuses the switch and leaves the choice as it was', async () => {
    const w = world();
    writeFileSync(join(w.dir, 'blocker'), 'a file where the folder should be');
    await start(w, { scopeFile: join(w.dir, 'blocker', 'signin-scope.json') });
    const out = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] });
    expect(out.status).toBe(500);
    expect(out.body['error']['code']).toBe('not_saved');
    expect(serverSigninScope(w.config, 'claude')).toBe('shared');
  });

  it('a kept file that is there and cannot be read is an error: runs of Claude and Codex are refused, the hello says so, and a switch writes it again', async () => {
    const w = world();
    const file = join(w.dir, 'state', 'signin-scope.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(loadSigninScope(w.config, file)).toBe('unreadable');
    expect(serverSigninUnreadable(w.config)).toBe(true);
    expect(await helloFor(w.config)).toMatchObject({ signInScope: { claude: 'unreadable', codex: 'unreadable' } });
    await start(w);
    expect(await runOnce('claude--eng--builder')).toMatchObject({ status: 'failed', error: expect.stringContaining('could not read who signs in to Claude Code') });
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: [] })).status).toBe(200);
    expect(serverSigninUnreadable(w.config)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ claude: 'shared', codex: 'shared' });
    expect(await helloFor(w.config)).toMatchObject({ signInScope: { claude: 'shared', codex: 'shared' } });
    // a missing file is one sign-in, not an error
    const fresh = world();
    expect(loadSigninScope(fresh.config, join(fresh.dir, 'none.json'))).toBe('missing');
    expect(serverSigninUnreadable(fresh.config)).toBe(false);
  });

  it('back to one sign-in asks only teams with a user here (no user is made), cleans each, and the same choice again does the work again', async () => {
    const w = world();
    const cleaned: string[] = [];
    await start(w, { teamsHere: ['eng', 'mkt'], cleanSignin: async (t) => (cleaned.push(t), true) });
    const out = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: ['eng', 'ghost'] });
    expect(out).toMatchObject({ status: 200, body: { scope: 'shared', notSignedOut: [], notCleaned: [] } });
    expect(w.calls().some((c) => c.argv.includes(' ghost '))).toBe(false);
    expect(cleaned).toEqual(['eng', 'mkt']);
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: [] })).status).toBe(200);
    expect(cleaned).toEqual(['eng', 'mkt', 'eng', 'mkt']);
  });

  it('a team whose folder could not be removed leaves the old choice, and the answer says which teams were signed out and which were not cleaned', async () => {
    const w = world();
    await start(w, { cleanSignin: async (t) => t !== 'mkt' });
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] })).status).toBe(200);
    mkdirSync(teamSigninDir(w.root, 'eng', 'claude'), { recursive: true });
    writeFileSync(join(teamSigninDir(w.root, 'eng', 'claude'), 'auth.json'), JSON.stringify({ signedIn: true, kind: 'account' }));
    const out = await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'shared', teams: ['eng'] });
    expect(out).toMatchObject({ status: 200, body: { scope: 'per_team', signedOutTeams: ['eng'], notSignedOut: [], notCleaned: ['mkt'] } });
    expect(serverSigninScope(w.config, 'claude')).toBe('per_team');
  }, 60_000);

  it('the teams a per-team call named are kept; while the agent has one sign-in the hello names those left, so a switch back can clean them', async () => {
    const w = world();
    saveSigninScope(w.config, undefined, { agent: 'claude', addOwn: ['eng'] });
    expect(await helloFor(w.config)).toMatchObject({ signInScope: { claude: 'shared' }, staleSignins: { claude: ['eng'] } });
    saveSigninScope(w.config, undefined, { agent: 'claude', scope: 'per_team' });
    expect((await helloFor(w.config))['staleSignins']).toBeUndefined();
  });

  it('two runs of one team at once, with the team\'s sign-in dates unknown to the bridge, run one after the other (only one can renew)', async () => {
    const w = world();
    let asked = 0;
    await start(w, { teamFacts: async () => (asked += 1, null) });
    expect((await api('POST', '/v1/signin/scope?agent=claude-code', { scope: 'per_team', teams: [] })).status).toBe(200);
    mkdirSync(teamSigninDir(w.root, 'eng', 'claude'), { recursive: true });
    writeFileSync(join(teamSigninDir(w.root, 'eng', 'claude'), 'auth.json'), JSON.stringify({ signedIn: true, kind: 'account' }));
    const [a, b] = await Promise.all([runOnce('claude--eng--alpha'), runOnce('claude--eng--beta')]);
    expect([a['status'], b['status']]).toEqual(['completed', 'completed']);
    expect(asked).toBeGreaterThanOrEqual(2);
    // the two runs (not the probe of the team's state, whose working folder is the team's home) did not overlap
    const runs = readdirSync(w.capture)
      .filter((f) => f.startsWith('start.'))
      .map((f) => Number(f.slice(6)))
      .filter((n) => /\/work\/eng\/(alpha|beta)"/.test(readFileSync(join(w.capture, `header.${n}`), 'utf8')))
      .map((n) => ({ start: Number(readFileSync(join(w.capture, `start.${n}`), 'utf8')), end: Number(readFileSync(join(w.capture, `end.${n}`), 'utf8')) }))
      .sort((x, y) => x.start - y.start);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.start).toBeGreaterThanOrEqual(runs[0]!.end);
  }, 60_000);
});
