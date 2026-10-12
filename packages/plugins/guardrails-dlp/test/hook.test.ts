import { randomUUID } from 'node:crypto';
import { loadPlugins } from '@manythreads/kernel';
import { definePlugin, type EgressInput, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { GuardrailsDlpDecidedEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import guardrailsEgress from '../../guardrails-egress/src/index.ts';
import guardrailsDlp from '../src/index.ts';

// P5-21: guardrails-dlp as a link of the `pre_egress` chain, with the real kernel chain around it (no database: the hook is string work).

const tx = { actor: { kind: 'system', id: randomUUID(), workspaceId: randomUUID() }, query: () => Promise.reject(new Error('no db')) } as unknown as PluginTx;
const KEY = `sk-${'ab3dEf6hIj'.repeat(3)}`;

async function world(): Promise<{ run(over: Partial<EgressInput>): ReturnType<PluginContext['hooks']['runPreEgress']>; events: PluginEvent[] }> {
  const events: PluginEvent[] = [];
  let caller: PluginContext | undefined;
  await loadPlugins({
    emit: (_tx: unknown, event: unknown) => {
      events.push(event as PluginEvent);
      return Promise.resolve();
    },
    plugins: [
      { definition: guardrailsDlp },
      { definition: guardrailsEgress }, // dlp depends on it: the order of the chain (a call with no targets is nothing to it)
      {
        definition: definePlugin({
          manifest: { name: 'caller', version: '1.0.0', kind: 'server', extends: ['hook.pre_egress'], dependsOn: ['guardrails-dlp'] },
          register: (ctx) => void (caller = ctx),
        }),
      },
    ],
  });
  return {
    events,
    run: (over) =>
      caller!.hooks.runPreEgress(tx, { destination: 'channel', workspaceId: tx.actor.workspaceId, text: `use ${KEY} to deploy`, preset: 'standard', ...over }),
  };
}

describe('guardrails-dlp at pre_egress', () => {
  it('redacts a finding under standard, and says what it found without saying the text', async () => {
    const w = await world();
    const decision = await w.run({});
    expect(decision).toMatchObject({ outcome: 'redact', text: 'use [redacted:api-key] to deploy', rules: ['api-key'], hooks: 2 });
    expect(JSON.stringify(decision)).not.toContain(KEY);
  });

  it('refuses outright under customer-facing: block, reason dlp, the original text kept for the caller', async () => {
    const w = await world();
    const decision = await w.run({ preset: 'customer-facing' });
    expect(decision).toMatchObject({ outcome: 'block', reason: 'dlp', rules: ['api-key'] });
    expect(decision.message).toBe('The customer-facing preset refuses a call that carries api-key.');
    expect(decision.text).toContain(KEY);
  });

  it('holds for a person when the caller asked (mode hold): require_approval with the redacted text an approver may see', async () => {
    const w = await world();
    const decision = await w.run({ mode: 'hold' });
    expect(decision).toMatchObject({ outcome: 'require_approval', reason: 'dlp', text: 'use [redacted:api-key] to deploy' });
    expect(decision.message).toContain('A person has to approve');
  });

  it('lets an approved call through as written, but not past a preset that refuses', async () => {
    const w = await world();
    expect(await w.run({ mode: 'approved' })).toMatchObject({ outcome: 'allow', text: `use ${KEY} to deploy`, rules: ['api-key'] });
    expect(await w.run({ mode: 'approved', preset: 'customer-facing' })).toMatchObject({ outcome: 'block' });
    expect(w.events).toEqual([expect.objectContaining({ type: 'guardrails.dlp.decided', outcome: 'block' })]);
  });

  it('allows text with nothing to find, and has nothing to say about an empty text or a call that carries none', async () => {
    const w = await world();
    expect(await w.run({ text: 'how do I rotate the deploy key?' })).toMatchObject({ outcome: 'allow', rules: [] });
    expect(await w.run({ text: '' })).toMatchObject({ outcome: 'allow', rules: [] });
    expect(w.events).toEqual([]);
  });

  it('treats a preset it does not know as standard, not as no rule', async () => {
    const w = await world();
    expect(await w.run({ preset: 'something-new' })).toMatchObject({ outcome: 'redact' });
  });

  it('writes guardrails.dlp.decided for a destination nobody else records, in the shape the registry validates', async () => {
    const w = await world();
    await w.run({ destination: 'email', botId: null });
    expect(w.events).toHaveLength(1);
    const parsed = GuardrailsDlpDecidedEvent.parse(w.events[0]);
    expect(parsed).toMatchObject({ destination: 'email', preset: 'standard', outcome: 'redact', rules: ['api-key'], botId: null });
    expect(JSON.stringify(w.events[0])).not.toContain(KEY);
  });

  it('stays quiet when the caller records its own decision (the LLM gateway does)', async () => {
    const w = await world();
    await w.run({ destination: 'llm', recorded: true });
    expect(w.events).toEqual([]);
  });

  it('is linear on hostile input through the whole chain', async () => {
    const w = await world();
    const hostile = ['-'.repeat(100_000), 'sk-' + 'a'.repeat(100_000), '-----BEGIN PRIVATE KEY-----'.repeat(3_000), ('4111 ' + '1'.repeat(40) + ' ').repeat(2_000)];
    const started = performance.now();
    for (const text of hostile) await w.run({ text, recorded: true });
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});
