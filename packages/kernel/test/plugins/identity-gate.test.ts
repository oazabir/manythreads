import { definePlugin } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { ExtensionRegistries, createMemoryKv, createPluginContext } from '../../src/plugins/index.ts';

const base = { registries: new ExtensionRegistries(), storage: createMemoryKv(), mail: { send: () => Promise.resolve() }, runtime: { publicUrl: 'http://x', now: () => new Date() } };
const identity = { runAsSystem: () => Promise.reject(new Error('unused')) } as never;

describe('ctx.identity', () => {
  it('throws for a plugin that does not extend provider.identity', () => {
    const { manifest } = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    const ctx = createPluginContext(manifest, { ...base, identity });
    expect(() => ctx.identity).toThrow(/provider\.identity/);
  });

  it('is available to a plugin that extends provider.identity, and throws when the host wired none', () => {
    const { manifest } = definePlugin({ manifest: { name: 'signin', version: '0.1.0', kind: 'server', extends: ['provider.identity'] }, register: () => undefined });
    expect(createPluginContext(manifest, { ...base, identity }).identity).toBe(identity);
    expect(() => createPluginContext(manifest, base).identity).toThrow(/no identity services/);
  });

  it('mail and runtime are available to every plugin', () => {
    const { manifest } = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    const ctx = createPluginContext(manifest, base);
    expect(ctx.runtime.publicUrl).toBe('http://x');
    expect(typeof ctx.mail.send).toBe('function');
  });
});
