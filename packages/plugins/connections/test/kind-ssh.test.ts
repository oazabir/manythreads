import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeStepCaAvailable, startFakeStepCa, type FakeStepCa } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sshKind } from '../src/kind-ssh.ts';
import { inputProblem } from '../src/kinds.ts';
import type { ConnectionRow } from '../src/rows.ts';

// P8-04: the `ssh` kind, as `ssh.run` reaches it: the lists the administrator wrote decide what may run, and nothing is signed for a call the lists refuse. The
// ssh program is a stand-in that prints what it was given; the authority is the local double. No database.

const hasKeygen = await fakeStepCaAvailable();
const describeKeygen = hasKeygen ? describe : describe.skip;

describeKeygen('ssh.run', () => {
  let ca: FakeStepCa;
  let dir: string;
  const creds = (): Record<string, string> => ({
    ca_url: ca.url,
    provisioner: ca.provisioner,
    provisioner_key: ca.provisionerKey,
    user: 'deploy',
    hosts: '# the servers\nweb1.example.com\ndb1.example.com:2222\n',
    known_hosts: 'web1.example.com ssh-ed25519 AAAA',
    commands: 'uptime\nsystemctl status nginx --no-pager\n',
  });
  const call = (input: { host: string; command: string }, over: Record<string, string | null> = {}) => {
    const all = { ...creds(), ...over };
    return sshKind.call({
      tool: 'ssh.run',
      input,
      run: { runId: '0190aaaa-0000-7000-8000-000000000001' } as never,
      tx: {} as never,
      connection: { slug: 'servers' } as ConnectionRow,
      credential: (name) => (all[name] != null ? Promise.resolve(all[name]!) : Promise.reject(new Error('missing'))),
    });
  };

  beforeAll(async () => {
    ca = await startFakeStepCa();
    dir = await mkdtemp(join(tmpdir(), 'mt-kind-ssh-'));
    const bin = join(dir, 'ssh');
    await writeFile(bin, '#!/bin/sh\necho "RAN $*"\nexit 0\n');
    await chmod(bin, 0o755);
    process.env['MANYTHREADS_TEST_SSH_BIN'] = bin;
  });
  afterAll(async () => {
    delete process.env['MANYTHREADS_TEST_SSH_BIN'];
    await ca?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a listed command on a listed host with a certificate made for this call', async () => {
    const before = ca.requests.length;
    const out = (await call({ host: 'web1.example.com', command: 'uptime' })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, exitCode: 0, host: 'web1.example.com' });
    expect(String(out['stdout'])).toContain('deploy@web1.example.com -- uptime');
    expect(ca.requests.length).toBe(before + 1);
    expect(ca.requests.at(-1)).toMatchObject({ principals: ['deploy'] });
    expect(ca.requests.at(-1)!.keyID).toMatch(/^mt:servers:[0-9a-f]{16}$/);
    const ends = Date.parse(String(out['certificateEndsAt']));
    expect(ends - Date.now()).toBeLessThanOrEqual(3600_000);
    await call({ host: 'web1.example.com', command: 'uptime' });
    expect(ca.requests.length).toBe(before + 2); // a new certificate every call
    expect(JSON.stringify(out)).not.toContain('BEGIN');
  });

  it('a host or command that is not on the lists is refused before any certificate is asked for', async () => {
    const before = ca.requests.length;
    for (const [host, command] of [
      ['evil.example.com', 'uptime'],
      ['web1.example.com', 'uptime; cat /etc/shadow'],
      ['web1.example.com', 'uptime '],
      ['web1.example.com', 'UPTIME'],
      ['web1.example.com', 'uptime\nid'],
      ['-oProxyCommand=x', 'uptime'],
      ['# the servers', 'uptime'],
    ] as const) {
      expect(await call({ host, command }), `${host} ${command}`).toMatchObject({ ok: false, code: 'refused' });
    }
    expect(ca.requests.length).toBe(before);
  });

  it('a port is part of the host as listed', async () => {
    expect(await call({ host: 'db1.example.com:2222', command: 'uptime' })).toMatchObject({ ok: true });
    expect(await call({ host: 'db1.example.com', command: 'uptime' })).toMatchObject({ ok: false, code: 'refused' });
  });

  it('names what is missing, and never a value', async () => {
    const out = (await call({ host: 'web1.example.com', command: 'uptime' }, { ca_url: null, known_hosts: null })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: false, code: 'not_set_up' });
    expect(String(out['message'])).toContain('ca_url, known_hosts');
  });

  it('answers a refusal by the authority plainly', async () => {
    ca.failNext(403);
    const out = (await call({ host: 'web1.example.com', command: 'uptime' })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: false, code: 'refused' });
  });

  it('the schema a model is shown takes a host and a command, nothing else', () => {
    expect(inputProblem('ssh.run', { host: 'a', command: 'b' })).toBeNull();
    expect(inputProblem('ssh.run', { host: 'a', command: 'b', identity: 'x' })).toMatch(/unexpected field “identity”/);
    expect(inputProblem('ssh.run', { host: 'a' })).toMatch(/command/);
    expect(inputProblem('ssh.run', { host: 'a', command: 'x'.repeat(2001) })).toMatch(/^command:/);
    expect(inputProblem('kubernetes.get', { resource: 'secrets' })).toMatch(/^resource:/);
    expect(inputProblem('kubernetes.get', { resource: 'pods', tail_lines: 501 })).toMatch(/^tail_lines:/);
    expect(inputProblem('kubernetes.get', { resource: 'pods', namespace: 'apps', limit: 10 })).toBeNull();
  });
});
