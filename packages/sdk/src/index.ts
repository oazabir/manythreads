import { PluginManifest, type PluginManifestInput } from '@majlis/shared';
import type { PluginContext, PluginDefinition } from './types.ts';

export * from './types.ts';

/**
 * Declare a plugin. The manifest is validated immediately (a bad field throws a ZodError naming it), so a
 * plugin module that imports fine has a valid manifest.
 */
export function definePlugin(input: {
  manifest: PluginManifestInput;
  register(ctx: PluginContext): void | Promise<void>;
}): PluginDefinition {
  return { manifest: PluginManifest.parse(input.manifest), register: input.register };
}
