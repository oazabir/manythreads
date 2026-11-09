import { describe, expect, it } from 'vitest';
import { configFrom } from '../src/config.ts';
import { buildDeployment, namesFor, type PodRunner } from '../src/render.ts';

// Decision E22: the chart's claudePod.runtimeClassName (MANYTHREADS_CLAUDE_PODS_RUNTIME_CLASS_NAME) puts the Claude and the Codex pod on that RuntimeClass (gVisor).

const runner = (agent: 'claude' | 'codex'): PodRunner => ({ id: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002', name: 'shared', enabled: true, node: null, maxConcurrent: null, teams: [], allTeams: true, bots: [], agent });
const podSpec = (env: NodeJS.ProcessEnv, agent: 'claude' | 'codex'): Record<string, unknown> => {
  const dep = buildDeployment(configFrom(env), runner(agent), namesFor('shared', agent), { replicas: 1 });
  return (dep['spec'] as { template: { spec: Record<string, unknown> } }).template.spec;
};

describe('the pod RuntimeClass', () => {
  it('is set on both kinds when the chart names one', () => {
    for (const agent of ['claude', 'codex'] as const) expect(podSpec({ MANYTHREADS_CLAUDE_PODS_RUNTIME_CLASS_NAME: 'gvisor' }, agent)['runtimeClassName'], agent).toBe('gvisor');
  });

  it('is left out when empty or not a valid name (the cluster default runtime)', () => {
    for (const value of [undefined, '', 'Not A Name', 'a;b']) expect('runtimeClassName' in podSpec({ MANYTHREADS_CLAUDE_PODS_RUNTIME_CLASS_NAME: value }, 'claude'), String(value)).toBe(false);
  });
});
