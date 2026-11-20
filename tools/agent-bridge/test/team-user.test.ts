import { describe, expect, it } from 'vitest';
import { parseConfig, profileFor } from '../src/config.ts';
import { sudoArgv, teamsOnMachine } from '../src/server-team.ts';
import {
  buildHeader,
  ENV_ALLOW,
  helperArgv,
  isSlug,
  isTeamUserName,
  launchEnv,
  parseHeader,
  plainPath,
  SYNC_ENV,
  teamHermesHome,
  teamHome,
  teamKubeconfigFile,
  teamUserName,
  type Kind,
} from '../src/team-user.ts';

// P26-22: one Unix user per team on an enrolled server. What the bridge and the root helper both check: the slug, the user's name, the header on the helper's standard input, the environment allowlist.

const ROOT = '/var/lib/manythreads-bridge';
const ctx = (kind: Kind = 'claude', team = 'eng') => ({ root: ROOT, team, kind });
const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, cwd: `${ROOT}/work/eng/builder`, env: { PATH: '/usr/bin' }, files: [], removeAtEnd: [], ...over });

describe('team slugs', () => {
  it.each(['eng', 'marketing', 'a', 'team-1', 'a1-b2-c3', 'x'.repeat(63)])('"%s" is a slug', (s) => expect(isSlug(s)).toBe(true));
  it.each(['', '-a', 'A', 'a--b', 'a_b', 'a.b', '..', '.', 'a/b', 'a b', 'a\nb', 'a;b', '$(id)', 'é', 'x'.repeat(64), 'a\0b'])('%j is not a slug', (s) => expect(isSlug(s)).toBe(false));
  it('a non-string is not a slug', () => {
    for (const v of [null, undefined, 4, {}, ['eng']]) expect(isSlug(v)).toBe(false);
  });
});

describe('the team user\'s name', () => {
  it('is mt-team- and the slug', () => {
    expect(teamUserName('eng')).toBe('mt-team-eng');
    expect(teamUserName('marketing')).toBe('mt-team-marketing');
  });
  it('fits in 32 characters: a longer slug is cut and given a hash, so two long slugs that start alike stay apart', () => {
    const a = teamUserName('x'.repeat(24));
    expect(a).toBe(`mt-team-${'x'.repeat(24)}`);
    expect(a.length).toBe(32);
    const b = teamUserName('platform-engineering-and-release-team');
    const c = teamUserName('platform-engineering-and-release-crew');
    expect(b.length).toBeLessThanOrEqual(32);
    expect(c.length).toBeLessThanOrEqual(32);
    expect(b).not.toBe(c);
    expect(b).toBe(teamUserName('platform-engineering-and-release-team'));
    expect(isTeamUserName(b)).toBe(true);
    expect(b).not.toMatch(/-$/);
  });
  it('refuses a name that is not a slug', () => {
    for (const bad of ['', '../x', 'A', 'a b', 'a--b']) expect(() => teamUserName(bad)).toThrow();
  });
  it('isTeamUserName is what the helper makes, nothing else', () => {
    expect(isTeamUserName('mt-team-eng')).toBe(true);
    for (const n of ['root', 'mt-team-', 'mt-team-A', 'mt-team-a b', 'manythreads-bridge', 'xmt-team-eng', 'mt-team-' + 'x'.repeat(25)]) expect(isTeamUserName(n)).toBe(false);
  });
});

describe('folders', () => {
  it('a team\'s home is its work folder; kube and Hermes homes are inside it', () => {
    expect(teamHome(ROOT, 'eng')).toBe(`${ROOT}/work/eng`);
    expect(teamKubeconfigFile(ROOT, 'eng', 'deployer', 'run-1')).toBe(`${ROOT}/work/eng/kube/deployer/run-1/config`);
    expect(teamHermesHome(ROOT, 'eng', 'builder')).toBe(`${ROOT}/work/eng/hermes/builder`);
  });
});

