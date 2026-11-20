import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, profileFor } from '../src/config.ts';
import { startBridge, type Bridge } from '../src/server.ts';
import { helloFor, keyFiles, readServerKey, serverSigninDirs, storeServerKey } from '../src/server-mode.ts';
import { childEnv } from '../src/runs.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './support.ts';

// Server mode (P26-15): an enrolled server's bridge answers any `<agent>--<team>--<bot>` profile from a template, listens on a Unix socket, and reads its key from files.

const dirs: string[] = [];
let bridge: Bridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'server-mode-'));
  dirs.push(d);
  return d;
};

function serverConfig(root: string, over: Record<string, unknown> = {}) {
  return parseConfig({
    profiles: { 'claude-signin': { agent: 'claude-code', driver: 'acp', workdir: join(root, 'work', '.signin'), authHome: join(root, 'auth', 'claude') } },
    bin: { claude: FAKE_CLAUDE, codex: FAKE_CODEX },
    server: {
      root,
      agents: {
        claude: { authHome: join(root, 'auth', 'claude'), acp: { command: '/opt/acp/claude-agent-acp' } },
        codex: { authHome: join(root, 'auth', 'codex'), fullAccess: 'allowed' },
        hermes: { hermesHome: join(root, 'hermes'), acp: { gives: ['files', 'shell'] } },
      },
      instructions: 'You work in {workdir}. Team {team}, bot {bot}. Repository: {repos}.',
    },
    ...over,
  });
}

describe('profiles made from the template', () => {
  it('claude--team--bot gets its own folder, the tool\'s sign-in folder, ACP, and the where-you-run text', () => {
    const root = tmp();
    const cfg = serverConfig(root);
    const p = profileFor(cfg, 'claude--platform--coder')!.profile;
    expect(p).toMatchObject({ agent: 'claude-code', driver: 'acp', workdir: join(root, 'work', 'platform', 'coder'), authHome: join(root, 'auth', 'claude'), acp: { command: '/opt/acp/claude-agent-acp' } });
    expect(p.instructions).toBe(`You work in ${join(root, 'work', 'platform', 'coder')}. Team platform, bot coder. Repository: ${join(root, 'work', 'platform', 'repos')}.`);
  });

  it('codex with team users (P31-01): the run\'s CODEX_HOME is the team\'s own Codex home; the template\'s authHome stays the machine\'s main copy', () => {
    const root = tmp();
    const withUsers = serverConfig(root, {});
    withUsers.server!.teamUsers = { helper: '/opt/h', sudo: '/usr/bin/sudo' };
    const p = profileFor(withUsers, 'codex--eng--coder')!.profile;
    expect(p.env?.['CODEX_HOME']).toBe(join(root, 'work', 'eng', '.codex'));
    expect(p.authHome).toBe(join(root, 'auth', 'codex'));
    expect(childEnv(p, { PATH: '/bin' })['CODEX_HOME']).toBe(join(root, 'work', 'eng', '.codex'));
    expect(profileFor(withUsers, 'claude--eng--coder')!.profile.env?.['CODEX_HOME']).toBeUndefined();
    // without team users everything runs as the bridge's user, with the machine's folder as before
    const plain = profileFor(serverConfig(tmp()), 'codex--eng--coder')!.profile;
    expect(plain.env?.['CODEX_HOME']).toBeUndefined();
  });

  it('the sign-in gates of a server read the machine\'s own Claude and Codex folders (review correction 1)', () => {
    const root = tmp();
    expect(serverSigninDirs(serverConfig(root))).toEqual({ claudeConfigDir: join(root, 'auth', 'claude'), codexHome: join(root, 'auth', 'codex') });
    const onlyHermes = parseConfig({ profiles: { x: { agent: 'hermes-acp', workdir: root } }, server: { root, agents: { hermes: {} } } });
    expect(serverSigninDirs(onlyHermes)).toEqual({});
    expect(serverSigninDirs(parseConfig({ profiles: { x: { agent: 'codex', workdir: root } } }))).toEqual({});
  });

  it('the profile of one bot is not the profile of another, and the same name is the same object', () => {
    const cfg = serverConfig(tmp());
    expect(profileFor(cfg, 'codex--a--x')!.profile.workdir).not.toBe(profileFor(cfg, 'codex--a--y')!.profile.workdir);
    expect(profileFor(cfg, 'codex--a--x')!.profile).toBe(profileFor(cfg, 'codex--a--x')!.profile);
  });

  it('each template carries the machine\'s half of full access as written (codex here; claude too when the installer wrote it, P35-01)', () => {
    const cfg = serverConfig(tmp());
    expect(profileFor(cfg, 'codex--a--x')!.profile.fullAccess).toBe('allowed');
    expect(profileFor(cfg, 'claude--a--x')!.profile.fullAccess).toBeUndefined();
    const root = tmp();
    const both = parseConfig({
      profiles: { s: { agent: 'claude-code', workdir: join(root, 's') } },
      server: { root, agents: { claude: { fullAccess: 'allowed' }, codex: { fullAccess: 'allowed' } } },
    });
    expect(profileFor(both, 'claude--a--x')!.profile.fullAccess).toBe('allowed');
  });

  it('the hello says full access is allowed only for a server with team users whose claude or codex template allows it (P35-01)', async () => {
    const root = tmp();
    const make = (agents: Record<string, unknown>, teamUsers: boolean) =>
      parseConfig({ profiles: { s: { agent: 'claude-code', workdir: join(root, 's') } }, bin: { claude: FAKE_CLAUDE, codex: FAKE_CODEX }, server: { root, agents, ...(teamUsers ? { teamUsers: { helper: '/opt/helper' } } : {}) } });
    expect((await helloFor(make({ claude: { fullAccess: 'allowed' } }, true))).allowFullAccess).toBe(true);
    expect((await helloFor(make({ codex: { fullAccess: 'allowed' } }, true))).allowFullAccess).toBe(true);
    expect((await helloFor(make({ claude: {}, codex: {} }, true))).allowFullAccess).toBe(false);
    // no team users: every team runs as one user, so never
    expect((await helloFor(make({ claude: { fullAccess: 'allowed' }, codex: { fullAccess: 'allowed' } }, false))).allowFullAccess).toBe(false);
  });

  it('hermes gets one Hermes home per bot', () => {
    const root = tmp();
    const cfg = serverConfig(root);
    const p = profileFor(cfg, 'hermes--a--x')!.profile;
    expect(p.agent).toBe('hermes-acp');
    expect(p.env?.['HERMES_HOME']).toBe(join(root, 'hermes', 'a--x'));
    expect(p.acp?.gives).toEqual(['files', 'shell']);
  });

  it.each([
    ['default'],
    ['claude'],
    ['claude--a'],
    ['claude--a--b--c'],
    ['claude--..--x'],
    ['claude--a--..'],
    ['claude--a/b--x'],
    ['claude--A--x'],
    ['claude---a--x'],
    ['opencode--a--x'],
    ['claude--a--' + 'x'.repeat(64)],
  ])('"%s" is a 404, with no default to fall back to', (name) => {
    expect(profileFor(serverConfig(tmp()), name)).toBeNull();
  });

  it('an agent without a template (not installed on this machine) is a 404', () => {
    const root = tmp();
    const cfg = parseConfig({ profiles: { s: { agent: 'codex', workdir: root } }, server: { root, agents: { claude: {} } } });
    expect(profileFor(cfg, 'codex--a--x')).toBeNull();
    expect(profileFor(cfg, 'claude--a--x')).not.toBeNull();
  });

  it('a plain sign-in profile still answers by name', () => {
    expect(profileFor(serverConfig(tmp()), 'claude-signin')!.profile.authHome).toBeDefined();
  });

  it('refuses a template with a relative root, an unknown agent or a bad rule', () => {
    expect(() => parseConfig({ profiles: { s: { agent: 'codex', workdir: '/w' } }, server: { root: 'rel', agents: {} } })).toThrow(/absolute/);
    expect(() => parseConfig({ profiles: { s: { agent: 'codex', workdir: '/w' } }, server: { root: '/r', agents: { gemini: {} } } })).toThrow(/gemini/);
    expect(() => parseConfig({ profiles: { s: { agent: 'codex', workdir: '/w' } }, server: { root: '/r', agents: { hermes: { fullAccess: true } } } })).toThrow(/only for claude-code and codex/);
    expect(() => parseConfig({ profiles: { s: { agent: 'codex', workdir: '/w' } }, server: { root: '/r', agents: { claude: { hermesHome: '/h' } } } })).toThrow(/Hermes only/);
  });
});

