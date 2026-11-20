import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeConfig } from './config.ts';
import { BRIDGE_VERSION } from './version.ts';
import type { TunnelHello } from './tunnel.ts';

// What an enrolled server's bridge needs besides the run API (PLAN P26-15): where its key is, what it tells the site about the machine, and the agents it found.

const KEY_PATTERN = /^mtb_[0-9a-f]{64}$/;

/**
 * The bridge key: the file the bridge wrote when the site rotated it (`<state>/key`) wins over the credential systemd hands in (`$CREDENTIALS_DIRECTORY/key`, a read-only copy of
 * /etc/manythreads-bridge/key); the installer removes the state copy whenever it writes a new key. Either file must hold only a key.
 */
export function keyFiles(stateDir: string, credentialsDir: string | undefined, explicit: string | undefined): string[] {
  return [join(stateDir, 'key'), ...(explicit !== undefined ? [explicit] : []), ...(credentialsDir !== undefined && credentialsDir !== '' ? [join(credentialsDir, 'key')] : [])];
}

/** The first key file that exists, read at every connection. Throws a plain sentence when there is none or it is not a bridge key. */
export function readServerKey(files: readonly string[]): string {
  for (const file of files) {
    if (!existsSync(file)) continue;
    if ((statSync(file).mode & 0o077) !== 0 && file.startsWith('/etc/')) throw new Error(`${file} is readable by others`);
    const key = readFileSync(file, 'utf8').trim();
    if (!KEY_PATTERN.test(key)) throw new Error(`${file} does not hold a bridge key`);
    return key;
  }
  throw new Error('no bridge key file');
}

/** Rotation: the new key is written next to the old one and moved into place, so a crash leaves one whole key. */
export function storeServerKey(stateDir: string): (key: string) => Promise<void> {
  return async (key) => {
    if (!KEY_PATTERN.test(key)) throw new Error('not a bridge key');
    const target = join(stateDir, 'key');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.new`;
    writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  };
}

function versionOf(program: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // a minimal environment: the check must not read an account or start an agent
    const child = execFile(program, args, { timeout: 8000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/' }, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split('\n').find((l) => l.trim() !== '');
      resolve(line === undefined ? null : (/\d+\.\d+\.\d+[\w.+-]*/.exec(line)?.[0] ?? line.trim()).slice(0, 80));
    });
    child.stdin?.end();
  });
}

function systemName(): string {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text)?.[1];
    if (pretty) return pretty.slice(0, 120);
  } catch {
    // not a system with an os-release file
  }
  return `${platform()} ${release()}`.slice(0, 120);
}

/** The agents this machine's config serves, each with the version its own program reports (null when it does not answer). */
export async function detectAgents(config: BridgeConfig): Promise<TunnelHello['agents']> {
  const out: TunnelHello['agents'] = [];
  const t = config.server?.agents ?? {};
  if (t.claude) out.push({ agent: 'claude-code', version: await versionOf(config.bin.claude, ['--version']) });
  if (t.codex) out.push({ agent: 'codex', version: await versionOf(config.bin.codex, ['--version']) });
  if (t.hermes) out.push({ agent: 'hermes-acp', version: await versionOf(t.hermes.acp?.command ?? 'hermes', ['--version']) });
  return out;
}

export async function helloFor(config: BridgeConfig): Promise<TunnelHello> {
  return {
    bridgeVersion: BRIDGE_VERSION.slice(0, 40),
    host: { hostname: hostname().slice(0, 120), system: systemName(), arch: arch().slice(0, 40) },
    agents: await detectAgents(config),
    allowFullAccess: config.server?.agents.codex?.fullAccess === 'allowed',
  };
}

/**
 * The sign-in folders an enrolled server's gates read (P31-01, review correction 1): the machine's own Claude and Codex folders, as the server's templates name them. A gate lets one run
 * renew a sign-in that is near its renewal while the others wait, and remembers an account failure; before this the server branch started the bridge with neither.
 */
export function serverSigninDirs(config: BridgeConfig): { claudeConfigDir?: string; codexHome?: string } {
  const agents = config.server?.agents;
  const claude = agents?.claude?.authHome;
  const codex = agents?.codex?.authHome;
  return { ...(claude !== undefined ? { claudeConfigDir: claude } : {}), ...(codex !== undefined ? { codexHome: codex } : {}) };
}
