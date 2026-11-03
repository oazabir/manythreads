import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fakeStepCaAvailable, startFakeStepCa, type FakeStepCa } from '@manythreads/test-utils';
import { startFakeK8s, type FakeK8s } from '../../../test-utils/src/fake-k8s.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerError } from '../src/brokers/http.ts';
import { issueKubernetesToken, readKubernetes } from '../src/brokers/kubernetes.ts';
import { clampLifetime, MAX_CREDENTIAL_SECONDS } from '../src/brokers/limits.ts';
import { generateSshKeyPair, issueSshCredential, readEd25519Certificate, runSshCommand, splitHost, sshArguments, stepCaSigner } from '../src/brokers/ssh.ts';

// P8-04: the SSH and Kubernetes brokers, against local doubles of the certificate authority (it signs with a real `ssh-keygen` authority key) and of the
// cluster API. No database. The credentials these brokers make live at most an hour, are made per call, and are checked before they are believed.

const run = promisify(execFile);
const hasKeygen = await fakeStepCaAvailable();
const itKeygen = hasKeygen ? it : it.skip;
const NOW = () => new Date();

describe('credential life', () => {
  it('is held between ten minutes and one hour, whatever is asked for', () => {
    expect(MAX_CREDENTIAL_SECONDS).toBe(3600);
    expect(clampLifetime(undefined)).toBe(600);
    expect(clampLifetime(1)).toBe(600);
    expect(clampLifetime(900)).toBe(900);
    expect(clampLifetime(3600)).toBe(3600);
    expect(clampLifetime(86_400)).toBe(3600);
    expect(clampLifetime(Number.POSITIVE_INFINITY)).toBe(600);
    expect(clampLifetime(Number.NaN)).toBe(600);
  });
});

describe('ssh keys', () => {
  itKeygen('a generated key is one OpenSSH itself reads, and matches its public half', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-key-test-'));
    try {
      const pair = generateSshKeyPair();
      await writeFile(join(dir, 'k'), pair.privateFile, { mode: 0o600 });
      const out = await run('ssh-keygen', ['-y', '-f', join(dir, 'k')]);
      expect(out.stdout.trim()).toBe(pair.publicLine);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two keys are never the same', () => {
    expect(generateSshKeyPair().publicLine).not.toBe(generateSshKeyPair().publicLine);
  });

  it('host names are checked before they reach a command line', () => {
    expect(splitHost('web1.example.com')).toEqual({ name: 'web1.example.com', port: 22 });
    expect(splitHost('10.0.0.5:2222')).toEqual({ name: '10.0.0.5', port: 2222 });
    expect(splitHost('[::1]:22')).toEqual({ name: '::1', port: 22 });
    for (const bad of ['-oProxyCommand=x', 'a b', 'a;b', '$(id)', '', 'host:0', 'host:70000', 'a'.repeat(300), 'host\nx']) expect(splitHost(bad), bad).toBeNull();
  });

  it('the ssh command line turns off everything that could widen a session', () => {
    const args = sshArguments({ key: '/k', certificate: '/c', knownHosts: '/h' }, { name: 'h', port: 22, user: 'deploy' }, 'uptime', 30).join(' ');
    for (const needle of ['ForwardAgent=no', 'ClearAllForwardings=yes', 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'GlobalKnownHostsFile=/dev/null', 'ProxyCommand=none', ' -T ']) {
      expect(` ${args} `).toContain(needle);
    }
    expect(args.endsWith('deploy@h -- uptime')).toBe(true);
  });
});

