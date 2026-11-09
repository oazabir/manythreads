import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { chartDir, haveHelm, parseDocs } from './chart.ts';

// Review finding (CR-2): the preview release is installed by the deployer bot into test-manythreads with a Role that cannot touch NetworkPolicies,
// and that namespace has its own default-deny rules. The preview values must therefore render no NetworkPolicy at all.
describe.skipIf(!haveHelm)('the preview release (deploy/preview/values-preview.yaml)', () => {
  const r = spawnSync('helm', ['template', 'manythreads-preview', chartDir, '-n', 'test-manythreads', '-f', `${chartDir}/../../preview/values-preview.yaml`, '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  it('renders', () => {
    expect(r.status, r.stderr).toBe(0);
  });

  it('renders no NetworkPolicy', () => {
    const kinds = parseDocs(r.stdout).map((d) => `${d.kind}/${d.metadata.name}`);
    expect(kinds.filter((k) => k.startsWith('NetworkPolicy/'))).toEqual([]);
  });
});
