import { z } from 'zod';

/** Every extension point of SPEC-FINAL §3. A plugin may only use the ones its manifest lists in `extends`. */
export const EXTENSION_POINTS = [
  'event.subscribe',
  'event.emit',
  'surface.nav',
  'surface.screen',
  'surface.card',
  'surface.panel',
  'composer.action',
  'settings.page',
  'hook.pre_persist',
  'hook.pre_egress',
  'provider.identity',
  'provider.memory',
  'provider.bot_runtime',
  'provider.storage',
  'provider.llm',
  'provider.knowledge',
  'provider.viewer',
  'provider.repo',
  'command.register',
  'trigger.register',
  'component.register',
  // Not in SPEC-FINAL section 3: a plugin that runs background work declares it, like a sign-in plugin declares provider.identity,
  // because job handlers run as the system actor (P3-00; docs/plugins/README.md "Background jobs").
  'job.register',
] as const;

export const ExtensionPoint = z.enum(EXTENSION_POINTS);
export type ExtensionPoint = z.infer<typeof ExtensionPoint>;

export const PluginKind = z.enum(['server', 'client', 'server+client']);
export type PluginKind = z.infer<typeof PluginKind>;

/** Plugin name: also its migration namespace and its `scoped_kv.plugin` value. */
export const PluginName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must be lowercase letters, digits and dashes, starting with a letter');

/** `namespace.verb`, e.g. `tasks.claim`. */
export const CapabilityName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'must be namespace.verb in lowercase, e.g. tasks.claim');
export type CapabilityName = z.infer<typeof CapabilityName>;

export const CapabilityDeclaration = z.strictObject({
  name: CapabilityName,
  destructive: z.boolean(),
});
export type CapabilityDeclaration = z.infer<typeof CapabilityDeclaration>;

/** `domain.noun.verb` (three or more lowercase segments). */
export const PluginEventName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/, 'must be domain.noun.verb, e.g. channel.message.posted');

/** The plugin manifest (guide §6.1). */
export const PluginManifest = z.strictObject({
  name: PluginName,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be a semantic version, e.g. 1.0.0'),
  kind: PluginKind,
  extends: z.array(ExtensionPoint).default([]),
  capabilities: z.array(CapabilityDeclaration).default([]),
  events: z
    .strictObject({
      emits: z.array(PluginEventName).default([]),
      consumes: z.array(PluginEventName).default([]),
    })
    .default({ emits: [], consumes: [] }),
  dependsOn: z.array(PluginName).default([]),
  /** Directory of numbered `.sql` files, relative to the plugin package. Omit when the plugin has no tables. */
  migrations: z.string().min(1).optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;
