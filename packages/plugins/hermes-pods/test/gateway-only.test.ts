import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { parseBotMd } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGatewayOnly, profileViolation } from '../src/gateway-only.ts';
import type { K8s, K8sObject } from '../src/k8s.ts';
import { Reconciler, type ProfileSource } from '../src/reconcile.ts';
import type { PodConfig } from '../src/render.ts';
import { GATEWAY_ENV, renderGatewayProfile } from '../../runtime-hermes/src/gateway-profile.ts';

// P19-10: a Hermes pod reaches models only through the platform's gateway, with the bot's own virtual key. Nothing the controller writes holds a model provider's
// key or address, whatever the process around it has in its environment.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(`${obj.kind}/${obj.metadata.namespace}/${obj.metadata.name}`, structuredClone(obj));
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    const o = this.store.get(`${kind}/${ns}/${name}`);
    return o ? structuredClone(o) : null;
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.store.delete(`${kind}/${ns}/${name}`);
  }
  async list(): Promise<K8sObject[]> {
    return [];
  }
}

const CFG: PodConfig = {
  namespace: 'manythreads',
  hermesImage: 'manythreads/hermes-pod:1',
  workbenchImage: 'manythreads/workbench:1',
  workspaceSize: '10Gi',
  homeSize: '2Gi',
  storageClass: 'local-path',
  repos: [{ name: 'demo' }],
  repoOriginAllow: [],
  deployerBot: 'deployer',
  appsPrefix: 'apps-',
  appsRouting: 'path',
  appsHost: 'example.test',
  resources: { hermes: { limits: { memory: '3Gi' } }, workbench: { limits: { memory: '4Gi' } } },
};
const TEAM = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering' };
const warnings: string[] = [];
const LOG: PluginLogger = { info: () => undefined, warn: (m) => void warnings.push(m) };

const CONFIG_YAML = [
  'model:',
  '  provider: "manythreads"',
  'providers:',
  '  manythreads:',
  '    api: "http://manythreads-litellm:4000/v1"',
  '    api_key: "${MANYTHREADS_LLM_KEY}"',
  '',
].join('\n');

const spec = (slug: string, over: Partial<GatewayProfileSpec> = {}): GatewayProfileSpec => ({
  profile: `mt-${slug}`,
  botId: `bot-${slug}`,
  files: { 'SOUL.md': `I am ${slug}`, 'config.yaml': CONFIG_YAML },
  secrets: { MCP_TOKEN: `mcp-${slug}`, LLM_KEY: `llm-${slug}`, API_SERVER_KEY: `key-${slug}-0123456789abcdef` },
  ...over,
});

const source = (profiles: GatewayProfileSpec[]): ProfileSource => ({ profilesForTeam: async () => profiles, setManagedGateway: async () => undefined });

