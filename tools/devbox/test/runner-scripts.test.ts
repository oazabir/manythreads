import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * P19-12: the two owner/stage scripts of the runner security proof, run against stand-in commands only.
 *   secrets-encrypt.sh      refuses to change anything without the owner's flag, `status` only reads, a dry run changes nothing, `verify` reads a stand-in datastore
 *   stage-runners-probe.sh  refuses a live namespace before any kubectl call, touches only the two stage namespaces, and FAILS (not passes) when a door is open or a byte leaks
 * No real k3s, kubectl or datastore is touched: every command is a recording stand-in in a temp folder.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const encrypt = join(root, 'tools/devbox/secrets-encrypt.sh');
const probe = join(root, 'tools/devbox/stage-runners-probe.sh');
const fakeKubectl = join(here, 'fake-kubectl');

let tmp = '';
let log = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'runner-scripts-'));
  log = join(tmp, 'calls.log');
  writeFileSync(log, '');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);

function stub(name: string, body: string): string {
  const file = join(tmp, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(script: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const res = spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: tmp, FAKE_LOG: log, ...env }, timeout: 60_000 });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

/** A stand-in k3s datastore: the `kine` table with the stored value of some Secrets. */
function datastore(rows: Array<[string, Buffer]>): string {
  const file = join(tmp, 'state.db');
  const sql = ['create table kine (id integer primary key autoincrement, name text, value blob);', ...rows.map(([n, v]) => `insert into kine (name, value) values ('${n}', x'${v.toString('hex')}');`)].join('\n');
  const res = spawnSync('python3', ['-I', '-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.commit()', file, sql], { encoding: 'utf8' });
  expect(res.status, res.stderr).toBe(0);
  return file;
}
const ENC = Buffer.from('k8s:enc:aescbc:v1:key1:xxxxxxxx');
const PLAIN = Buffer.from('k8s\x00\n\x02v1\x12CANARY-ENCRYPT-1a2b-plain-secret-bytes');

