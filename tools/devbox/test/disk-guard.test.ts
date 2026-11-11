import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * P10-08: tools/devbox/disk-guard.sh (the disk checks of deploy.sh) against stand-in df, docker, k3s and du in a temp folder. The stand-in df
 * answers the percentages of $FAKE_DF_SEQ one per call (the last one repeats), so a prune can "free" the disk. Nothing real is touched.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const guard = join(root, 'tools/devbox/disk-guard.sh');
const deploy = join(root, 'tools/devbox/deploy.sh');

let tmp = '';
let bin = '';
let log = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'disk-guard-'));
  bin = join(tmp, 'bin');
  log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  spawnSync('mkdir', ['-p', bin]);
  // (the sequence is consumed through a state file, since every call is a new process)
  stub('df', `
state="$FAKE_DF_STATE"; [ -f "$state" ] || echo "$FAKE_DF_SEQ" >"$state"
if [ "$1" = "--output=pcent" ]; then
  seq=$(cat "$state"); first=\${seq%%,*}
  case "$seq" in *,*) echo "\${seq#*,}" >"$state" ;; esac
  echo "Use%"; echo " \${first}%"; exit 0
fi
echo "Filesystem Size Used Avail Use% Mounted on"; echo "/dev/vda1 96G 70G 26G 73% /"`);
  stub('docker', `
echo "docker $*" >>"$FAKE_LOG"
case "$1 $2" in
  "ps -aq") for c in \${FAKE_CONTAINERS:-}; do echo "$c"; done ;;
  "inspect -f") shift 2; for c in "$@"; do echo "sha256:$c"; done ;;
  "images --no-trunc") cat "$FAKE_IMAGES" ;;
  "system df") echo "TYPE TOTAL SIZE"; echo "Images 9 12.18GB"; echo "Build Cache 71 20.33GB" ;;
  "save "*) if [ -n "\${FAKE_SLOW:-}" ]; then echo $$ >"$FAKE_PIDFILE"; exec sleep 30; fi; echo "tar-bytes" ;;
esac
exit 0`);
  stub('k3s', `
echo "k3s $*" >>"$FAKE_LOG"
case "$*" in
  *"images ls -q"*) for i in \${FAKE_K3S_IMAGES:-}; do echo "$i"; done ;;
  *"images import -"*) cat >/dev/null; [ -z "\${FAKE_IMPORT_FAIL:-}" ] || exit 1; echo "unpacking done" ;;
esac
exit 0`);
  stub('du', `echo "du $*" >>"$FAKE_LOG"; echo "9.0G /big-thing"; echo "1.0G /small-thing"`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}
const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);

function images(...rows: Array<[string, string]>): string {
  const file = join(tmp, 'images.txt');
  writeFileSync(file, rows.map(([ref, id]) => `${ref} sha256:${id}`).join('\n') + '\n');
  return file;
}

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const res = spawnSync('bash', [guard, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      HOME: tmp,
      FAKE_LOG: log,
      FAKE_DF_STATE: join(tmp, 'df.state'),
      FAKE_IMAGES: join(tmp, 'images.txt'),
      FAKE_PIDFILE: join(tmp, 'pid'),
      K3S_CONTAINERD_DIR: join(tmp, 'containerd'),
      DOCKER_DIR: join(tmp, 'dockerdir'),
      DISK_WATCH_SECONDS: '0.1',
      ...env,
    },
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

const SENTENCE = 'free the disk to about 60% before deploying; a deploy peaked at 90% on 2026-11-09 and the node evicted the database';

describe('disk-guard.sh check', () => {
  it('prints the disk use and does nothing else at or below 65%', () => {
    const res = run(['check'], { FAKE_DF_SEQ: '65' });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/disk: 70G used of 96G, 26G free, 73% in use/);
    expect(calls()).toEqual([]);
  });

  it('above 65% prunes the build cache, unused docker images and unused k3s images, re-checks, and goes on when it is down', () => {
    images(['manythreads/demo-fakes:old', 'aaa'], ['node:22-slim', 'bbb']);
    const res = run(['check'], { FAKE_DF_SEQ: '77,58' });
    expect(res.code).toBe(0);
    const c = calls();
    expect(c).toContain('docker builder prune -af');
    expect(c).toContain('docker image prune -f');
    expect(c).toContain('docker rmi manythreads/demo-fakes:old');
    expect(c).toContain('docker rmi node:22-slim');
    expect(c).toContain('k3s crictl rmi --prune');
    expect(res.out).toMatch(/pruning the build cache/);
    // never a volume, never the blanket prune, never a forced removal
    for (const line of c) {
      expect(line).not.toMatch(/volume|system prune|--volumes|rmi -f|rmi --force/);
    }
  });

  it('never removes an image a container uses or one it was asked to keep', () => {
    images(['manythreads/postgres:19', 'pg'], ['manythreads/hermes:stable', 'herm'], ['manythreads/server:T1', 'srv'], ['old/thing:1', 'old']);
    const res = run(['check', '--keep', 'manythreads/server:T1', '--keep-docker', 'manythreads/hermes:stable'], {
      FAKE_DF_SEQ: '77,58',
      FAKE_CONTAINERS: 'pg',
    });
    expect(res.code).toBe(0);
    const rmi = calls().filter((l) => l.startsWith('docker rmi'));
    expect(rmi).toEqual(['docker rmi old/thing:1']);
  });

  it('skips the k3s prune while an image of this deploy is already in k3s (the prune would delete it)', () => {
    images();
    const res = run(['check', '--keep', 'manythreads/server:T1'], { FAKE_DF_SEQ: '77,58', FAKE_K3S_IMAGES: 'docker.io/manythreads/server:T1' });
    expect(res.code).toBe(0);
    expect(calls()).not.toContain('k3s crictl rmi --prune');
    expect(res.out).toMatch(/k3s image prune skipped: manythreads\/server:T1/);
  });

  it('stops above 70% after the clean-up, with the biggest items and the sentence', () => {
    images();
    const res = run(['check'], { FAKE_DF_SEQ: '84,77' });
    expect(res.code).toBe(1);
    expect(res.out).toContain(SENTENCE);
    expect(res.out).toMatch(/77% in use after cleaning/);
    expect(res.out).toMatch(/docker system df/);
    expect(res.out).toMatch(/Build Cache 71 20\.33GB/);
    expect(res.out).toMatch(/9\.0G \/big-thing/);
    const c = calls();
    expect(c.some((l) => l.startsWith('du ') && l.includes('containerd'))).toBe(true);
    expect(c.some((l) => l.startsWith('du ') && l.includes('dockerdir'))).toBe(true);
  });

  it('stops without any cleaning being skipped: the clean-up runs before the stop', () => {
    images();
    run(['check'], { FAKE_DF_SEQ: '90' });
    expect(calls()).toContain('docker builder prune -af');
    expect(calls()).toContain('k3s crictl rmi --prune');
  });

  it('exactly 70% after the clean-up still goes on (the stop is above 70%)', () => {
    images();
    expect(run(['check'], { FAKE_DF_SEQ: '80,70' }).code).toBe(0);
  });

  it('DEPLOY_ALLOW_HIGH_DISK=1 goes on with a loud warning', () => {
    images();
    const res = run(['check'], { FAKE_DF_SEQ: '84', DEPLOY_ALLOW_HIGH_DISK: '1' });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/WARNING: the disk is 84% in use/);
    expect(res.out).toContain('2026-11-09');
  });

  it('an unknown argument is a usage error', () => {
    expect(run(['check', '--bogus'], { FAKE_DF_SEQ: '10' }).code).toBe(2);
    expect(run([], {}).code).toBe(2);
  });
});

