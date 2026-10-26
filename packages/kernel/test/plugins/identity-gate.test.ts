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

  it('ctx.secrets is available to a provider.llm plugin too, and closed to everyone else', () => {
    const secrets = { put: () => Promise.resolve('id'), get: () => Promise.resolve('s'), delete: () => Promise.resolve(true) };
    const llm = definePlugin({ manifest: { name: 'gateway', version: '0.1.0', kind: 'server', extends: ['provider.llm'] }, register: () => undefined });
    expect(createPluginContext(llm.manifest, { ...base, secrets }).secrets).toBe(secrets);
    const plain = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    expect(() => createPluginContext(plain.manifest, { ...base, secrets }).secrets).toThrow(/ctx\.secrets/);
  });

  it('ctx.secrets opens for secret.seal alone, and a plugin that declares nothing stays out', () => {
    const secrets = { put: () => Promise.resolve('id'), get: () => Promise.resolve('s'), delete: () => Promise.resolve(true) };
    const sealer = definePlugin({ manifest: { name: 'sealer', version: '0.1.0', kind: 'server', extends: ['secret.seal'] }, register: () => undefined });
    expect(createPluginContext(sealer.manifest, { ...base, secrets }).secrets).toBe(secrets);
    const plain = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    expect(() => createPluginContext(plain.manifest, { ...base, secrets }).secrets).toThrow(/secret\.seal/);
  });

  it('mail and runtime are available to every plugin', () => {
    const { manifest } = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    const ctx = createPluginContext(manifest, base);
    expect(ctx.runtime.publicUrl).toBe('http://x');
    expect(typeof ctx.mail.send).toBe('function');
  });

  it('ctx.runs.asApproved is a door of its own: tool.invoke alone does not open it, approval.resume does', async () => {
    const calls: string[] = [];
    const runs = {
      asBot: (_run: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
      asApproved: (_run: unknown, capability: string, fn: (tx: unknown) => Promise<unknown>) => {
        calls.push(capability);
        return fn({});
      },
    } as never;
    const gateway = definePlugin({ manifest: { name: 'gateway', version: '0.1.0', kind: 'server', extends: ['tool.invoke'] }, register: () => undefined });
    const ctx = createPluginContext(gateway.manifest, { ...base, runs });
    // the rest of the run door works for it ...
    await expect(ctx.runs.asBot({} as never, () => Promise.resolve('ok'))).resolves.toBe('ok');
    // ... but making the one call a person approved (which waives needsApproval) is refused
    await expect(ctx.runs.asApproved({} as never, 'pages.write', () => Promise.resolve('no'))).rejects.toThrow(/approval\.resume/);
    expect(calls).toEqual([]);

    const approvals = definePlugin({ manifest: { name: 'approvals', version: '0.1.0', kind: 'server', extends: ['tool.invoke', 'approval.resume'] }, register: () => undefined });
    const door = createPluginContext(approvals.manifest, { ...base, runs });
    await expect(door.runs.asApproved({} as never, 'pages.write', () => Promise.resolve('yes'))).resolves.toBe('yes');
    expect(calls).toEqual(['pages.write']);
  });

  it('run.close is a door of its own: close works, every other member of ctx.runs is refused, and a plugin with neither has no ctx.runs', async () => {
    const closed: Array<[string, string]> = [];
    const runs = {
      close: (runId: string, status: string) => {
        closed.push([runId, status]);
        return Promise.resolve(true);
      },
      open: () => Promise.reject(new Error('the real open must not be reached')),
      asBot: () => Promise.reject(new Error('the real asBot must not be reached')),
    } as never;
    const reaper = definePlugin({ manifest: { name: 'reaper', version: '0.1.0', kind: 'server', extends: ['run.close'] }, register: () => undefined });
    const ctx = createPluginContext(reaper.manifest, { ...base, runs });
    await expect(ctx.runs.close('run-1', 'failed')).resolves.toBe(true);
    expect(closed).toEqual([['run-1', 'failed']]);
    for (const member of ['open', 'asBot', 'asReader', 'asApproved', 'authorize', 'may', 'invoke', 'logSource', 'inheritSources'] as const) {
      expect(() => (ctx.runs[member] as unknown as () => unknown)(), member).toThrow(/run\.close.*tool\.invoke/);
    }
    const plain = definePlugin({ manifest: { name: 'plain', version: '0.1.0', kind: 'server' }, register: () => undefined });
    expect(() => createPluginContext(plain.manifest, { ...base, runs }).runs).toThrow(/tool\.invoke/);
    // the full door still has everything (tool.invoke wins over run.close)
    const both = definePlugin({ manifest: { name: 'both', version: '0.1.0', kind: 'server', extends: ['tool.invoke', 'run.close'] }, register: () => undefined });
    await expect(createPluginContext(both.manifest, { ...base, runs }).runs.asBot({} as never, () => Promise.resolve('x'))).rejects.toThrow(/real asBot/);
  });

  it('run.resolve is a door of its own: resolve works (a token to its run), close and every other member of ctx.runs is refused', async () => {
    const seen: string[] = [];
    const runs = {
      resolve: (hash: Buffer) => {
        seen.push(hash.toString('hex'));
        return Promise.resolve({ runId: 'run-1' });
      },
      close: () => Promise.reject(new Error('the real close must not be reached')),
      open: () => Promise.reject(new Error('the real open must not be reached')),
    } as never;
    const proxy = definePlugin({ manifest: { name: 'proxy', version: '0.1.0', kind: 'server', extends: ['run.resolve'] }, register: () => undefined });
    const ctx = createPluginContext(proxy.manifest, { ...base, runs });
    await expect(ctx.runs.resolve(Buffer.from('ab', 'hex'))).resolves.toEqual({ runId: 'run-1' });
    expect(seen).toEqual(['ab']);
    for (const member of ['close', 'open', 'asBot', 'asReader', 'asApproved', 'authorize', 'may', 'invoke', 'logSource', 'inheritSources'] as const) {
      expect(() => (ctx.runs[member] as unknown as () => unknown)(), member).toThrow(/run\.resolve.*tool\.invoke/);
    }
  });
});