describe('secrets-encrypt.sh', () => {
  function fakes(statusOut = 'Encryption Status: Enabled\nCurrent Rotation Stage: reencrypt_finished'): Record<string, string> {
    return {
      K3S: stub('k3s', `echo "k3s $*" >>"$FAKE_LOG"; case "$*" in "secrets-encrypt status") echo '${statusOut.replace(/\n/g, "'; echo '")}';; esac`),
      KUBECTL: stub('kubectl', `echo "kubectl $*" >>"$FAKE_LOG"; case "$*" in *readyz*) echo ok;; *"get pods"*) echo 'a b 1/1 Running 0 1d';; esac`),
      SYSTEMCTL: stub('systemctl', `echo "systemctl $*" >>"$FAKE_LOG"`),
      WAIT_SECONDS: '6',
      SETTLE_SECONDS: '0',
    };
  }

  for (const action of ['enable', 'rotate']) {
    it(`${action} without the owner flag refuses (exit 2) and runs no command at all`, () => {
      const res = run(encrypt, [action], fakes());
      expect(res.code).toBe(2);
      expect(res.out).toMatch(/REFUSED/);
      expect(calls()).toEqual([]);
    });
  }

  it('an unknown word or flag is a usage error and runs nothing', () => {
    expect(run(encrypt, ['bogus'], fakes()).code).toBe(2);
    expect(run(encrypt, ['enable', '--yes'], fakes()).code).toBe(2);
    expect(calls()).toEqual([]);
  });

  it('status only asks k3s for its status (no enable, no restart, no kubectl) and reads the datastore read-only', () => {
    const db = datastore([['/registry/secrets/a/one', ENC], ['/registry/secrets/a/two', PLAIN]]);
    const res = run(encrypt, ['status'], { ...fakes(), K3S_DB: db });
    expect(res.code).toBe(0);
    expect(calls()).toEqual(['k3s secrets-encrypt status']);
    expect(res.out).toContain('PLAIN');
    expect(res.out).toContain('/registry/secrets/a/two');
    expect(res.out).not.toContain('CANARY-ENCRYPT-1a2b'); // the value of a Secret is never printed
  });

  it('verify: 0 when every Secret looked at is encrypted, 1 when one is plain, 3 when there is no datastore', () => {
    expect(run(encrypt, ['verify'], { ...fakes(), K3S_DB: datastore([['/registry/secrets/a/one', ENC], ['/registry/secrets/a/two', ENC]]) }).code).toBe(0);
    rmSync(join(tmp, 'state.db'));
    expect(run(encrypt, ['verify'], { ...fakes(), K3S_DB: datastore([['/registry/secrets/a/one', ENC], ['/registry/secrets/a/two', PLAIN]]) }).code).toBe(1);
    rmSync(join(tmp, 'state.db'));
    expect(run(encrypt, ['verify'], { ...fakes(), K3S_DB: join(tmp, 'missing.db') }).code).toBe(3);
    rmSync(join(tmp, 'state.db'), { force: true });
    expect(run(encrypt, ['verify'], { ...fakes(), K3S_DB: datastore([['/registry/configmaps/x', PLAIN]]) }).code).toBe(3); // no Secret at all: not "all encrypted"
  });

  it('verify leaves the datastore as it found it (opened read-only)', () => {
    const db = datastore([['/registry/secrets/a/one', ENC]]);
    const before = readFileSync(db);
    run(encrypt, ['verify'], { ...fakes(), K3S_DB: db });
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(existsSync(`${db}-journal`)).toBe(false);
  });

  it('--dry-run changes nothing: only the status question reaches k3s, no restart, and it says what it would do', () => {
    for (const action of ['enable', 'rotate']) {
      writeFileSync(log, '');
      const res = run(encrypt, [action, '--yes-i-am-the-owner', '--dry-run'], fakes());
      expect(res.code, res.out).toBe(0);
      expect(res.out).toMatch(/would run/);
      expect(calls().filter((c) => !c.startsWith('kubectl get pods') && c !== 'k3s secrets-encrypt status')).toEqual([]);
    }
  });

  it('enable runs in order: enable, restart, wait for the API, re-encrypt, then checks the datastore', () => {
    const db = datastore([['/registry/secrets/a/one', ENC]]);
    const res = run(encrypt, ['enable', '--yes-i-am-the-owner'], { ...fakes(), K3S_DB: db });
    expect(res.code, res.out).toBe(0);
    const steps = calls().filter((c) => /secrets-encrypt (enable|reencrypt)|systemctl|readyz/.test(c));
    const at = (needle: RegExp): number => steps.findIndex((c) => needle.test(c));
    expect(at(/secrets-encrypt enable/)).toBeGreaterThanOrEqual(0);
    expect(at(/systemctl restart k3s/)).toBeGreaterThan(at(/secrets-encrypt enable/));
    expect(at(/readyz/)).toBeGreaterThan(at(/systemctl restart k3s/));
    expect(at(/secrets-encrypt reencrypt/)).toBeGreaterThan(at(/readyz/));
    expect(res.out).toMatch(/DONE: Secrets are encrypted at rest/);
  });

  it('enable fails (exit 1) when the datastore still holds a plain Secret afterwards', () => {
    const db = datastore([['/registry/secrets/a/one', PLAIN]]);
    const res = run(encrypt, ['enable', '--yes-i-am-the-owner'], { ...fakes(), K3S_DB: db });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/still holds a plain Secret/);
    expect(res.out).not.toMatch(/DONE/);
  });

  it('enable gives up with a plain message when the API does not come back', () => {
    const k = { ...fakes(), KUBECTL: stub('kubectl-down', 'echo "kubectl $*" >>"$FAKE_LOG"; exit 1'), WAIT_SECONDS: '3' };
    const res = run(encrypt, ['enable', '--yes-i-am-the-owner'], { ...k, K3S_DB: datastore([['/registry/secrets/a/one', ENC]]) });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/did not come back/);
    expect(calls().some((c) => c.includes('reencrypt'))).toBe(false);
  });
});

