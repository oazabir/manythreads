import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs module (it is also a command line tool)
import { RELEASE_IMAGES, buildRelease, checkRelease, main } from '../release-manifest.mjs';

/**
 * P27-01: tools/devbox/release-images.sh and release-manifest.mjs. Docker and helm are stand-ins in a temp folder that record their calls; nothing is pushed anywhere.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(root, 'tools/devbox/release-images.sh');

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const NAMES = RELEASE_IMAGES.map(([n]: [string]) => n) as string[];

let tmp = '';
let bin = '';
let log = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'release-images-'));
  bin = join(tmp, 'bin');
  log = join(tmp, 'calls.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  stub(
    'docker',
    `
echo "docker $*" >>"$FAKE_LOG"
case "$1" in
  images) case "$*" in *workbench*) echo "abc1234567 2026-11-16 10:00:00 +0000 UTC";; *claude-pod*) echo "def1234567 2026-11-16 09:00:00 +0000 UTC";; *hermes-pod*) echo "1111111111 2026-11-16 08:00:00 +0000 UTC";; esac ;;
  image) [ -z "$FAKE_MISSING" ] || case "$3" in *"$FAKE_MISSING"*) exit 1;; esac ;;
  login) cat >"$FAKE_STDIN"; ;;
  push) n=$(echo "$2" | sed 's#.*manythreads-\\([a-z-]*\\):.*#\\1#'); c=$(printf '%s' "$n" | cksum | cut -c1-1); echo "The push refers to repository [$2]"; printf '0.0.0: digest: sha256:%064d size: 1234\\n' "$c" ;;
esac
exit 0`,
  );
  stub('helm', `echo "helm $*" >>"$FAKE_LOG"; case "$1 $2" in "registry login") cat >"$FAKE_STDIN";; esac; exit 0`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env['PATH']}`, HOME: tmp, RELEASE_DIR: join(tmp, 'rel'), DOCKER: join(bin, 'docker'), HELM: join(bin, 'helm'), FAKE_LOG: log, FAKE_STDIN: join(tmp, 'stdin'), FAKE_MISSING: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(log, 'utf8') };
}

const TOKEN = { MANYTHREADS_GHCR_USER: 'bot', MANYTHREADS_GHCR_TOKEN: 'ghp_not-a-real-token' };

describe('release-images.sh', () => {
  it('plan prints where each image goes, pushes nothing and needs no token', () => {
    const r = run(['plan', '--version', '0.27.0', '--owner', 'acme', '--tag', 'abc123']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('manythreads/server:abc123');
    expect(r.out).toContain('ghcr.io/acme/manythreads-server:0.27.0');
    expect(r.out).toContain('127.0.0.1:30500/platform/postgres-cnpg:');
    expect(r.out).toContain('oci://ghcr.io/acme/charts/manythreads:0.27.0');
    expect(r.calls).not.toMatch(/docker (push|login|tag)/);
  });

  it('push without a token stops with exit 3 before it touches docker', () => {
    const r = run(['push', '--version', '0.27.0', '--owner', 'acme']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('no token');
    expect(r.calls).toBe('');
    const one = run(['push', '--version', '0.27.0', '--owner', 'acme'], { MANYTHREADS_GHCR_USER: 'bot' });
    expect(one.code).toBe(3);
    expect(run(['chart', '--version', '0.27.0', '--owner', 'acme']).code).toBe(3);
  });

  it('refuses a bad version or owner with exit 2', () => {
    expect(run(['plan', '--version', 'v1', '--owner', 'acme']).code).toBe(2);
    expect(run(['plan', '--version', '0.27.0']).code).toBe(2);
    expect(run(['plan', '--version', '0.27.0', '--owner', 'Acme Inc']).code).toBe(2);
    expect(run(['plan', '--version', '0.27.0', '--owner', 'acme', '--wat']).code).toBe(2);
    expect(run(['frobnicate', '--version', '0.27.0', '--owner', 'acme']).code).toBe(2);
  });

  it('push with a token but a missing image stops with exit 4 and pushes nothing', () => {
    const r = run(['push', '--version', '0.27.0', '--owner', 'acme', '--tag', 'abc123'], { ...TOKEN, FAKE_MISSING: 'manythreads/web' });
    expect(r.code).toBe(4);
    expect(r.err).toContain('web');
    expect(r.calls).not.toMatch(/docker (push|login)/);
  });

  it('push signs in with the token on standard input only, pushes each image and writes the digests', () => {
    const r = run(['push', '--version', '0.27.0', '--owner', 'acme', '--tag', 'abc123'], TOKEN);
    expect(r.code, r.err).toBe(0);
    expect(r.calls + r.out + r.err).not.toContain(TOKEN.MANYTHREADS_GHCR_TOKEN);
    expect(readFileSync(join(tmp, 'stdin'), 'utf8')).toBe(TOKEN.MANYTHREADS_GHCR_TOKEN);
    expect(r.calls).toContain('docker login ghcr.io -u bot --password-stdin');
    expect(r.calls).toContain('docker push ghcr.io/acme/manythreads-server:0.27.0');
    const digests = JSON.parse(readFileSync(join(tmp, 'rel/digests-0.27.0.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(digests).sort()).toEqual(['claude-pod', 'hermes-pod', 'postgres-cnpg', 'server', 'web', 'workbench']);
    for (const v of Object.values(digests)) expect(v).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('chart packages and pushes with the token on standard input', () => {
    const r = run(['chart', '--version', '0.27.0', '--owner', 'acme'], TOKEN);
    expect(r.code, r.err).toBe(0);
    expect(r.calls).toContain('helm registry login ghcr.io -u bot --password-stdin');
    expect(r.calls).toMatch(/helm package .*deploy\/helm\/manythreads --version 0\.27\.0/);
    expect(r.calls).toContain('oci://ghcr.io/acme/charts');
    expect(r.calls + r.out + r.err).not.toContain(TOKEN.MANYTHREADS_GHCR_TOKEN);
  });

  it('manifest needs the digests first', () => {
    const r = run(['manifest', '--version', '0.27.0', '--owner', 'acme']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('run push first');
  });
});

describe('release.json', () => {
  const digests = Object.fromEntries(NAMES.filter((n) => n !== 'asr').map((n, i) => [n, d(String(i + 1))]));
  const base = { version: '0.27.0', owner: 'acme', digests, installSha256: 'a'.repeat(64), commit: 'abc', now: new Date('2026-11-16T10:00:00Z') };

  it('names every image by digest in the owner\'s packages', () => {
    const r = buildRelease(base);
    expect(r.images['server']).toBe(`ghcr.io/acme/manythreads-server@${d('1')}`);
    expect(r.chart).toEqual({ ref: 'oci://ghcr.io/acme/charts/manythreads', version: '0.27.0' });
    expect(r.installSha256).toBe('a'.repeat(64));
    expect(checkRelease(r)).toEqual([]);
  });

  it('refuses a missing image, a bare tag, a stranger and a bad install hash', () => {
    expect(() => buildRelease({ ...base, digests: { ...digests, web: undefined } })).toThrow(/digest of web is missing/);
    expect(() => buildRelease({ ...base, digests: { ...digests, web: 'latest' } })).toThrow(/web is not sha256/);
    expect(() => buildRelease({ ...base, digests: { ...digests, litellm: d('9') } })).toThrow(/not a release image: litellm/);
    expect(() => buildRelease({ ...base, installSha256: 'xyz' })).toThrow(/install\.sh/);
    expect(() => buildRelease({ ...base, version: 'next' })).toThrow(/version/);
  });

  it('check names what is wrong in a file somebody edited', () => {
    const r = buildRelease(base);
    r.images['server'] = 'ghcr.io/acme/manythreads-server:latest';
    delete r.images['claude-pod'];
    r.images['evil'] = 'x';
    expect(checkRelease(r)).toEqual(['image server is not ghcr.io/<owner>/manythreads-server@sha256:<digest>', 'image claude-pod is missing', 'image evil is not a release image']);
  });

  it('the command line builds a file and checks it (exit 0, 1)', () => {
    const f = join(tmp, 'digests.json');
    writeFileSync(f, JSON.stringify(digests));
    const out = join(tmp, 'release.json');
    const lines: string[] = [];
    expect(main(['build', '--version', '0.27.0', '--owner', 'acme', '--digests', f, '--install-sha256', 'b'.repeat(64), '--out', out], (l: string) => lines.push(l), (l: string) => lines.push(l))).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(main(['check', out], () => undefined, (l: string) => lines.push(l))).toBe(0);
    writeFileSync(out, '{"schema":2}');
    expect(main(['check', out], () => undefined, () => undefined)).toBe(1);
    expect(main([], () => undefined, () => undefined)).toBe(2);
  });
});
