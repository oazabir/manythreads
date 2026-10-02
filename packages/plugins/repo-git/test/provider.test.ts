import { loadPlugins } from '@manythreads/kernel';
import { definePlugin, type RepoProvider } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import repoGit from '../src/index.ts';

// Another plugin reaches the writer through the `repo` provider, and the capabilities repo-git declares are the names the broker's path guard knows.

describe('the repo provider', () => {
  it('is registered by repo-git and found by a plugin that loads before it', async () => {
    const reader = definePlugin({
      manifest: { name: 'repo-reader', version: '0.1.0', kind: 'server', extends: [], events: { emits: [], consumes: [] } },
      register() {
        // not in `register`: the provider's plugin may load later
      },
    });
    const host = await loadPlugins({ plugins: [{ definition: reader }, { definition: repoGit }] });
    const found = host.registries.providers.repo.values()[0] as RepoProvider | undefined;
    expect(found?.id).toBe('repo-git');
    expect(Object.keys(found ?? {}).sort()).toEqual(['blob', 'id', 'list', 'restore', 'tree', 'write']);
    expect(host.plugins.map((p) => p.manifest.name)).toContain('repo-git');
    expect(host.capabilities.get('files.write')).toMatchObject({ destructive: false, plugin: 'repo-git' });
    expect(host.capabilities.get('files.delete')).toMatchObject({ destructive: true, plugin: 'repo-git' });
    // a destructive capability can never be granted to a bot
    expect(() => host.capabilities.assertGrantable(['files.delete'])).toThrow(/destructive/);
    expect(() => host.capabilities.assertGrantable(['files.write'])).not.toThrow();
  });

  it('a plugin that does not extend provider.repo cannot register one', async () => {
    const rogue = definePlugin({
      manifest: { name: 'rogue', version: '0.1.0', kind: 'server', extends: [], events: { emits: [], consumes: [] } },
      register(ctx) {
        ctx.providers.register('repo', { id: 'rogue' });
      },
    });
    await expect(loadPlugins({ plugins: [{ definition: rogue }] })).rejects.toThrow(/provider\.repo/);
  });

  it('ctx.capabilities.authorize fails closed when the host has no broker', async () => {
    let result: unknown;
    const asker = definePlugin({
      manifest: { name: 'asker', version: '0.1.0', kind: 'server', extends: [], events: { emits: [], consumes: [] } },
      register(ctx) {
        result = ctx.capabilities.authorize({ actor: { kind: 'bot', id: 'x', workspaceId: 'y' }, query: () => Promise.reject(new Error('unused')) }, 'files.write', { path: 'pages/x.md' });
      },
    });
    await loadPlugins({ plugins: [{ definition: asker }] });
    await expect(result).rejects.toThrow(/no capability broker/);
  });
});