describe('the Unix socket', () => {
  const get = (socketPath: string, path: string, key?: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, path, method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {} }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('the bridge listens on a socket (mode 0600), answers with the internal key, and refuses without it', async () => {
    const root = tmp();
    const sock = join(root, 'bridge.sock');
    bridge = await startBridge({ config: serverConfig(root), apiKey: 'internal-key-0123456789', stateDir: join(root, 'state'), socketPath: sock, log: () => undefined, tmpRoot: root });
    expect(bridge.port).toBe(0);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect((await get(sock, '/health', 'internal-key-0123456789')).status).toBe(200);
    expect((await get(sock, '/health')).status).toBe(401);
    expect((await get(sock, '/p/claude--a--b/v1/runs/none', 'internal-key-0123456789')).status).toBe(404); // a run that does not exist, on a profile that does
    expect(JSON.parse((await get(sock, '/p/default/v1/runs/none', 'internal-key-0123456789')).body).error.code).toBe('profile_not_found');
    await bridge.close();
    bridge = undefined;
    expect(existsSync(sock)).toBe(false);
  });

  it('a socket file left by a killed bridge does not stop the next start', async () => {
    const root = tmp();
    const sock = join(root, 'bridge.sock');
    writeFileSync(sock, 'stale');
    bridge = await startBridge({ config: serverConfig(root), apiKey: 'internal-key-0123456789', stateDir: join(root, 'state'), socketPath: sock, log: () => undefined, tmpRoot: root });
    expect((await get(sock, '/health', 'internal-key-0123456789')).status).toBe(200);
  });
});

describe('the bridge key files', () => {
  const KEY = `mtb_${'1'.repeat(64)}`;
  const NEXT = `mtb_${'2'.repeat(64)}`;

  it('the key the bridge wrote after a rotation wins over the credential; a file that is not a key is refused', async () => {
    const root = tmp();
    const cred = join(root, 'cred');
    const state = join(root, 'state');
    await import('node:fs').then((fs) => fs.mkdirSync(cred, { recursive: true }));
    writeFileSync(join(cred, 'key'), `${KEY}\n`, { mode: 0o600 });
    const files = keyFiles(state, cred, undefined);
    expect(readServerKey(files)).toBe(KEY);
    await storeServerKey(state)(NEXT);
    expect(readServerKey(files)).toBe(NEXT);
    expect(statSync(join(state, 'key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(state, 'key'), 'utf8').trim()).toBe(NEXT);
    await expect(storeServerKey(state)('not-a-key')).rejects.toThrow();
    writeFileSync(join(state, 'key'), 'garbage\n');
    expect(() => readServerKey(files)).toThrow(/does not hold a bridge key/);
  });

  it('no file at all is a plain sentence', () => {
    expect(() => readServerKey(keyFiles(join(tmp(), 'nothing'), undefined, undefined))).toThrow(/no bridge key file/);
  });
});
