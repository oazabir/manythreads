import { randomUUID } from 'node:crypto';
import { definePlugin, type EgressHook, type EgressInput, type PluginContext, type PluginDefinition, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { loadPlugins, type PluginSource } from '../../src/index.ts';

// P5-21: the `pre_egress` chain. Hooks run in load order on the text the hooks before them left; the strongest outcome wins; a block ends
// the chain; a hook that throws blocks (a guard that failed is not a guard that allowed). No database: the hooks here are plain functions.

type Manifest = Parameters<typeof definePlugin>[0]['manifest'];
const plugin = (name: string, extra: Partial<Manifest>, register: PluginDefinition['register']): PluginSource => ({
  definition: definePlugin({ manifest: { name, version: '1.0.0', kind: 'server', ...extra }, register }),
});

const tx = { actor: { kind: 'system', id: randomUUID(), workspaceId: randomUUID() }, query: () => Promise.reject(new Error('no db')) } as unknown as PluginTx;
const input = (over: Partial<EgressInput> = {}): EgressInput => ({ destination: 'channel', workspaceId: tx.actor.workspaceId, text: 'hello', preset: 'standard', ...over });

/** A host with one guard plugin per hook (in the order given) and a caller plugin that declares `hook.pre_egress`. */
async function chain(hooks: EgressHook[]): Promise<PluginContext> {
  let caller: PluginContext | undefined;
  await loadPlugins({
    plugins: [
      ...hooks.map((hook, i) => plugin(`guard-${i}`, { extends: ['hook.pre_egress'] }, (ctx) => ctx.hooks.preEgress(hook))),
      plugin('caller', { extends: ['hook.pre_egress'], dependsOn: hooks.map((_, i) => `guard-${i}`) }, (ctx) => void (caller = ctx)),
    ],
  });
  return caller as PluginContext;
}

describe('ctx.hooks.runPreEgress', () => {
  it('with no hook allows and says nothing guarded it (hooks: 0), so a caller that must be guarded can refuse', async () => {
    const ctx = await chain([]);
    expect(await ctx.hooks.runPreEgress(tx, input())).toEqual({ outcome: 'allow', text: 'hello', rules: [], reason: null, message: null, hooks: 0 });
  });

  it('a hook that has no objection returns nothing; the text is unchanged', async () => {
    const ctx = await chain([() => undefined, () => ({ outcome: 'allow' })]);
    expect(await ctx.hooks.runPreEgress(tx, input())).toMatchObject({ outcome: 'allow', text: 'hello', hooks: 2 });
  });

  it('threads redacted text from one hook to the next and collects each rule once', async () => {
    const seen: string[] = [];
    const ctx = await chain([
      (i) => {
        seen.push(i.text);
        return { outcome: 'redact', text: i.text.replace('hello', '[redacted:greeting]'), rules: ['greeting'] };
      },
      (i) => {
        seen.push(i.text);
        return { outcome: 'redact', text: `${i.text}!`, rules: ['greeting', 'bang'] };
      },
    ]);
    const decision = await ctx.hooks.runPreEgress(tx, input({ text: 'hello world' }));
    expect(seen).toEqual(['hello world', '[redacted:greeting] world']);
    expect(decision).toMatchObject({ outcome: 'redact', text: '[redacted:greeting] world!', rules: ['greeting', 'bang'], hooks: 2 });
  });

  it('the strongest outcome wins whatever the order, and a later weaker hook cannot lower it', async () => {
    const ctx = await chain([
      () => ({ outcome: 'require_approval', reason: 'dlp', text: 'held', rules: ['api-key'], message: 'ask a person' }),
      () => ({ outcome: 'redact', text: 'later', rules: ['x'] }),
      () => ({ outcome: 'allow' }),
    ]);
    const decision = await ctx.hooks.runPreEgress(tx, input());
    expect(decision).toMatchObject({ outcome: 'require_approval', reason: 'dlp', message: 'ask a person', hooks: 3 });
  });

  it('a block ends the chain, keeps the original text and names why; hooks after it never see the input', async () => {
    let reached = false;
    const ctx = await chain([
      (i) => ({ outcome: 'redact', text: i.text.toUpperCase(), rules: ['shout'] }),
      () => ({ outcome: 'block', reason: 'preset', message: 'not there' }),
      () => {
        reached = true;
      },
    ]);
    const decision = await ctx.hooks.runPreEgress(tx, input());
    expect(decision).toMatchObject({ outcome: 'block', text: 'hello', reason: 'preset', message: 'not there', rules: ['shout'], hooks: 2 });
    expect(reached).toBe(false);
  });

  it('a hook that throws blocks, and its message (which may quote the text) is not passed on', async () => {
    const ctx = await chain([
      () => {
        throw new Error('could not parse: sk-secret-value');
      },
    ]);
    const decision = await ctx.hooks.runPreEgress(tx, input({ text: 'sk-secret-value' }));
    expect(decision).toMatchObject({ outcome: 'block', reason: 'error', text: 'sk-secret-value' });
    expect(decision.message).toBe('The guard-0 guardrail failed, so the channel call was refused.');
    expect(JSON.stringify(decision)).not.toContain('could not parse');
  });

  it('is an extension point like the others: the caller must declare hook.pre_egress', async () => {
    let bare: PluginContext | undefined;
    await loadPlugins({ plugins: [plugin('bare', {}, (ctx) => void (bare = ctx))] });
    await expect(bare!.hooks.runPreEgress(tx, input())).rejects.toThrow(/hook\.pre_egress/);
  });

  it('hooks get the guarded transaction: session-changing SQL is refused', async () => {
    const queries: string[] = [];
    const real = { ...tx, query: (text: string) => (queries.push(text), Promise.resolve({ rows: [] })) } as unknown as PluginTx;
    const ctx = await chain([
      async (_i, t) => {
        await t.query('SELECT 1');
        await t.query("SELECT set_config('app.actor_id', 'x', true)");
      },
    ]);
    const decision = await ctx.hooks.runPreEgress(real, input());
    expect(queries).toEqual(['SELECT 1']);
    expect(decision).toMatchObject({ outcome: 'block', reason: 'error' }); // the refused statement threw inside the hook: failed closed
  });
});
