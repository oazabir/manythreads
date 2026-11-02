import { definePlugin, type PluginDefinition, type ToolSource } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { loadPlugins, type PluginSource } from '../../src/index.ts';

// The tool source seam (PLAN P8-01): what the kernel refuses when a plugin registers a source of tools, and who may look at the sources. No database: registration
// is a matter of the manifest.

const source = (id: string, tools: string[], overrides: Partial<ToolSource> = {}): ToolSource => ({
  id,
  tools: tools.map((name) => ({ name, description: `${name} does something`, inputSchema: { type: 'object' }, kind: 'read' as const })),
  offered: () => Promise.resolve(tools),
  call: () => Promise.resolve({ ok: true }),
  ...overrides,
});

const fake = (
  name: string,
  extra: Partial<Parameters<typeof definePlugin>[0]['manifest']> = {},
  register: PluginDefinition['register'] = () => undefined,
): PluginSource => ({ definition: definePlugin({ manifest: { name, version: '1.0.0', kind: 'server', ...extra }, register }) });

const owner = (tools: string[], register: PluginDefinition['register']): PluginSource =>
  fake('owner', { extends: ['tool.source'], capabilities: tools.map((name) => ({ name, destructive: false })) }, register);

describe('ctx.toolSources', () => {
  it('registering a source needs "tool.source" in the manifest', async () => {
    await expect(
      loadPlugins({ plugins: [fake('p', { capabilities: [{ name: 'p.read', destructive: false }] }, (ctx) => ctx.toolSources.register(source('s', ['p.read'])))] }),
    ).rejects.toThrow(/Plugin "p".*"tool\.source".*extends/s);
  });

  it('a registered source is found by tool name, by a plugin that extends "tool.invoke" and only by one', async () => {
    const host = await loadPlugins({
      plugins: [
        owner(['owner.read'], (ctx) => ctx.toolSources.register(source('s', ['owner.read']))),
        fake('gate', { extends: ['tool.invoke'] }, (ctx) => {
          expect(ctx.toolSources.list().map((s) => s.id)).toEqual(['s']);
          expect(ctx.toolSources.find('owner.read')?.source.id).toBe('s');
          expect(ctx.toolSources.find('owner.read')?.tool.name).toBe('owner.read');
          expect(ctx.toolSources.find('nothing.here')).toBeUndefined();
        }),
      ],
    });
    expect(host.registries.toolSources.values().map((s) => s.id)).toEqual(['s']);
    await expect(loadPlugins({ plugins: [owner(['owner.read'], (ctx) => ctx.toolSources.register(source('s', ['owner.read']))), fake('nosy', {}, (ctx) => void ctx.toolSources.list())] })).rejects.toThrow(
      /Plugin "nosy".*"tool\.invoke"/s,
    );
    await expect(loadPlugins({ plugins: [fake('nosy', {}, (ctx) => void ctx.toolSources.find('x.y'))] })).rejects.toThrow(/Plugin "nosy".*"tool\.invoke"/s);
  });

  it('a looking plugin gets a view without "call": the real call stays in the kernel registry', async () => {
    const seen: unknown[] = [];
    const host = await loadPlugins({
      plugins: [
        owner(['owner.read'], (ctx) => ctx.toolSources.register(source('s', ['owner.read']))),
        fake('gate', { extends: ['tool.invoke'] }, (ctx) => {
          seen.push(ctx.toolSources.list()[0], ctx.toolSources.find('owner.read')?.source);
        }),
      ],
    });
    expect(seen).toHaveLength(2);
    for (const view of seen as Record<string, unknown>[]) {
      expect(Object.keys(view).sort()).toEqual(['id', 'offered', 'tools']);
      expect(view.call).toBeUndefined();
      expect('call' in view).toBe(false);
      expect(Object.isFrozen(view)).toBe(true);
      expect(() => Object.assign(view, { call: () => 'stolen' })).toThrow();
      expect(view.call).toBeUndefined();
    }
    // the run service reads the registry, which still holds the call
    expect(typeof host.registries.toolSources.values()[0]?.call).toBe('function');
  });

  it('refuses a tool the manifest does not declare as a capability (the broker would not know its name or whether it is destructive)', async () => {
    await expect(loadPlugins({ plugins: [owner(['owner.read'], (ctx) => ctx.toolSources.register(source('s', ['owner.read', 'owner.sneaky'])))] })).rejects.toThrow(
      /tool source "s".*owner\.sneaky.*not declared/s,
    );
  });

  it('refuses a bad id, no tools, a bad tool name, a duplicate tool and a kind that is neither read nor write', async () => {
    const bad = (s: ToolSource, message: RegExp) => expect(loadPlugins({ plugins: [owner(['owner.read'], (ctx) => ctx.toolSources.register(s))] })).rejects.toThrow(message);
    await bad(source('Bad Id', ['owner.read']), /the id must be/);
    await bad(source('s', []), /at least one tool/);
    await bad(source('s', ['OWNER']), /namespace\.verb/);
    await bad(source('s', ['owner.read', 'owner.read']), /listed twice/);
    await bad({ ...source('s', ['owner.read']), tools: [{ name: 'owner.read', description: 'd', inputSchema: {}, kind: 'stub' as never }] }, /read or a write/);
  });

  it('refuses a second source with the same id, and a tool another source or a capability handler already owns (in either order)', async () => {
    const two = (register: PluginDefinition['register']) =>
      loadPlugins({
        plugins: [fake('owner', { extends: ['tool.source'], capabilities: [{ name: 'owner.read', destructive: false }, { name: 'owner.write', destructive: false }] }, register)],
      });
    await expect(two((ctx) => (ctx.toolSources.register(source('s', ['owner.read'])), ctx.toolSources.register(source('s', ['owner.write']))))).rejects.toThrow(/already registered/);
    await expect(two((ctx) => (ctx.toolSources.register(source('a', ['owner.read'])), ctx.toolSources.register(source('b', ['owner.read']))))).rejects.toThrow(/already offered by the source "a"/);
    // a handler registered first, then a source for the same tool
    await expect(two((ctx) => (ctx.capabilities.register('owner.read', () => undefined), ctx.toolSources.register(source('s', ['owner.read']))))).rejects.toThrow(/already has a capability handler/);
    // a source first, then a handler for the same tool
    await expect(two((ctx) => (ctx.toolSources.register(source('s', ['owner.read'])), ctx.capabilities.register('owner.read', () => undefined)))).rejects.toThrow(/registered a handler for "owner.read", which the tool source "s"/);
  });

  it('keeps its own copy: adding a tool to the list afterwards does not add it', async () => {
    const tools = source('s', ['owner.read']);
    const host = await loadPlugins({
      plugins: [
        fake('owner', { extends: ['tool.source'], capabilities: [{ name: 'owner.read', destructive: false }] }, (ctx) => {
          ctx.toolSources.register(tools);
          (tools.tools as unknown as unknown[]).push({ name: 'owner.sneaky', description: 'd', inputSchema: {}, kind: 'write' });
        }),
      ],
    });
    expect(host.registries.toolSources.values()[0]?.tools.map((t) => t.name)).toEqual(['owner.read']);
    expect(Object.isFrozen(host.registries.toolSources.values()[0])).toBe(true);
  });
});
