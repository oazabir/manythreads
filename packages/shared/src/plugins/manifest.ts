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
  // The one handler for `needsApproval` (P5-20): other plugins ask it for an approval instead of writing the rows themselves.
  'provider.approvals',
  // The one path a channel message is written on (P5-18): a plugin that finishes a bot's reply with more than text (the Answer) posts through it,
  // so the permission, thread rules, events, push, unread counters and mentions are the ones every message gets. Registered by `channels`.
  'provider.messages',
  // The connected runners of a team and the one way to send a job to one (P6-06): registered by the runners plugin, used by runtime-hermes.
  'provider.runner',
  // The managed Hermes pod's profile specs and its change notice (runtime-hermes): what a pod controller reads to keep the pod in step with the team's bots.
  'provider.hermes.profiles',
  'provider.project.credentials',
  // A team's role tags as mention groups (P14-03): registered by the teams plugin, read by channels (mentions, the picker) and tasks (handover.toPerson).
  'provider.role.groups',
  // The digest of what a bot's MCP `tools/list` answers (gateway-mcp, P14-22): read by runtime-hermes to write the managed pod's `# manythreads tools:` line.
  'provider.mcp.tools',
  // When a person was last seen (presence, P14-09): read by notifications to know who has been away long enough for an email digest, so it never reads the heartbeat table.
  'provider.presence',
  // Where a bot's run goes, by runner name (bot-runners, P19-02): read by runtime-hermes so that a runner's address and key are resolved in one place only.
  'provider.bot.runners',
  // The machines (nodes) of the cluster and where the team Hermes pods stand on them (hermes-pods, P19-08): read by bot-runners for the admin's node picker.
  'provider.runner.nodes',
  // Turns one inbox item's text into proposed memory concepts (the Archivist, P8-18): read by memory-inbox, which has a plain fallback while no plugin provides it.
  'provider.inbox.distiller',
  // One step of the bot page's Deploy action (P8-34): the owner of a step (proposals: the definition, knowledge: the bases, connections: the connections) registers it; the workshop plugin composes the action.
  'provider.deploy.step',
  // Seal a small secret in the platform's encrypted store (`ctx.secrets`) without being a sign-in, model or Hermes-profile provider: the tasks plugin's private note on a handover.
  'secret.seal',
  'command.register',
  'trigger.register',
  'component.register',
  // Not in SPEC-FINAL section 3: a plugin that runs background work declares it, like a sign-in plugin declares provider.identity,
  // because job handlers run as the system actor (P3-00; docs/plugins/README.md "Background jobs").
  'job.register',
  // Also not in section 3: the MCP gateway's door (P5-09). A plugin that declares it may open a bot run, enter one
  // transaction as the run's bot (or as the person who asked) and call the capability handler another plugin
  // registered — the only way a tool call carries `app.run_id`, which `run_source_log` insists on. Trusted-code
  // territory like `provider.identity`; see docs/plugins/security.md.
  'tool.invoke',
  // Also not in section 3: the right to make the one call a person approved (`ctx.runs.asApproved`, P5-20), which waives `needsApproval` for exactly
  // that capability. Only the approvals plugin declares it; docs/plugins/security.md.
  'approval.resume',
  // Also not in section 3: the right to END a bot run through the run service (`ctx.runs.close`) and nothing else of `ctx.runs` — no opening a run,
  // no entering one as its bot. For janitors (the bots plugin's stale-run reaper); the full run door is `tool.invoke`. docs/plugins/security.md.
  'run.close',
  // Also not in section 3: the right to resolve a presented run token to its run (`ctx.runs.resolve`) and nothing else of `ctx.runs`. For an endpoint that takes the
  // run's token as its credential without acting for the run (the run-scoped model proxy of gateway-llm, P6-06); the full run door is `tool.invoke`.
  'run.resolve',
  // Also not in section 3: the right to call a capability handler another plugin registered (`ctx.runs.invoke`) in a transaction the caller already holds, and to list the
  // capabilities that have one (`ctx.runs.catalog`) — and nothing else of `ctx.runs`. It adds no actor: the handler runs as whoever the caller's transaction is. For a plugin
  // that does one person's work through the platform's own tools (the "Add a bot" helper, P7-02); the full run door is `tool.invoke`. docs/plugins/security.md.
  'capability.call',
  // Also not in section 3: the right to offer tools to bots from a source of the plugin's own (`ctx.toolSources.register`, PLAN P8-01): a connection to an outside
  // service is the first. The gateway lists the source's tools for a bot that has a grant for them and hands the call to the source after the broker allowed it.
  // Every tool the source offers must be a capability the same manifest declares, so the broker knows its name and its destructive tag. Trusted code like
  // `provider.identity`: the source receives the run's own transaction and nothing wider. docs/plugins/security.md.
  'tool.source',
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
  /**
   * The capabilities a plugin that extends `capability.call` may call through `ctx.runs.invoke`, by name. The kernel refuses any other name, so the narrow door is as wide as this list and no wider.
   * Present exactly when `capability.call` is in `extends`.
   */
  calls: z.array(CapabilityName).default([]),
}).superRefine((m, ctx) => {
  const callDoor = m.extends.includes('capability.call');
  if (callDoor && m.calls.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['calls'], message: 'a plugin that extends "capability.call" must name the capabilities it may call in "calls"' });
  }
  if (!callDoor && m.calls.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['extends'], message: '"calls" is only for a plugin that extends "capability.call"' });
  }
  // each narrow door of ctx.runs is its own; one plugin takes at most one, and tool.invoke is the whole of them
  if (callDoor) {
    for (const other of ['run.close', 'run.resolve', 'tool.invoke'] as const) {
      if (m.extends.includes(other)) {
        ctx.addIssue({ code: 'custom', path: ['extends'], message: `"capability.call" cannot be combined with "${other}": each of them opens a different part of ctx.runs` });
      }
    }
  }
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;
