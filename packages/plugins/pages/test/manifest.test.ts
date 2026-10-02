import { loadPlugins } from '@manythreads/kernel';
import { describe, expect, it } from 'vitest';
import pages from '../src/index.ts';

// The capability pages declares is the name the broker's path guard knows, and a bot can be granted it (it is not destructive).

describe('the pages plugin', () => {
  it('declares pages.write, grantable to a bot, and emits only pages.page.written', async () => {
    const host = await loadPlugins({ plugins: [{ definition: pages }] });
    expect(host.plugins.map((p) => p.manifest.name)).toContain('pages');
    expect(host.capabilities.get('pages.write')).toMatchObject({ destructive: false, plugin: 'pages' });
    expect(() => host.capabilities.assertGrantable(['pages.write'])).not.toThrow();
    expect(pages.manifest.events?.emits).toEqual(['pages.page.written']);
    expect(host.registries.httpRoutes.list().map((r) => `${r.value.method} ${r.value.path}`)).toEqual(['POST /api/teams/:slug/pages/write']);
  });
});
