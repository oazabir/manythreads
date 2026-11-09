import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** stage-profile.sh against a stand-in kubectl: what `airgap up` applies when the node lists an IPv4 and an IPv6 address (the devbox does). */
const script = resolve(fileURLToPath(new URL('..', import.meta.url)), 'stage-profile.sh');
const dir = mkdtempSync(join(tmpdir(), 'mt-stage-profile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('stage-profile.sh airgap up', () => {
  it('writes the node\'s IPv4 address into the policy, not the whole dual-stack list', () => {
    const applied = join(dir, 'applied.yaml');
    const kubectl = join(dir, 'kubectl');
    writeFileSync(
      kubectl,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"get namespace"*) echo namespace/manythreads-stage ;;',
        '  *"get nodes"*) printf "10.0.2.15 fec0::5054:ff:fe12:3456" ;;',
        `  *"apply -f -"*) cat >${JSON.stringify(applied)} ;;`,
        'esac',
      ].join('\n'),
    );
    chmodSync(kubectl, 0o755);
    const res = spawnSync('bash', [script, 'airgap', 'up'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` } });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const yaml = readFileSync(applied, 'utf8');
    expect(yaml).toContain('cidr: 10.0.2.15/32');
    expect(yaml).not.toContain('fec0');
    expect(yaml).not.toContain('__NODE_IP__');
  });
});
