import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P19-05: the Claude pod switches in the chart. `helm template` (skipped where helm is absent): off means no trace, on adds one network policy and the server's settings, and
// no new permission of any kind.

const chart = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../deploy/helm/manythreads');
const haveHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const render = (extra: string[]): { code: number; out: string } => {
  const r = spawnSync('helm', ['template', 't', chart, '-n', 'manythreads', '-f', resolve(chart, 'values-live.yaml'), ...extra], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const docsOf = (out: string, kind: string): string[] => out.split(/^---$/m).filter((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d));

describe.skipIf(!haveHelm)('the chart (P19-05)', () => {
  it('is off in the live values: nothing about Claude pods is rendered', () => {
    const r = render([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/CLAUDE_PODS|claude-pod/);
  });

  it('on: one network policy for claude-pod only, ingress from the server on 8650, and 443 out only in public443 mode', () => {
    const r = render(['--set', 'claudePod.enabled=true']);
    expect(r.code, r.out).toBe(0);
    const policy = docsOf(r.out, 'NetworkPolicy').find((d) => d.includes('name: manythreads-claude-pods'))!;
    expect(policy).toContain('app.kubernetes.io/component: claude-pod');
    expect(policy).toContain('port: 8650');
    expect(policy).toContain('port: 443');
    expect(policy).toContain('10.0.0.0/8');
    const closed = render(['--set', 'claudePod.enabled=true', '--set', 'claudePod.egress.mode=serverOnly']);
    expect(docsOf(closed.out, 'NetworkPolicy').find((d) => d.includes('name: manythreads-claude-pods'))).not.toContain('port: 443');
    // the Hermes pods' own policy still selects only its own pods
    expect(docsOf(r.out, 'NetworkPolicy').find((d) => d.includes('name: manythreads-hermes-pods'))).toContain('app.kubernetes.io/component: hermes-pod');
  });

  it('adds no Role, ClusterRole or binding', () => {
    const base = render([]);
    const on = render(['--set', 'claudePod.enabled=true']);
    for (const kind of ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'ServiceAccount']) expect(docsOf(on.out, kind).length, kind).toBe(docsOf(base.out, kind).length);
  });

  it('gives the server the settings, and the stand-in image only when useFake is on', () => {
    const real = render(['--set', 'claudePod.enabled=true']).out;
    expect(real).toContain('name: MANYTHREADS_CLAUDE_PODS, value: "1"');
    expect(real).toContain('name: MANYTHREADS_CLAUDE_PODS_IMAGE, value: "manythreads/claude-pod:1"');
    const fake = render(['--set', 'claudePod.enabled=true', '--set', 'claudePod.useFake=true']).out;
    expect(fake).toContain('name: MANYTHREADS_CLAUDE_PODS_IMAGE, value: "manythreads/claude-pod-fake:1"');
  });

  it('refuses to render without the Hermes pods and with an unknown egress mode', () => {
    const noHermes = render(['--set', 'claudePod.enabled=true', '--set', 'hermesPods.enabled=false']);
    expect(noHermes.code).not.toBe(0);
    expect(noHermes.out).toContain('claudePod.enabled needs hermesPods.enabled');
    expect(render(['--set', 'claudePod.enabled=true', '--set', 'claudePod.egress.mode=anything']).code).not.toBe(0);
  });
});