describe('stage-runners-probe.sh', () => {
  const stageEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ KUBECTL: fakeKubectl, STAGE_HOST: '127.0.0.1', FAKE_SAAS_PORT: '1', ...extra });

  for (const [name, value] of [['STAGE_NAMESPACE', 'manythreads'], ['STAGE_NAMESPACE', 'manythreads-bots'], ['STAGE_BOTS_NAMESPACE', 'manythreads-bots'], ['NAMESPACE', 'manythreads']] as const) {
    it(`refuses ${name}=${value} before any kubectl call`, () => {
      for (const sub of ['check', 'remove', 'seed', 'image']) {
        const res = run(probe, [sub], stageEnv({ [name]: value, DOCKER: stub('docker', 'echo "docker $*" >>"$FAKE_LOG"'), K3S: stub('k3s', 'echo "k3s $*" >>"$FAKE_LOG"') }));
        expect(res.code, `${sub}: ${res.out}`).toBe(1);
        expect(res.out).toMatch(/never touches another namespace/);
      }
      expect(calls()).toEqual([]);
    });
  }

  it('a usage error for an unknown word', () => {
    expect(run(probe, ['bogus'], stageEnv()).code).toBe(2);
  });

  it('on a healthy stage every line passes, and EVERY kubectl call names a stage namespace (or is a rights question / node read)', () => {
    const res = run(probe, ['check'], stageEnv());
    expect(res.code, res.out).toBe(0);
    expect(res.out).not.toMatch(/^FAIL/m);
    expect(res.out).toContain('PASS  the Kubernetes API: no connection');
    expect(res.out).toContain('PASS  169.254.169.254 (node metadata): no connection');
    expect(res.out).toContain('PASS  control: the server is reachable from the run container');
    expect(res.out).toContain('PASS  can-i keeper may patch its one credentials Secret: yes');
    expect(res.out).toContain('PASS  can-i keeper may not read the bridge key Secret: no');
    const all = calls();
    expect(all.length).toBeGreaterThan(30);
    for (const c of all) {
      const words = c.split(' ');
      expect(words, c).not.toContain('manythreads');
      expect(words, c).not.toContain('manythreads-bots');
      const ns = words.includes('-n') ? words[words.indexOf('-n') + 1] : null;
      if (ns !== null) expect(['manythreads-stage', 'manythreads-stage-bots', 'kube-system'], c).toContain(ns); // kube-system only inside a can-i question
      else expect(c, c).toMatch(/auth can-i|^kubectl$/);
      if (ns === 'kube-system') expect(c).toMatch(/auth can-i/);
      if (!c.includes('auth can-i')) expect(c, c).not.toMatch(/\b(delete|apply|patch|create|replace|scale|edit|annotate|label)\b/); // reads only; a rights question may name any verb
    }
  });

  it('FAILS when the run container connects to the Kubernetes API with data, to the metadata address or to the private host', () => {
    expect(run(probe, ['check'], stageEnv({ FAKE_API: 'status 200' })).out).toMatch(/FAIL {2}the Kubernetes API: the run container was answered with data/);
    expect(run(probe, ['check'], stageEnv({ FAKE_META: 'open' })).out).toMatch(/FAIL {2}169\.254\.169\.254 \(node metadata\): the run container connected/);
    const res = run(probe, ['check'], stageEnv({ FAKE_API: 'open' }));
    expect(res.code).toBe(1);
  });

  it('a refusal without a token (401) passes; a probe that did not run at all fails', () => {
    expect(run(probe, ['check'], stageEnv({ FAKE_API: 'status 401' })).out).toMatch(/PASS {2}the Kubernetes API: reachable but refused without a token/);
    const res = run(probe, ['check'], stageEnv({ FAKE_API: '' }));
    expect(res.out).toMatch(/FAIL {2}the Kubernetes API: the probe itself did not run/);
  });

  for (const where of ['describe', 'logs', 'events', 'yaml']) {
    it(`FAILS (exit 1, and names the read) when a sign-in byte is in ${where}`, () => {
      const res = run(probe, ['check'], stageEnv({ FAKE_LEAK: where }));
      expect(res.code).toBe(1);
      expect(res.out).toMatch(/^FAIL {2}.*holds sign-in bytes: .*fake-access-/m);
      expect(res.out).not.toContain('fake-access-shared-CANARY'); // only the pattern, never the text read from the pod
    });
  }

  it('FAILS when the process probe finds the canary in a container environment or command line', () => {
    const res = run(probe, ['check'], stageEnv({ FAKE_ENVLEAK: '1' }));
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/FAIL {2}container (bridge|keeper|repo-sync|publisher): sign-in bytes in hit environ CANARY/);
  });

  it('FAILS when a right is wider than the table in security.md', () => {
    const keeper = run(probe, ['check'], stageEnv({ FAKE_CANI_YES: 'delete secret/claude-claude-shared-credentials' }));
    expect(keeper.out).toMatch(/FAIL {2}can-i keeper may not delete it: expected no, got yes/);
    const server = run(probe, ['check'], stageEnv({ FAKE_CANI_YES: 'create pods/exec' }));
    expect(server.code).toBe(1);
    expect(server.out).toMatch(/FAIL {2}can-i controller may not exec into a pod: expected no, got yes/);
  });

  it('FAILS when the sign-in Secret is mounted by a container other than the init step', () => {
    const res = run(probe, ['check'], stageEnv({ FAKE_MOUNT_CREDS: 'prepare,bridge' }));
    expect(res.out).toMatch(/FAIL {2}mounts: the sign-in Secret is mounted by more than the init step/);
  });

  it('FAILS when the keeper cannot reach the Kubernetes API (a renewed login would never be copied back)', () => {
    const res = run(probe, ['check'], stageEnv({ FAKE_KEEPER_API: 'error ETIMEDOUT' }));
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/FAIL {2}keeper renews: the keeper container cannot reach the Kubernetes API/);
  });

  it('stops with a plain message when the stage has no runner pod', () => {
    const res = run(probe, ['check'], stageEnv({ FAKE_NO_PODS: '1' }));
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no Claude or Codex pod/);
  });

  it('keeps its own process out of its sweep (the probe command line names the patterns)', () => {
    const script = readFileSync(probe, 'utf8');
    expect(script).toContain('String(process.pid)');
  });
});
