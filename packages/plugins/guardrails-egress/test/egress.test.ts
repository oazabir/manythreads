import { randomUUID } from 'node:crypto';
import { loadPlugins } from '@manythreads/kernel';
import { definePlugin, type EgressInput, type EgressTarget, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { GuardrailsEgressDecidedEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import guardrailsEgress from '../src/index.ts';
import { judgeTargets } from '../src/egress.ts';

// P5-21: the egress rule of the presets. `judgeTargets` is the pure rule (moved here from the LLM gateway, tests and all); the hook test runs
// it as a link of the real chain.

const hosted = (name: string, host: string | null): EgressTarget => ({ name, host, local: false });
const local: EgressTarget = { name: 'local', host: 'localhost', local: true };

describe('judgeTargets', () => {
  it('standard and customer-facing do not restrict where a call goes', () => {
    for (const preset of ['standard', 'customer-facing'] as const) {
      expect(judgeTargets(preset, [], [hosted('smart', 'api.openai.com')])).toBeNull();
    }
  });

  it('air-gapped runs the local alias only', () => {
    expect(judgeTargets('air-gapped', [], [local])).toBeNull();
    const refused = judgeTargets('air-gapped', [], [hosted('smart', 'api.anthropic.com')]);
    expect(refused).toMatchObject({ target: 'smart', host: 'api.anthropic.com' });
    expect(refused!.message).toBe('The air-gapped preset allows only the local alias, and this call asks for smart.');
  });

  it('air-gapped judges the host, not the name: `local` bound to a hosted provider (or one whose host cannot be told) is refused', () => {
    const refused = judgeTargets('air-gapped', [], [hosted('local', 'api.openai.com')]);
    expect(refused).toMatchObject({ target: 'local', host: 'api.openai.com' });
    expect(refused!.message).toBe('The air-gapped preset allows only a model inside this deployment, and the local alias goes to api.openai.com; mark its provider "runs inside this deployment" if it is.');
    expect(judgeTargets('air-gapped', [], [hosted('local', null)])!.message).toContain('a host that cannot be told');
    // an allowlist does not open an air gap
    expect(judgeTargets('air-gapped', ['api.openai.com'], [hosted('local', 'api.openai.com')])).not.toBeNull();
    // and a local first link with a hosted `local` is not possible, but a local first link with a hosted fallback is still refused by name
    expect(judgeTargets('air-gapped', [], [local, hosted('smart', 'api.openai.com')])!.message).toContain('falls back to smart');
  });

  it('judges the whole fallback chain: a local first link does not excuse a hosted fallback', () => {
    const viaFallback = judgeTargets('air-gapped', [], [local, hosted('smart', 'api.openai.com')]);
    expect(viaFallback!.message).toContain('local falls back to smart');

    const allow = ['api.anthropic.com'];
    const anthropic = hosted('smart', 'api.anthropic.com');
    expect(judgeTargets('strict-egress', allow, [anthropic, hosted('fast', 'api.anthropic.com')])).toBeNull();
    const leak = judgeTargets('strict-egress', allow, [anthropic, hosted('fast', 'api.openai.com')]);
    expect(leak!.message).toContain('api.openai.com');
    // a fallback whose host cannot be told is refused like a first link would be
    expect(judgeTargets('strict-egress', allow, [anthropic, hosted('code', null)])!.message).toContain('code (a fallback of smart)');
  });

  it('strict-egress allows an allowlisted host (any case), a local host, and nothing else', () => {
    const allow = ['API.Anthropic.com'];
    expect(judgeTargets('strict-egress', allow, [hosted('smart', 'api.anthropic.com')])).toBeNull();
    // a local endpoint is not egress, so no allowlist entry is needed for it
    expect(judgeTargets('strict-egress', allow, [local])).toBeNull();
    const elsewhere = judgeTargets('strict-egress', allow, [hosted('smart', 'api.openai.com')]);
    expect(elsewhere!.message).toBe("The strict-egress preset does not allow api.openai.com; an admin must add it to the workspace's allowlist.");
    // an alias nobody bound has no host to judge: strict egress refuses rather than guesses
    expect(judgeTargets('strict-egress', allow, [hosted('smart', null)])!.message).toContain('cannot tell');
    // an empty allowlist under strict-egress means nothing leaves the box
    expect(judgeTargets('strict-egress', [], [hosted('smart', 'api.anthropic.com')])).not.toBeNull();
  });
});

const tx = { actor: { kind: 'system', id: randomUUID(), workspaceId: randomUUID() }, query: () => Promise.reject(new Error('no db')) } as unknown as PluginTx;

async function world(): Promise<{ run(over: Partial<EgressInput>): ReturnType<PluginContext['hooks']['runPreEgress']>; events: PluginEvent[] }> {
  const events: PluginEvent[] = [];
  let caller: PluginContext | undefined;
  await loadPlugins({
    emit: (_tx: unknown, event: unknown) => {
      events.push(event as PluginEvent);
      return Promise.resolve();
    },
    plugins: [
      { definition: guardrailsEgress },
      {
        definition: definePlugin({
          manifest: { name: 'caller', version: '1.0.0', kind: 'server', extends: ['hook.pre_egress'], dependsOn: ['guardrails-egress'] },
          register: (ctx) => void (caller = ctx),
        }),
      },
    ],
  });
  return {
    events,
    run: (over) =>
      caller!.hooks.runPreEgress(tx, { destination: 'email', workspaceId: tx.actor.workspaceId, text: '', preset: 'strict-egress', allowlist: [], targets: [hosted('smtp', 'mail.example.org')], ...over }),
  };
}

describe('guardrails-egress at pre_egress', () => {
  it('blocks a destination the preset refuses, with reason preset and no rules', async () => {
    const w = await world();
    const decision = await w.run({});
    expect(decision).toMatchObject({ outcome: 'block', reason: 'preset', rules: [], hooks: 1 });
    expect(decision.message).toContain('mail.example.org');
  });

  it('allows an allowlisted host and a call that names no target (nothing to judge)', async () => {
    const w = await world();
    expect(await w.run({ allowlist: ['mail.example.org'] })).toMatchObject({ outcome: 'allow' });
    expect(await w.run({ targets: [] })).toMatchObject({ outcome: 'allow' });
    expect(w.events).toEqual([]);
  });

  it('treats a preset it does not know as standard (no restriction), like the content guard does', async () => {
    const w = await world();
    expect(await w.run({ preset: 'something-new' })).toMatchObject({ outcome: 'allow' });
  });

  it('writes guardrails.egress.decided in the registry shape, unless the caller records its own', async () => {
    const w = await world();
    await w.run({});
    expect(GuardrailsEgressDecidedEvent.parse(w.events[0])).toMatchObject({
      destination: 'email',
      preset: 'strict-egress',
      outcome: 'block',
      target: 'smtp',
      host: 'mail.example.org',
    });
    await w.run({ recorded: true });
    expect(w.events).toHaveLength(1);
  });
});