describe('disk-guard.sh import', () => {
  it('saves from docker into k3s and succeeds while the disk is below 88%', () => {
    const res = run(['import', 'manythreads/web:T1'], { FAKE_DF_SEQ: '60' });
    expect(res.code).toBe(0);
    expect(res.out).toContain('unpacking done');
    expect(calls()).toContain('docker save manythreads/web:T1');
    expect(calls().some((l) => l.startsWith('k3s ctr -n k8s.io images import'))).toBe(true);
  });

  it('a failed import is a failed step', () => {
    expect(run(['import', 'manythreads/web:T1'], { FAKE_DF_SEQ: '60', FAKE_IMPORT_FAIL: '1' }).code).not.toBe(0);
  });

  it('aborts the import and prints df when the disk reaches 88%', () => {
    const res = run(['import', 'manythreads/server:T1'], { FAKE_DF_SEQ: '70,75,80,88', FAKE_SLOW: '1' });
    expect(res.code).toBe(3);
    expect(res.out).toMatch(/disk reached 88%/);
    expect(res.out).toMatch(/was stopped/);
    expect(res.out).toMatch(/\/dev\/vda1 96G/);
    expect(res.out).toContain(SENTENCE);
    const pid = Number(readFileSync(join(tmp, 'pid'), 'utf8').trim());
    expect(() => process.kill(pid, 0)).toThrow(); // the `docker save` was killed, not left running
  });

  it('87% does not abort', () => {
    const res = run(['import', 'manythreads/web:T1'], { FAKE_DF_SEQ: '87' });
    expect(res.code).toBe(0);
  });
});

describe('deploy.sh wiring', () => {
  const text = readFileSync(deploy, 'utf8');
  it('runs the guard before the first image is built and imports through the watch', () => {
    const guardAt = text.indexOf('disk-guard.sh check');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(text.indexOf('docker build'));
    expect(text).toMatch(/disk-guard\.sh import "\$img"/);
    expect(text).not.toMatch(/docker save "\$img" \| k3s/);
    expect(text).toMatch(/--keep-docker manythreads\/hermes:stable/);
  });
  it('keeps the 10 GB free rule of the big images', () => {
    expect(text.match(/-lt 10 \]/g)?.length).toBe(2);
  });
  it('the guard script exists, is valid bash and never mentions volumes except to say it leaves them alone', () => {
    expect(existsSync(guard)).toBe(true);
    expect(spawnSync('bash', ['-n', guard]).status).toBe(0);
    expect(spawnSync('bash', ['-n', deploy]).status).toBe(0);
    const g = readFileSync(guard, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(g.join("\n")).not.toMatch(/docker volume|system prune|--volumes|rmi -f|--force/);
  });
});