describe('the words after sudo', () => {
  it('are the helper, the command, the team and the kind: nothing from the run', () => {
    expect(helperArgv('/opt/h', 'ensure-user', 'eng')).toEqual(['/opt/h', 'ensure-user', 'eng']);
    expect(helperArgv('/opt/h', 'run', 'eng', 'claude')).toEqual(['/opt/h', 'run', 'eng', 'claude']);
    expect(sudoArgv({ helper: '/opt/h', sudo: '/usr/bin/sudo' }, 'eng', 'codex')).toEqual({ command: '/usr/bin/sudo', args: ['-n', '--', '/opt/h', 'run', 'eng', 'codex'] });
  });
  it('refuse a slug or a kind that is not one', () => {
    expect(() => helperArgv('/opt/h', 'run', '../x', 'claude')).toThrow();
    expect(() => helperArgv('/opt/h', 'run', 'eng', 'sh' as Kind)).toThrow();
    expect(() => helperArgv('/opt/h', 'ensure-user', 'a;b')).toThrow();
  });
});

describe('the header the helper takes', () => {
  it('accepts a plain run: the working folder, the allowed variables, a kubeconfig file and what to remove', () => {
    const kube = `${ROOT}/work/eng/kube/deployer/r1/config`;
    const r = parseHeader(
      line({ env: { PATH: '/usr/bin', LANG: 'C.UTF-8', CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude`, KUBECONFIG: kube, MANYTHREADS_RUN_TOKEN: 'tok' }, files: [{ path: kube, text: 'x', mode: '0600' }], removeAtEnd: [`${ROOT}/work/eng/kube/deployer/r1`] }),
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, dropped: [] });
    if (r.ok) {
      expect(r.header.env['MANYTHREADS_RUN_TOKEN']).toBe('tok');
      expect(r.header.files).toHaveLength(1);
    }
  });

  it('drops the names outside the allowlist and says which, by name only', () => {
    const r = parseHeader(line({ env: { PATH: '/usr/bin', AGENT_BRIDGE_API_KEY: 'secret-key-value', LD_PRELOAD: '/tmp/x.so', GITHUB_TOKEN: 'ghp_x', HOME: '/root', NODE_OPTIONS: '--require /tmp/x' } }), ctx());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(Object.keys(r.header.env)).toEqual(['PATH']);
      expect(r.dropped.sort()).toEqual(['AGENT_BRIDGE_API_KEY', 'GITHUB_TOKEN', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS']);
      expect(JSON.stringify(r.dropped)).not.toContain('secret-key-value');
    }
  });

  it('takes the repository sync\'s own variables only for the sync kind', () => {
    const env = { PATH: '/usr/bin', REPO_SYNC_LIST: `${ROOT}/work/eng/.sync/list.txt`, REPO_SYNC_WORK: `${ROOT}/work`, REPO_SYNC_INTERVAL: '10', MANYTHREADS_RUN_TOKEN: 't' };
    const sync = parseHeader(line({ cwd: `${ROOT}/work/eng/.sync`, env }), ctx('sync'));
    expect(sync).toMatchObject({ ok: true });
    if (sync.ok) expect(sync.dropped).toEqual(['MANYTHREADS_RUN_TOKEN']);
    const agent = parseHeader(line({ env }), ctx('claude'));
    if (agent.ok) expect(agent.dropped.sort()).toEqual(['REPO_SYNC_INTERVAL', 'REPO_SYNC_LIST', 'REPO_SYNC_WORK']);
  });

  it.each([
    ['a working folder outside the home', { cwd: `${ROOT}/work/other/bot` }],
    ['a working folder that only starts like the home', { cwd: `${ROOT}/work/eng-two/bot` }],
    ['a working folder that climbs out', { cwd: `${ROOT}/work/eng/../other/bot` }],
    ['a relative working folder', { cwd: 'work/eng/bot' }],
    ['the root of the machine', { cwd: '/' }],
    ['a sign-in folder that is not the machine\'s', { env: { CLAUDE_CONFIG_DIR: '/root/.claude' } }],
    ['another team\'s kubeconfig', { env: { KUBECONFIG: `${ROOT}/work/other/kube/b/r/config` } }],
    ['a Hermes home outside the team\'s', { env: { HERMES_HOME: '/root/.hermes' } }],
    ['a file outside the home', { files: [{ path: '/etc/cron.d/x', text: 'x', mode: '0600' }] }],
    ['a file in another team\'s home', { files: [{ path: `${ROOT}/work/other/f`, text: 'x', mode: '0600' }] }],
    ['a mode that is not octal', { files: [{ path: `${ROOT}/work/eng/f`, text: 'x', mode: '4755 ' }] }],
    ['a setuid mode', { files: [{ path: `${ROOT}/work/eng/f`, text: 'x', mode: '4755' }] }],
    ['a path to remove outside the home', { removeAtEnd: ['/var/lib'] }],
    ['the home itself to remove', { removeAtEnd: [`${ROOT}/work/eng`] }],
    ['too many files', { files: Array.from({ length: 17 }, (_, i) => ({ path: `${ROOT}/work/eng/f${i}`, text: 'x', mode: '0600' })) }],
    ['a variable name that is not one', { env: { 'A B': 'x' } }],
    ['a NUL in a value', { env: { PATH: 'a\0b' } }],
    ['another version', { v: 2 }],
  ])('refuses %s', (_what, over) => {
    expect(parseHeader(line(over as Record<string, unknown>), ctx())).toMatchObject({ ok: false });
  });

  it('refuses text that is not JSON, not an object, and a header that is too long', () => {
    for (const text of ['', 'nope', '[]', 'null', '"x"']) expect(parseHeader(text, ctx())).toMatchObject({ ok: false });
    expect(parseHeader(line({ env: { PATH: 'x'.repeat(3 * 1024 * 1024) } }), ctx())).toMatchObject({ ok: false });
  });

  it('the sync work folder must be the machine\'s, and the interval a number', () => {
    expect(parseHeader(line({ cwd: `${ROOT}/work/eng/.sync`, env: { REPO_SYNC_WORK: '/tmp' } }), ctx('sync'))).toMatchObject({ ok: false });
    expect(parseHeader(line({ cwd: `${ROOT}/work/eng/.sync`, env: { REPO_SYNC_INTERVAL: '1; rm -rf /' } }), ctx('sync'))).toMatchObject({ ok: false });
  });
});

describe('what the bridge sends', () => {
  it('only the allowlist, whatever its own environment holds', () => {
    const env = { PATH: '/p', HOME: '/home/bridge', AGENT_BRIDGE_API_KEY: 'k', GITHUB_TOKEN: 't', MANYTHREADS_RUN_TOKEN: 'run-token', CODEX_HOME: `${ROOT}/auth/codex`, LD_LIBRARY_PATH: '/x' };
    const header = JSON.parse(buildHeader({ cwd: `${ROOT}/work/eng/b`, env, kind: 'codex' })) as { env: Record<string, string> };
    expect(Object.keys(header.env).sort()).toEqual(['CODEX_HOME', 'MANYTHREADS_RUN_TOKEN', 'PATH']);
    for (const k of Object.keys(header.env)) expect(ENV_ALLOW.test(k)).toBe(true);
    expect(buildHeader({ cwd: `${ROOT}/work/eng/b`, env, kind: 'codex' })).not.toContain('AGENT_BRIDGE_API_KEY');
  });
  it('a header the bridge builds is one the helper accepts', () => {
    const text = buildHeader({ cwd: `${ROOT}/work/eng/b`, env: { PATH: '/p', CLAUDE_CONFIG_DIR: `${ROOT}/auth/claude` }, files: [{ path: `${ROOT}/work/eng/hermes/b/config.yaml`, text: 'x', mode: '0600' }], removeAtEnd: [], kind: 'claude' });
    expect(parseHeader(text, ctx())).toMatchObject({ ok: true, dropped: [] });
  });
  it('NODE_OPTIONS and NODE_PATH are not on the helper\'s allowlist (P31-04)', () => {
    for (const k of ['NODE_OPTIONS', 'NODE_PATH']) {
      expect(ENV_ALLOW.test(k)).toBe(false);
      expect(SYNC_ENV.test(k)).toBe(false);
    }
    const header = JSON.parse(buildHeader({ cwd: `${ROOT}/work/eng/b`, env: { PATH: '/p', NODE_OPTIONS: '--max-old-space-size=16384', NODE_PATH: '/x' }, kind: 'codex' })) as { env: Record<string, string> };
    expect(Object.keys(header.env)).toEqual(['PATH']);
  });
  it('the sync allowlist has no token and no sign-in variable', () => {
    for (const k of ['MANYTHREADS_RUN_TOKEN', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KUBECONFIG']) expect(SYNC_ENV.test(k)).toBe(false);
  });
});

describe('the program\'s own environment', () => {
  it('names are the team user\'s, whatever the header says', () => {
    const header = { v: 1 as const, cwd: `${ROOT}/work/eng/b`, env: { PATH: '/p' }, files: [], removeAtEnd: [] };
    const env = launchEnv(header, 'mt-team-eng', `${ROOT}/work/eng`, '/bin/bash');
    expect(env).toMatchObject({ HOME: `${ROOT}/work/eng`, USER: 'mt-team-eng', LOGNAME: 'mt-team-eng', SHELL: '/bin/bash', TMPDIR: `${ROOT}/work/eng/tmp`, PATH: '/p' });
    expect(launchEnv({ ...header, env: {} }, 'u', '/h', '/bin/sh')['PATH']).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});

describe('plain paths', () => {
  it('are absolute and normal', () => {
    expect(plainPath('/a/b')).toBe(true);
    for (const p of ['a/b', '/a/../b', '/a//b', '/a/', '/', '', '/a\0b', 4, null]) expect(plainPath(p)).toBe(false);
  });
});

describe('the teams that have a user on this machine', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    `mt-team-eng:x:990:990:manythreads team eng:${ROOT}/work/eng:/usr/sbin/nologin`,
    `mt-team-mkt:x:989:989:x:${ROOT}/work/marketing:/usr/sbin/nologin`,
    `mt-team-bad:x:988:988:x:/root:/usr/sbin/nologin`,
    `mt-team-odd:x:987:987:x:${ROOT}/work/odd/deeper:/usr/sbin/nologin`,
    `other:x:1000:1000:x:${ROOT}/work/other:/bin/bash`,
  ].join('\n');
  it('lists mt-team accounts whose home is a team folder, and nothing else', () => {
    expect(teamsOnMachine(ROOT, passwd)).toEqual(['eng', 'marketing']);
  });
});

describe('server config with team users', () => {
  const base = { profiles: { s: { agent: 'claude-code', workdir: '/w' } } };
  it('parses the helper and defaults sudo; refuses a relative path', () => {
    const cfg = parseConfig({ ...base, server: { root: ROOT, agents: { hermes: { hermesHome: `${ROOT}/hermes` } }, teamUsers: { helper: '/opt/manythreads-bridge/helper/mt-team-helper' } } });
    expect(cfg.server?.teamUsers).toEqual({ helper: '/opt/manythreads-bridge/helper/mt-team-helper', sudo: '/usr/bin/sudo' });
    expect(() => parseConfig({ ...base, server: { root: ROOT, agents: {}, teamUsers: { helper: 'mt-team-helper' } } })).toThrow(/teamUsers/);
    expect(() => parseConfig({ ...base, server: { root: ROOT, agents: {}, teamUsers: {} } })).toThrow(/teamUsers/);
  });
  it('a team\'s Hermes home is inside its own home; without team users it is the template\'s folder', () => {
    const agents = { hermes: { hermesHome: `${ROOT}/hermes` } };
    const withTeams = parseConfig({ ...base, server: { root: ROOT, agents, teamUsers: { helper: '/h' } } });
    expect(profileFor(withTeams, 'hermes--eng--builder')!.profile.env?.['HERMES_HOME']).toBe(`${ROOT}/work/eng/hermes/builder`);
    const without = parseConfig({ ...base, server: { root: ROOT, agents } });
    expect(profileFor(without, 'hermes--eng--builder')!.profile.env?.['HERMES_HOME']).toBe(`${ROOT}/hermes/eng--builder`);
  });
  it('the work folder of a bot is the same with or without team users', () => {
    const cfg = parseConfig({ ...base, server: { root: ROOT, agents: { claude: {} }, teamUsers: { helper: '/h' } } });
    expect(profileFor(cfg, 'claude--eng--builder')!.profile.workdir).toBe(`${ROOT}/work/eng/builder`);
  });
});