const CANARIES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_BASE_URL'] as const;
const CANARY = 'canary-provider-key-7f3a91c2';
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  warnings.length = 0;
  for (const name of CANARIES) {
    saved.set(name, process.env[name]);
    process.env[name] = `${CANARY}-${name}`;
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('a Hermes pod holds no model provider key or address', () => {
  it('writes the pod objects of profiles made by the real renderer with none of the provider keys in the controller environment, and only the bot\'s own gateway variables', async () => {
    const parsed = parseBotMd('---\nname: Coder\nrole: Owns a task\nkind: agent\nruntime: hermes\nmodel: { aliases: [code] }\ncapabilities:\n  native: [messages.*]\nplacement:\n  gateway: { connection: managed }\n---\n# Coder\nYou own a task.\n');
    if (!parsed.ok) throw new Error(parsed.failure.message);
    // The same call the profiles provider makes: the real renderer, the platform's gateway address and the one key variable it allows.
    const real = (slug: string): GatewayProfileSpec => ({
      profile: `mt-${slug}`,
      botId: slug,
      files: {
        ...renderGatewayProfile(
          { frontmatter: parsed.frontmatter, body: parsed.body },
          {
            botSlug: slug,
            teamName: 'Engineering',
            mcpUrl: 'http://manythreads-server:3000/api/mcp/bots/x',
            mcpTokenVar: GATEWAY_ENV.mcpToken,
            filesInWorkbench: true,
            model: { baseUrl: 'http://manythreads-litellm:4000/v1', apiKeyVar: GATEWAY_ENV.llmKey, alias: 'code' },
          },
        ),
      },
      secrets: { MCP_TOKEN: `mcp-${slug}`, LLM_KEY: `llm-${slug}`, API_SERVER_KEY: `key-${slug}-0123456789abcdef` },
    });
    const k8s = new FakeK8s();
    const result = await new Reconciler(k8s, CFG, source([real('coder'), real('reviewer')]), LOG).reconcileTeam(TEAM);
    expect(result.profiles).toBe(2);
    expect(warnings.filter((w) => /was DROPPED/.test(w))).toHaveLength(0);
    expect(k8s.store.size).toBeGreaterThan(5);
    for (const [key, obj] of k8s.store) {
      const text = JSON.stringify(obj);
      expect(text, key).not.toContain(CANARY);
      expect(text, key).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|OPENAI_BASE_URL|api\.openai\.com|api\.anthropic\.com/);
    }
    // The renderer would have refused the other way round: a provider key variable or a provider address is an error before anything reaches the pod.
    expect(() => renderGatewayProfile({ frontmatter: parsed.frontmatter, body: parsed.body }, { botSlug: 'x', teamName: 'T', mcpUrl: 'http://s', mcpTokenVar: GATEWAY_ENV.mcpToken, model: { baseUrl: 'http://manythreads-litellm:4000/v1', apiKeyVar: 'OPENAI_API_KEY', alias: 'code' } })).toThrow();
  });

  it('leaves out a profile that defines a provider key, names a provider address or uses a provider variable, and says why', async () => {
    const k8s = new FakeK8s();
    const bad = [
      spec('a', { secrets: { MCP_TOKEN: 'm', LLM_KEY: 'l', API_SERVER_KEY: 'k', OPENAI_API_KEY: 'sk-x' } as GatewayProfileSpec['secrets'] }),
      spec('b', { files: { 'config.yaml': 'providers:\n  x:\n    api: "https://api.openai.com/v1"\n' } }),
      spec('c', { files: { 'config.yaml': 'providers:\n  x:\n    api_key: "${ANTHROPIC_API_KEY}"\n' } }),
      spec('d', { files: { 'config.yaml': CONFIG_YAML, '.env': 'OPENROUTER_API_KEY=x\n' } }),
    ];
    const result = await new Reconciler(k8s, CFG, source([...bad, spec('good')]), LOG).reconcileTeam(TEAM);
    expect(result.profiles).toBe(1);
    expect(warnings.filter((w) => /was DROPPED/.test(w))).toHaveLength(4);
    const profiles = JSON.parse(String(((await k8s.get('Secret', 'manythreads', 'hermes-engineering-profiles'))?.['stringData'] as Record<string, string>)['profiles.json'])) as { profiles: Array<{ profile: string }> };
    expect(profiles.profiles.map((p) => p.profile)).toEqual(['mt-good']);
  });

  it('profileViolation is null for the gateway profile and plain for the rest', () => {
    expect(profileViolation(spec('ok'))).toBeNull();
    expect(profileViolation(spec('x', { files: { 'config.yaml': 'api: https://openrouter.ai/api/v1' } }))).toMatch(/model provider's address/);
  });

  it('stops the write when a Deployment carries a provider variable or reads whole Secrets into its environment', () => {
    const deployment = (env: unknown[], envFrom?: unknown[]): K8sObject => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'hermes-x', namespace: 'manythreads' },
      spec: { template: { spec: { containers: [{ name: 'hermes', env, ...(envFrom ? { envFrom } : {}) }] } } },
    });
    expect(() => assertGatewayOnly([deployment([{ name: 'API_SERVER_KEY', value: 'x' }, { name: 'WORKBENCH_HOST', value: '127.0.0.1' }])])).not.toThrow();
    expect(() => assertGatewayOnly([deployment([{ name: 'OPENAI_API_KEY', value: 'x' }])])).toThrow(/never goes in a Hermes pod/);
    expect(() => assertGatewayOnly([deployment([{ name: 'ANTHROPIC_BASE_URL', value: 'x' }])])).toThrow(/never goes in a Hermes pod/);
    expect(() => assertGatewayOnly([deployment([], [{ secretRef: { name: 'provider-keys' } }])])).toThrow(/whole Secrets/);
  });
});
