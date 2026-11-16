import { describe, expect, it } from 'vitest';
import {
  HASH_NOTE,
  REACH_NOTE,
  agentLine,
  askCommand,
  carefulSteps,
  codeWords,
  hasOwnSignin,
  hostLine,
  installCommand,
  removeWords,
  serverNameProblem,
  statusWords,
  suggestServerName,
  waitingWords,
} from '../src/screens/admin/runners/servers';

describe('the install command', () => {
  it('is one line with the code in it, and a variant that asks for the code', () => {
    expect(installCommand('https://site.example', 'mtc_abc')).toBe('curl -fsSL https://site.example/install/bridge.sh | sudo bash -s -- --enrol mtc_abc');
    expect(askCommand('https://site.example')).toMatch(/--enrol -$/);
  });

  it('a site with its own certificate: the script download pins the key and the script is told the certificate hash (P27-05)', () => {
    const cert = { sha256: 'a'.repeat(64), spkiSha256: `${'B'.repeat(43)}=` };
    const main = installCommand('https://203.0.113.5', 'mtc_abc', cert);
    expect(main).toBe(`curl -fsSLk --pinnedpubkey 'sha256//${cert.spkiSha256}' https://203.0.113.5/install/bridge.sh | sudo bash -s -- --enrol mtc_abc --ca-sha256 ${cert.sha256}`);
    expect(askCommand('https://203.0.113.5', cert)).toMatch(/--enrol - --ca-sha256 a{64}$/);
    const steps = carefulSteps('https://203.0.113.5', 'f'.repeat(64), 'mtc_abc', cert);
    expect(steps[0]).toContain("--pinnedpubkey 'sha256//");
    expect(steps[3]).toBe(`sudo bash bridge.sh --enrol mtc_abc --ca-sha256 ${cert.sha256}`);
    // no certificate given or null: the plain commands, with no -k anywhere
    expect(installCommand('https://site.example', 'mtc_abc', null)).not.toContain('-k');
    expect(carefulSteps('https://site.example', 'f'.repeat(64), 'c', null).join('\n')).not.toContain('--ca-sha256');
  });
  it('has a careful way that checks the hash before it runs anything', () => {
    const steps = carefulSteps('https://site.example', 'f'.repeat(64), 'mtc_abc');
    expect(steps).toHaveLength(4);
    expect(steps[2]).toContain('sha256sum -c -');
    expect(steps[2]).toContain('f'.repeat(64));
    expect(steps[3]).toBe('sudo bash bridge.sh --enrol mtc_abc');
    expect(HASH_NOTE).toMatch(/same site/);
  });
});

describe('names', () => {
  it('suggests a short name from the label and checks it like the server does', () => {
    expect(suggestServerName('Build machine #2')).toBe('build-machine-2');
    expect(suggestServerName('  --  ')).toBe('');
    expect(suggestServerName('x'.repeat(60))).toHaveLength(31);
    expect(serverNameProblem('build-2')).toBeNull();
    expect(serverNameProblem('')).toMatch(/short name/);
    expect(serverNameProblem('Build')).toMatch(/lower-case/);
    expect(serverNameProblem('-build')).toMatch(/lower-case/);
  });
});

describe('what a server shows', () => {
  it('says its state in words', () => {
    expect(statusWords({ status: 'connected', enrolled: true }).label).toBe('Connected');
    expect(statusWords({ status: 'waiting', enrolled: false }).label).toMatch(/Waiting/);
    expect(statusWords({ status: 'offline', enrolled: true })).toEqual({ label: 'Not connected', tone: 'warn' });
  });
  it('says what the machine is, and nothing before it connected', () => {
    expect(hostLine({ host: null, bridgeVersion: null })).toBeNull();
    expect(hostLine({ host: { hostname: 'box-1', system: 'Ubuntu 24.04', arch: 'x64' }, bridgeVersion: 'abc123' })).toBe('Ubuntu 24.04 · x64 · box-1 · bridge abc123');
  });
  it('lists agents, and only the ones with their own sign-in get a button', () => {
    expect(agentLine({ agent: 'codex', version: '0.166.0' } as never)).toBe('Codex 0.166.0');
    expect(agentLine({ agent: 'hermes-acp', version: null } as never)).toBe('Hermes');
    expect(hasOwnSignin('claude-code')).toBe(true);
    expect(hasOwnSignin('codex')).toBe(true);
    expect(hasOwnSignin('hermes-acp')).toBe(false);
  });
  it('counts the minutes a code has left', () => {
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(codeWords({ codeExpiresAt: null }, now)).toBe('No code is waiting.');
    expect(codeWords({ codeExpiresAt: '2026-11-15T10:15:00Z' }, now)).toMatch(/15 more minutes/);
    expect(codeWords({ codeExpiresAt: '2026-11-15T10:01:00Z' }, now)).toMatch(/1 more minute\./);
    expect(codeWords({ codeExpiresAt: '2026-11-15T09:59:00Z' }, now)).toMatch(/expired/);
  });
  it('warns plainly about what a bot on the server can reach, and what removing does', () => {
    expect(REACH_NOTE).toMatch(/Put only teams you trust together/);
    expect(removeWords({ label: 'Box' })).toMatch(/--uninstall/);
    expect(waitingWords('box')).toBe('Waiting for box to connect…');
  });
});
