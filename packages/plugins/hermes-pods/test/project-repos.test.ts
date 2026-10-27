import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { withProjectRepos } from '../src/project-repos.ts';
import { Reconciler } from '../src/reconcile.ts';
import type { K8s, K8sObject } from '../src/k8s.ts';
import type { PodConfig } from '../src/render.ts';

const CFG: PodConfig = {
  namespace: 'manythreads',
  hermesImage: 'h:1',
  workbenchImage: 'w:1',
  workspaceSize: '10Gi',
  homeSize: '2Gi',
  storageClass: 'local-path',
  repos: [{ name: 'demo' }],
  repoOriginAllow: ['https://github.com/oazabir/'],
  deployerBot: '',
  appsPrefix: 'apps-',
  appsRouting: 'path',
  appsHost: 'example.test',
  resources: { hermes: {}, workbench: {} },
};
const TEAM = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering' };
const LOG: PluginLogger = { info: () => undefined, warn: () => undefined };
const spec: GatewayProfileSpec = {
  profile: 'mt-dev',
  botId: 'bot-dev',
  files: { 'SOUL.md': 'x', 'config.yaml': 'model:\n  default: fast\n', '.env.template': 'API_SERVER_KEY=\n' },
  secrets: { MCP_TOKEN: 'm', LLM_KEY: 'l', API_SERVER_KEY: 'key-dev-0123456789abcdef' },
};

class Store implements K8s {
  readonly objects = new Map<string, K8sObject>();
  async apply(o: K8sObject): Promise<void> {
    this.objects.set(`${o.kind}/${o.metadata.name}`, structuredClone(o));
  }
  async get(): Promise<K8sObject | null> {
    return null;
  }
  async list(): Promise<K8sObject[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

describe('withProjectRepos', () => {
  it('adds the projects after the static list and lets the chart win on a shared name', () => {
    const merged = withProjectRepos(CFG, [
      { name: 'manythreads', origin: 'https://github.com/oazabir/manythreads' },
      { name: 'demo', origin: 'https://github.com/oazabir/other' },
    ]);
    expect(merged.repos).toEqual([{ name: 'demo' }, { name: 'manythreads', origin: 'https://github.com/oazabir/manythreads' }]);
  });

  it('carries the project branch, and leaves out an address that is not allowed or not plain', () => {
    const merged = withProjectRepos(CFG, [
      { name: 'ok', origin: 'https://github.com/oazabir/ok', branch: 'develop' },
      { name: 'other', origin: 'https://evil.example/x', branch: 'main' },
      { name: 'dots', origin: 'https://github.com/oazabir/../evil/x' },
      { name: 'encoded', origin: 'https://github.com/oazabir/%2e%2e/evil/x' },
      { name: 'double', origin: 'https://github.com/oazabir//x' },
    ]);
    expect(merged.repos).toEqual([{ name: 'demo' }, { name: 'ok', origin: 'https://github.com/oazabir/ok', branch: 'develop' }]);
  });
});

describe('the pod gets the team projects as repositories of record', () => {
  const botsDoc = async (projects: { name: string; origin: string }[]): Promise<{ repos: { name: string; origin?: string }[] }> => {
    const k8s = new Store();
    const src = { profilesForTeam: async () => [spec], reposForTeam: async () => projects };
    await new Reconciler(k8s, CFG, src, LOG, () => 'KEY').reconcileTeam(TEAM);
    const cm = k8s.objects.get('ConfigMap/hermes-engineering-bots')!;
    return JSON.parse((cm['data'] as Record<string, string>)['bots.json']!) as { repos: { name: string; origin?: string }[] };
  };

  it('lists an allowed project next to the chart repositories', async () => {
    const doc = await botsDoc([{ name: 'manythreads', origin: 'https://github.com/oazabir/manythreads' }]);
    expect(doc.repos).toEqual([{ name: 'demo' }, { name: 'manythreads', origin: 'https://github.com/oazabir/manythreads' }]);
  });

  it('leaves out a project whose address has dot segments even though it starts with an allowed prefix', async () => {
    const doc = await botsDoc([{ name: 'sneaky', origin: 'https://github.com/oazabir/../evil/repo' }]);
    expect(doc.repos).toEqual([{ name: 'demo' }]);
  });

  it('leaves out a project whose address the chart does not allow', async () => {
    const doc = await botsDoc([{ name: 'evil', origin: 'https://evil.example/x' }]);
    expect(doc.repos).toEqual([{ name: 'demo' }]);
  });
});