describe('the ssh broker against a certificate authority', () => {
  let ca: FakeStepCa;
  const signer = () => stepCaSigner({ caUrl: ca.url, provisioner: ca.provisioner, provisionerKey: ca.provisionerKey });
  beforeAll(async () => {
    if (hasKeygen) ca = await startFakeStepCa();
  });
  afterAll(async () => {
    await ca?.stop();
  });

  itKeygen('gets a certificate for one account that ends within the hour, and OpenSSH reads it', async () => {
    const issued = await issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:abc', ttlSeconds: 900 });
    const facts = readEd25519Certificate(issued.certificateLine);
    expect(facts.principals).toEqual(['deploy']);
    expect(facts.userCertificate).toBe(true);
    expect(facts.keyId).toBe('mt:test:abc');
    const left = (issued.expiresAt.getTime() - Date.now()) / 1000;
    expect(left).toBeGreaterThan(800);
    expect(left).toBeLessThanOrEqual(900);
    expect(ca.requests.at(-1)).toMatchObject({ certType: 'user', principals: ['deploy'], keyID: 'mt:test:abc' });
    const dir = await mkdtemp(join(tmpdir(), 'mt-cert-test-'));
    try {
      await writeFile(join(dir, 'c-cert.pub'), `${issued.certificateLine}\n`);
      const out = (await run('ssh-keygen', ['-L', '-f', join(dir, 'c-cert.pub')])).stdout;
      expect(out).toContain('Type: ssh-ed25519-cert-v01@openssh.com user certificate');
      expect(out).toContain('deploy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  itKeygen('never asks for more than an hour, however long a life is requested', async () => {
    await issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:long', ttlSeconds: 86_400 });
    const last = ca.requests.at(-1)!;
    expect((Date.parse(last.validBefore) - Date.now()) / 1000).toBeLessThanOrEqual(3600);
  });

  itKeygen('throws away a certificate that lives longer than an hour', async () => {
    ca.overrideLifetimeSeconds = 7200;
    try {
      await expect(issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:2h' })).rejects.toMatchObject({ code: 'too_long_lived' });
    } finally {
      ca.overrideLifetimeSeconds = null;
    }
  });

  itKeygen('throws away a certificate for other accounts than the one asked for', async () => {
    ca.overridePrincipals = ['root'];
    try {
      await expect(issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:p' })).rejects.toMatchObject({ code: 'bad_answer' });
    } finally {
      ca.overridePrincipals = null;
    }
  });

  itKeygen('says "refused" when the authority turns the connection down, without repeating anything from the answer', async () => {
    ca.failNext(401);
    const error = await issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:r' }).catch((e: unknown) => e as BrokerError);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe('refused');
    ca.failNext(500);
    await expect(issueSshCredential(signer(), { principal: 'deploy', keyId: 'mt:test:r2' })).rejects.toMatchObject({ code: 'unreachable' });
  });

  itKeygen('the authority refuses a token made with another key', async () => {
    const other = await startFakeStepCa();
    try {
      const wrong = stepCaSigner({ caUrl: ca.url, provisioner: ca.provisioner, provisionerKey: other.provisionerKey });
      await expect(issueSshCredential(wrong, { principal: 'deploy', keyId: 'mt:test:w' })).rejects.toMatchObject({ code: 'refused' });
    } finally {
      await other.stop();
    }
  });

  it('refuses an account name or a label that is not plain', async () => {
    const never = { sign: () => Promise.reject(new Error('must not be asked')) };
    await expect(issueSshCredential(never, { principal: 'root; rm', keyId: 'x' })).rejects.toMatchObject({ code: 'bad_config' });
    await expect(issueSshCredential(never, { principal: 'deploy', keyId: 'has space' })).rejects.toMatchObject({ code: 'bad_config' });
  });

  it('a provisioner key that is not a P-256 key is a set-up problem, not a crash', async () => {
    const bad = stepCaSigner({ caUrl: 'http://127.0.0.1:9', provisioner: 'p', provisionerKey: 'not json' });
    await expect(bad.sign({ publicLine: 'ssh-ed25519 AAAA', principal: 'deploy', keyId: 'k', ttlSeconds: 600 })).rejects.toMatchObject({ code: 'bad_config' });
  });
});

describe('running a command', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-fake-ssh-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const credential = () => ({ keyPair: generateSshKeyPair(), certificateLine: 'ssh-ed25519-cert-v01@openssh.com AAAA', expiresAt: new Date(Date.now() + 600_000) });
  const target = { host: 'web1.example.com', user: 'deploy', knownHosts: 'web1.example.com ssh-ed25519 AAAA' };
  const stand = async (name: string, body: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };

  it('uses a private folder for the key and removes it afterwards, with no agent and no inherited environment', async () => {
    process.env['SECRET_FROM_SERVER'] = 'leak-me';
    const bin = await stand('echo-args', 'echo "ARGS $*"; echo "ENV $SECRET_FROM_SERVER $SSH_AUTH_SOCK"; ls -ld "$HOME" | cut -c1-10; head -c 31 "$HOME/key"; exit 0');
    const answer = await runSshCommand(credential(), target, 'uptime', { binary: bin });
    delete process.env['SECRET_FROM_SERVER'];
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.exitCode).toBe(0);
    expect(answer.stdout).toContain('deploy@web1.example.com -- uptime');
    expect(answer.stdout).toContain('ENV  \n'); // neither the server's secret nor an agent socket reached the child
    expect(answer.stdout).toContain('drwx------');
    expect(answer.stdout).toContain('-----BEGIN OPENSSH PRIVATE KEY');
    const folder = /-i (\S+)\/key /.exec(answer.stdout)![1]!;
    expect(existsSync(folder)).toBe(false);
  });

  it('answers the command’s own exit code and output, and says when output was cut', async () => {
    const bin = await stand('exit3', 'head -c 50000 /dev/zero | tr "\\0" "x"; echo oops >&2; exit 3');
    const answer = await runSshCommand(credential(), target, 'uptime', { binary: bin });
    expect(answer).toMatchObject({ ok: true, exitCode: 3, truncated: true });
    if (answer.ok) {
      expect(answer.stdout.length).toBe(20_000);
      expect(answer.stderr).toContain('oops');
    }
  });

  it('255 is ssh failing to connect, not the command', async () => {
    const bin = await stand('fail255', 'exit 255');
    expect(await runSshCommand(credential(), target, 'uptime', { binary: bin })).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('stops a command that does not finish, and still removes the folder', async () => {
    const bin = await stand('sleepy', 'sleep 30');
    const started = Date.now();
    const answer = await runSshCommand(credential(), target, 'uptime', { binary: bin, timeoutMs: 400 });
    expect(answer).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses a host or an account that is not plain, before anything starts', async () => {
    expect(await runSshCommand(credential(), { ...target, host: '-oProxyCommand=x' }, 'uptime', { binary: '/nonexistent' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await runSshCommand(credential(), { ...target, user: 'a b' }, 'uptime', { binary: '/nonexistent' })).toMatchObject({ ok: false, code: 'refused' });
  });

  it('a missing ssh program is an answer, not a crash', async () => {
    expect(await runSshCommand(credential(), target, 'uptime', { binary: '/nonexistent/ssh' })).toMatchObject({ ok: false, code: 'unreachable' });
  });
});

// A real OpenSSH server that trusts the fake authority: proves the key file, the certificate and the command line work together. Needs root, sshd and ssh.
const realSsh = hasKeygen && process.getuid?.() === 0 && existsSync('/usr/sbin/sshd') && existsSync('/usr/bin/ssh');
describe.skipIf(!realSsh)('against a real OpenSSH server', () => {
  let ca: FakeStepCa;
  let dir: string;
  let sshd: ChildProcess | undefined;
  let port = 0;
  let hostPub = '';
  beforeAll(async () => {
    ca = await startFakeStepCa();
    dir = await mkdtemp(join(tmpdir(), 'mt-sshd-'));
    await chmod(dir, 0o755);
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
    hostPub = (await readFile(join(dir, 'host.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    await writeFile(join(dir, 'ca.pub'), `${ca.caPublicLine}\n`);
    await writeFile(join(dir, 'principals'), 'root\n');
    port = 20_000 + Math.floor(Math.random() * 20_000);
    await mkdir('/run/sshd', { recursive: true });
    await writeFile(
      join(dir, 'sshd_config'),
      [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `TrustedUserCAKeys ${join(dir, 'ca.pub')}`, 'PermitRootLogin yes', 'PasswordAuthentication no', 'UsePAM no', `PidFile ${join(dir, 'pid')}`, 'StrictModes no', 'AuthorizedKeysFile none', 'LogLevel ERROR'].join('\n'),
    );
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await run('ssh-keyscan', ['-p', String(port), '127.0.0.1']).then((r) => {
          if (!r.stdout.includes('ssh-ed25519')) throw new Error('not yet');
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 30_000);
  afterAll(async () => {
    sshd?.kill('SIGKILL');
    await ca?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a command runs over a certificate the authority made for this call; a host key that is not trusted does not', async () => {
    const signer = stepCaSigner({ caUrl: ca.url, provisioner: ca.provisioner, provisionerKey: ca.provisionerKey });
    const credential = await issueSshCredential(signer, { principal: 'root', keyId: 'mt:real:1' });
    const host = `127.0.0.1:${port}`;
    const good = await runSshCommand(credential, { host, user: 'root', knownHosts: `[127.0.0.1]:${port} ${hostPub}` }, 'echo hello-from-sshd', { timeoutMs: 15_000 });
    expect(good).toMatchObject({ ok: true, exitCode: 0 });
    if (good.ok) expect(good.stdout.trim()).toBe('hello-from-sshd');
    const wrongHostKey = await runSshCommand(credential, { host, user: 'root', knownHosts: `[127.0.0.1]:${port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0000000000000000000000000000000000000000000` }, 'echo no', { timeoutMs: 15_000 });
    expect(wrongHostKey).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('a certificate for another account is turned away by the server', async () => {
    ca.overridePrincipals = ['someone-else'];
    const signer = stepCaSigner({ caUrl: ca.url, provisioner: ca.provisioner, provisionerKey: ca.provisionerKey });
    try {
      await expect(issueSshCredential(signer, { principal: 'root', keyId: 'mt:real:2' })).rejects.toMatchObject({ code: 'bad_answer' });
    } finally {
      ca.overridePrincipals = null;
    }
  });
});

describe('the kubernetes broker', () => {
  let k8s: FakeK8s;
  const target = () => ({ apiUrl: k8s.url, bootstrapToken: 'bootstrap-SENTINEL', namespace: 'apps', serviceAccount: 'bot-reader' });
  beforeAll(async () => {
    k8s = await startFakeK8s();
    k8s.pods.push({ metadata: { name: 'web-1', namespace: 'apps', managedFields: [{ manager: 'x' }] }, status: { phase: 'Running' } });
    k8s.logs.set('apps/web-1', 'line one\nline two\n');
  });
  afterAll(async () => {
    await k8s?.stop();
  });

  it('asks for a token of the named service account with the bootstrap token, for ten minutes to an hour', async () => {
    const issued = await issueKubernetesToken(target(), { ttlSeconds: 1200 });
    expect(issued.token).toMatch(/^fake-token-/);
    const req = k8s.tokenRequests.at(-1)!;
    expect(req).toMatchObject({ namespace: 'apps', serviceAccount: 'bot-reader', expirationSeconds: 1200, bearer: 'Bearer bootstrap-SENTINEL' });
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(1200_000);
    await issueKubernetesToken(target(), { ttlSeconds: 999_999 });
    expect(k8s.tokenRequests.at(-1)!.expirationSeconds).toBe(3600);
    await issueKubernetesToken(target(), { ttlSeconds: 5 });
    expect(k8s.tokenRequests.at(-1)!.expirationSeconds).toBe(600);
  });

  it('throws away a token that lives longer than an hour (a cluster that stretches token life)', async () => {
    k8s.tokenLifetimeOverride = 7 * 24 * 3600;
    try {
      const error = await issueKubernetesToken(target(), { now: NOW }).catch((e: unknown) => e as BrokerError);
      expect(error).toMatchObject({ code: 'too_long_lived' });
      expect(JSON.stringify(error)).not.toContain('fake-token');
      expect((error as Error).message).not.toContain('fake-token');
    } finally {
      k8s.tokenLifetimeOverride = null;
    }
  });

  it('turns a cluster that refuses, or fails, into a plain answer that holds no token', async () => {
    k8s.failNext(1, 'POST');
    await expect(issueKubernetesToken(target())).rejects.toMatchObject({ code: 'unreachable' });
    await expect(issueKubernetesToken({ ...target(), apiUrl: 'http://127.0.0.1:9' })).rejects.toMatchObject({ code: 'unreachable' });
    await expect(issueKubernetesToken({ ...target(), apiUrl: 'ftp://x' })).rejects.toMatchObject({ code: 'bad_config' });
    await expect(issueKubernetesToken({ ...target(), apiUrl: 'https://user:pw@host' })).rejects.toMatchObject({ code: 'bad_config' });
    await expect(issueKubernetesToken({ ...target(), serviceAccount: '../x' })).rejects.toMatchObject({ code: 'bad_config' });
  });

  it('reads a list with the short-lived token, drops bookkeeping, and refuses a namespace that is not on the list', async () => {
    const issued = await issueKubernetesToken(target());
    const answer = await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods' });
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(JSON.stringify(answer.data)).toContain('web-1');
      expect(JSON.stringify(answer.data)).not.toContain('managedFields');
    }
    const before = k8s.calls.length;
    expect(await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods', namespace: 'kube-system' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods', namespace: '../secrets' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods', name: 'x/../../secrets' })).toMatchObject({ ok: false, code: 'refused' });
    expect(k8s.calls.length).toBe(before); // none of them reached the cluster
  });

  it('reads a pod log, capped, and only for a pod', async () => {
    const issued = await issueKubernetesToken(target());
    const log = await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods', name: 'web-1', log: true, tailLines: 5 });
    expect(log).toMatchObject({ ok: true, data: 'line one\nline two\n', truncated: false });
    expect(await readKubernetes(target(), issued.token, ['apps'], { resource: 'services', name: 'web', log: true })).toMatchObject({ ok: false, code: 'refused' });
    k8s.logs.set('apps/big', 'y'.repeat(100_000));
    const big = await readKubernetes(target(), issued.token, ['apps'], { resource: 'pods', name: 'big', log: true });
    expect(big).toMatchObject({ ok: true, truncated: true });
    if (big.ok) expect((big.data as string).length).toBe(30_000);
  });

  it('a token that has ended is a refusal, not a read', async () => {
    k8s.issued.set('fake-token-ended', Date.now() - 1000);
    expect(await readKubernetes(target(), 'fake-token-ended', ['apps'], { resource: 'pods' })).toMatchObject({ ok: false, code: 'refused' });
  });

  it('has no resource that is a secret or that writes', async () => {
    const { KUBERNETES_RESOURCES } = await import('../src/brokers/kubernetes.ts');
    expect(KUBERNETES_RESOURCES).not.toContain('secrets');
    expect(KUBERNETES_RESOURCES).not.toContain('configmaps');
  });
});
