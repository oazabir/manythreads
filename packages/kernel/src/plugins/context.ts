import type {
  CapabilityHandler,
  EmitEvent,
  PluginContext,
  PluginEvent,
  PluginTx,
  ScopedKv,
  StorageScope,
} from '@majlis/sdk';
import type { ExtensionPoint, PluginManifest } from '@majlis/shared';
import { PluginError } from './errors.ts';
import type { ExtensionRegistries } from './registries.ts';

export interface ContextDeps {
  registries: ExtensionRegistries;
  emit?: EmitEvent;
  storage: ScopedKv;
}

/** The `ctx` handed to `register`. Using an extension point the manifest did not declare throws. */
export function createPluginContext(manifest: PluginManifest, deps: ContextDeps): PluginContext {
  const { registries } = deps;
  const name = manifest.name;
  const declared = new Set<ExtensionPoint>(manifest.extends);

  const use = (point: ExtensionPoint): void => {
    if (!declared.has(point)) {
      throw new PluginError(
        `Plugin "${name}" used extension point "${point}" but its manifest does not list it in "extends"`,
        { plugin: name },
      );
    }
  };

  const mount = (path: string): string => {
    if (!path.startsWith('/')) throw new PluginError(`Plugin "${name}": http route path "${path}" must start with "/"`, { plugin: name });
    return `/plugins/${name}${path}`;
  };

  return {
    manifest,
    events: {
      subscribe(type, handler) {
        use('event.subscribe');
        if (!manifest.events.consumes.includes(type)) {
          throw new PluginError(
            `Plugin "${name}" subscribed to "${type}" but its manifest does not list it in events.consumes`,
            { plugin: name },
          );
        }
        registries.eventSubscriptions.add(name, { type, handler });
      },
      async emit(tx: PluginTx, event: PluginEvent) {
        use('event.emit');
        if (!manifest.events.emits.includes(event.type)) {
          throw new PluginError(
            `Plugin "${name}" emitted "${event.type}" but its manifest does not list it in events.emits`,
            { plugin: name },
          );
        }
        if (!deps.emit) throw new PluginError(`Plugin "${name}": no event emitter is wired into the host`, { plugin: name });
        await deps.emit(tx, event);
      },
    },
    hooks: {
      prePersist(hook) {
        use('hook.pre_persist');
        registries.prePersist.add(name, hook);
      },
      preEgress(hook) {
        use('hook.pre_egress');
        registries.preEgress.add(name, hook);
      },
    },
    providers: {
      register(kind, impl) {
        use(`provider.${kind}`);
        registries.providers[kind].add(name, impl);
      },
    },
    commands: {
      register(definition) {
        use('command.register');
        registries.commands.add(name, definition);
      },
    },
    triggers: {
      register(definition) {
        use('trigger.register');
        registries.triggers.add(name, definition);
      },
    },
    components: {
      register(definition) {
        use('component.register');
        registries.components.add(name, definition);
      },
    },
    surfaces: {
      nav(definition) {
        use('surface.nav');
        registries.nav.add(name, definition);
      },
      screen(definition) {
        use('surface.screen');
        registries.screens.add(name, definition);
      },
      card(definition) {
        use('surface.card');
        registries.cards.add(name, definition);
      },
      panel(definition) {
        use('surface.panel');
        registries.panels.add(name, definition);
      },
    },
    settings: {
      page(definition) {
        use('settings.page');
        registries.settingsPages.add(name, definition);
      },
    },
    composer: {
      action(definition) {
        use('composer.action');
        registries.composerActions.add(name, definition);
      },
    },
    capabilities: {
      register(capability: string, handler: CapabilityHandler) {
        if (!manifest.capabilities.some((c) => c.name === capability)) {
          throw new PluginError(
            `Plugin "${name}" registered capability "${capability}" but its manifest does not declare it`,
            { plugin: name },
          );
        }
        registries.capabilityHandlers.set(capability, { plugin: name, handler });
      },
    },
    http: {
      route(definition) {
        registries.httpRoutes.add(name, { ...definition, fullPath: mount(definition.path) });
      },
    },
    storage: deps.storage,
  };
}

const kvKey = (scope: StorageScope, key: string): string => `${scope.type}:${scope.id}:${key}`;

/** In-memory scoped storage; the server swaps in the `app.scoped_kv` implementation (P1-09). */
export function createMemoryKv(): ScopedKv {
  const data = new Map<string, unknown>();
  return {
    get: (scope, key) => Promise.resolve(data.get(kvKey(scope, key))),
    set: (scope, key, value) => {
      data.set(kvKey(scope, key), value);
      return Promise.resolve();
    },
    delete: (scope, key) => Promise.resolve(data.delete(kvKey(scope, key))),
  };
}
