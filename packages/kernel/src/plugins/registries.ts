import type {
  CapabilityHandler,
  ComponentDefinition,
  ComposerActionDefinition,
  CommandDefinition,
  EventHandler,
  Hook,
  HttpRouteDefinition,
  JobHandler,
  JobOptions,
  ProviderImpl,
  ProviderKind,
  SettingsPageDefinition,
  SurfaceDefinition,
  TriggerDefinition,
} from '@manythreads/sdk';

export interface RegistryEntry<T> {
  plugin: string;
  value: T;
}

/** An in-memory, typed list of what plugins registered at one extension point, in load order. */
export class ExtensionRegistry<T> {
  private readonly items: RegistryEntry<T>[] = [];

  add(plugin: string, value: T): void {
    this.items.push({ plugin, value });
  }

  list(): readonly RegistryEntry<T>[] {
    return this.items;
  }

  values(): T[] {
    return this.items.map((e) => e.value);
  }

  byPlugin(plugin: string): T[] {
    return this.items.filter((e) => e.plugin === plugin).map((e) => e.value);
  }
}

export interface MountedRoute extends HttpRouteDefinition {
  /** The absolute API path the plugin declared (e.g. `/api/channels/:channelId/messages`). */
  fullPath: string;
}

/** One registry per extension point (SPEC-FINAL §3). */
export class ExtensionRegistries {
  readonly eventSubscriptions = new ExtensionRegistry<{ type: string; handler: EventHandler }>();
  readonly prePersist = new ExtensionRegistry<Hook>();
  readonly preEgress = new ExtensionRegistry<Hook>();
  readonly providers: Record<ProviderKind, ExtensionRegistry<ProviderImpl>> = {
    identity: new ExtensionRegistry(),
    memory: new ExtensionRegistry(),
    bot_runtime: new ExtensionRegistry(),
    storage: new ExtensionRegistry(),
    llm: new ExtensionRegistry(),
    knowledge: new ExtensionRegistry(),
    viewer: new ExtensionRegistry(),
  };
  readonly commands = new ExtensionRegistry<CommandDefinition>();
  readonly triggers = new ExtensionRegistry<TriggerDefinition>();
  readonly components = new ExtensionRegistry<ComponentDefinition>();
  readonly nav = new ExtensionRegistry<SurfaceDefinition>();
  readonly screens = new ExtensionRegistry<SurfaceDefinition>();
  readonly cards = new ExtensionRegistry<SurfaceDefinition>();
  readonly panels = new ExtensionRegistry<SurfaceDefinition>();
  readonly settingsPages = new ExtensionRegistry<SettingsPageDefinition>();
  readonly composerActions = new ExtensionRegistry<ComposerActionDefinition>();
  /** Queue handlers of plugins that extend `job.register`; the server starts one worker per entry. */
  readonly jobs = new ExtensionRegistry<{ queue: string; handler: JobHandler; options: JobOptions }>();
  /** Not an extension point: plugins may always offer routes; the server mounts them later. */
  readonly httpRoutes = new ExtensionRegistry<MountedRoute>();
  /** Implementations bound to declared capability names, by capability name. */
  readonly capabilityHandlers = new Map<string, { plugin: string; handler: CapabilityHandler }>();
}
