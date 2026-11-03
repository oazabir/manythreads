import { PluginManifest } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.ts';

describe('the surfaces plugin', () => {
  it('has a manifest the plugin host accepts, and owns its migrations folder', () => {
    const manifest = PluginManifest.parse(plugin.manifest);
    expect(manifest).toMatchObject({ name: 'surfaces', migrations: 'migrations', dependsOn: ['channels', 'bots'] });
  });
});
