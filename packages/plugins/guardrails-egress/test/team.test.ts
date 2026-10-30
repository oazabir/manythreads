import { randomUUID } from 'node:crypto';
import { loadPlugins } from '@manythreads/kernel';
import { definePlugin, type EgressInput, type EgressTarget, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { GuardrailsEgressDecidedEvent, isProviderHost, normalizeEgressHost } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { judgeTeamHosts } from '../src/egress.ts';
import guardrailsEgress from '../src/index.ts';

// P10-04: a team's own list of hosts. The pure rule first, then the hook as a link of the real chain with a transaction that answers the team's row.

const hosted = (name: string, host: string | null): EgressTarget => ({ name, host, local: false });
const provider = (host: string): boolean => isProviderHost(host);

describe('judgeTeamHosts', () => {
  it('does nothing while the team is not limited', () => {
    expect(judgeTeamHosts(false, ['api.github.com'], [], [hosted('web', 'evil.example')], provider)).toBeNull();
  });

  it('lets a listed host through, from the team list or the workspace list, ignoring case', () => {
    expect(judgeTeamHosts(true, ['api.github.com'], [], [hosted('web', 'API.GitHub.com')], provider)).toBeNull();
    expect(judgeTeamHosts(true, [], ['registry.npmjs.org'], [hosted('web', 'registry.npmjs.org')], provider)).toBeNull();
  });

  it('refuses a host that is on neither list, with a sentence that names the host and where to change it', () => {
    const refused = judgeTeamHosts(true, ['api.github.com'], [], [hosted('web', 'evil.example')], provider);
    expect(refused).toMatchObject({ target: 'web', host: 'evil.example' });
    expect(refused!.message).toContain('evil.example');
    expect(refused!.message).toContain('Data protection');
  });

  it('refuses a target whose host cannot be told, and never counts the machine itself as a way out', () => {
    expect(judgeTeamHosts(true, [], [], [hosted('web', null)], provider)).not.toBeNull();
    expect(judgeTeamHosts(true, [], [], [{ name: 'local', host: 'localhost', local: true }], provider)).toBeNull();
  });

  it('ignores a model provider on the team list, so a hand-made row cannot open a way to a hosted model', () => {
    expect(judgeTeamHosts(true, ['api.openai.com', 'api.github.com'], [], [hosted('web', 'api.openai.com')], provider)).not.toBeNull();
    expect(judgeTeamHosts(true, ['api.openai.com', 'api.github.com'], [], [hosted('web', 'api.github.com')], provider)).toBeNull();
  });

  it('judges every target, not only the first', () => {
    expect(judgeTeamHosts(true, ['a.example.org'], [], [hosted('one', 'a.example.org'), hosted('two', 'b.example.org')], provider)).toMatchObject({ target: 'two' });
  });
});

describe('hosts and provider domains', () => {
  it('normalizes what an admin types to a host', () => {
    expect(normalizeEgressHost(' HTTPS://API.Example.com:8443/v1/x?y=1 ')).toBe('api.example.com');
    expect(normalizeEgressHost('example.com.')).toBe('example.com');
    expect(normalizeEgressHost('10.0.0.5')).toBe('10.0.0.5');
    for (const bad of ['', 'not a host', 'a_b.example.com', '-bad.example.com', 'http://', 'x'.repeat(300) + '.com']) expect(normalizeEgressHost(bad), bad).toBeNull();
  });

  it('knows a provider by its domain and by any subdomain, but not by a look-alike', () => {
    expect(isProviderHost('api.openai.com')).toBe(true);
    expect(isProviderHost('openai.com')).toBe(true);
    expect(isProviderHost('eu.api.anthropic.com')).toBe(true);
    expect(isProviderHost('notopenai.com')).toBe(false);
    expect(isProviderHost('openai.com.evil.example')).toBe(false);
    expect(isProviderHost('llm.internal.example', ['llm.internal.example'])).toBe(true);
  });

  it('knows a cloud provider\'s regional model hosts, which no fixed suffix describes, and still not its other services', () => {
    expect(isProviderHost('bedrock-runtime.us-east-1.amazonaws.com')).toBe(true);
    expect(isProviderHost('bedrock-agent-runtime.eu-west-2.amazonaws.com')).toBe(true);
    expect(isProviderHost('bedrock-runtime-fips.us-gov-west-1.amazonaws.com')).toBe(true);
    expect(isProviderHost('s3.us-east-1.amazonaws.com')).toBe(false);
    expect(isProviderHost('bedrock-runtime.us-east-1.amazonaws.com.evil.example')).toBe(false);
    expect(isProviderHost('api.cerebras.ai')).toBe(true);
  });
});

function world(row: { enforce: boolean; hosts: string[] } | null) {
  const workspaceId = randomUUID();
  const asked: unknown[][] = [];
  const tx = {
    actor: { kind: 'bot', id: randomUUID(), workspaceId },
    query: (_sql: string, params: unknown[]) => {
      asked.push(params);
      return Promise.resolve({ rows: row ? [row] : [] });
    },
  } as unknown as PluginTx;
  const events: PluginEvent[] = [];
  let caller: PluginContext | undefined;
  const ready = loadPlugins({
    emit: (_tx: unknown, event: unknown) => {
      events.push(event as PluginEvent);
      return Promise.resolve();
    },
    plugins: [
      { definition: guardrailsEgress },
      { definition: definePlugin({ manifest: { name: 'caller', version: '1.0.0', kind: 'server', extends: ['hook.pre_egress'], dependsOn: ['guardrails-egress'] }, register: (ctx) => void (caller = ctx) }) },
    ],
  });
  return {
    events,
    asked,
    run: async (over: Partial<EgressInput>) => {
      await ready;
      return caller!.hooks.runPreEgress(tx, { destination: 'mcp', workspaceId, text: '', preset: 'standard', teamId: randomUUID(), targets: [hosted('web', 'evil.example')], ...over });
    },
  };
}

describe('guardrails-egress with a team list', () => {
  it('blocks a host outside the list of a limited team, under any preset, and writes the decision with the team', async () => {
    const w = world({ enforce: true, hosts: ['api.github.com'] });
    const teamId = randomUUID();
    const decision = await w.run({ teamId });
    expect(decision).toMatchObject({ outcome: 'block', reason: 'preset' });
    expect(GuardrailsEgressDecidedEvent.parse(w.events[0])).toMatchObject({ destination: 'mcp', teamId, host: 'evil.example', outcome: 'block' });
  });

  it('allows a listed host and a team that is not limited', async () => {
    expect((await world({ enforce: true, hosts: ['evil.example'] }).run({})).outcome).toBe('allow');
    expect((await world({ enforce: false, hosts: [] }).run({})).outcome).toBe('allow');
    expect((await world(null).run({})).outcome).toBe('allow');
  });

  it('never consults the team list for a model call, and not at all without a team', async () => {
    const w = world({ enforce: true, hosts: [] });
    expect((await w.run({ destination: 'llm' })).outcome).toBe('allow');
    expect((await w.run({ teamId: null })).outcome).toBe('allow');
    expect(w.asked).toEqual([]);
  });
});
