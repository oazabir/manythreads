import { guardPluginTx } from '@manythreads/sdk';
import type {
  AuditEvent,
  CapabilityHandler,
  EmitEvent,
  EnqueueJobOptions,
  GetOneOrCreateInput,
  JobHandler,
  JobOptions,
  PluginDb,
  PluginTemplates,
  IdentityServices,
  MailService,
  PluginContext,
  PluginEvent,
  PluginRuntime,
  PluginTx,
  ScopedKv,
  SecretService,
  StorageScope,
} from '@manythreads/sdk';
import type { ExtensionPoint, PluginManifest } from '@manythreads/shared';
import { getOneOrCreate } from '../db/get-or-create.ts';
import type { Tx } from '../db/with-actor.ts';
import { enqueue } from '../jobs/index.ts';
import { createTemplateService } from '../templates/service.ts';
import { PluginError } from './errors.ts';
import type { ExtensionRegistries } from './registries.ts';

export interface ContextDeps {
  registries: ExtensionRegistries;
  emit?: EmitEvent;
  storage: ScopedKv;
  mail: MailService;
  runtime: PluginRuntime;
  /** Handed only to plugins that extend `provider.identity`. */
  identity?: IdentityServices;
  /** `ctx.templates` (default: the shipped `templates/` directory). */
  templates?: PluginTemplates;
  /** Secret storage for plugins that extend `provider.identity` (default: the kernel's KMS-backed one). */
  secrets?: SecretService;
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
    return path;
  };

  const emitChecked = async (tx: PluginTx, event: PluginEvent): Promise<void> => {
    use('event.emit');
    if (!manifest.events.emits.includes(event.type)) {
      throw new PluginError(
        `Plugin "${name}" emitted "${event.type}" but its manifest does not list it in events.emits`,
        { plugin: name },
      );
    }
    if (!deps.emit) throw new PluginError(`Plugin "${name}": no event emitter is wired into the host`, { plugin: name });
    await deps.emit(guardPluginTx(tx), event);
  };

  const db: PluginDb = {
    getOneOrCreate: <R extends Record<string, unknown>>(tx: PluginTx, input: GetOneOrCreateInput) =>
      getOneOrCreate<R>(guardPluginTx(tx) as unknown as Tx, input),
  };

  const templates = deps.templates ?? createTemplateService();

  const ownQueue = (queue: string): void => {
    if (!queue.startsWith(`${name}.`) || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]{0,62}$/.test(queue)) {
      throw new PluginError(
        `Plugin "${name}": job queue "${queue}" must be named "${name}.<name>" (lowercase letters, digits, dot, dash, underscore)`,
        { plugin: name },
      );
    }
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
        registries.eventSubscriptions.add(name, { type, handler: (event, tx) => handler(event, guardPluginTx(tx)) });
      },
      emit: emitChecked,
    },
    hooks: {
      prePersist(hook) {
        use('hook.pre_persist');
        registries.prePersist.add(name, (input, tx) => hook(input, guardPluginTx(tx)));
      },
      preEgress(hook) {
        use('hook.pre_egress');
        registries.preEgress.add(name, (input, tx) => hook(input, guardPluginTx(tx)));
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
        registries.commands.add(name, { ...definition, run: (args, tx) => definition.run(args, guardPluginTx(tx)) });
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
        registries.capabilityHandlers.set(capability, { plugin: name, handler: (input, tx) => handler(input, guardPluginTx(tx)) });
      },
    },
    http: {
      route(definition) {
        const fullPath = mount(definition.path);
        const clash = registries.httpRoutes
          .list()
          .find((e) => e.value.method === definition.method && e.value.fullPath === fullPath);
        if (clash) {
          throw new PluginError(
            `Plugin "${name}" route ${definition.method} ${fullPath} is already registered by plugin "${clash.plugin}"`,
            { plugin: name },
          );
        }
        registries.httpRoutes.add(name, {
          ...definition,
          handler: (request, tx) => definition.handler(request, guardPluginTx(tx)),
          fullPath,
        });
      },
    },
    storage: deps.storage,
    db,
    audit: {
      emit: (tx: PluginTx, event: AuditEvent) =>
        emitChecked(tx, { ...event, schemaVersion: event.schemaVersion ?? 1, workspaceId: event.workspaceId ?? tx.actor.workspaceId }),
    },
    templates,
    get jobs() {
      use('job.register');
      return {
        register(queue: string, handler: JobHandler, options: JobOptions = {}) {
          ownQueue(queue);
          const clash = registries.jobs.list().find((e) => e.value.queue === queue);
          if (clash) {
            throw new PluginError(`Plugin "${name}" job queue "${queue}" is already registered by plugin "${clash.plugin}"`, { plugin: name });
          }
          registries.jobs.add(name, { queue, handler, options });
        },
        async enqueue(tx: PluginTx, queue: string, payload: Record<string, unknown>, options: EnqueueJobOptions = {}) {
          ownQueue(queue);
          const job = await enqueue(guardPluginTx(tx) as unknown as Tx, queue, payload, options);
          return job.id;
        },
      };
    },
    mail: deps.mail,
    runtime: deps.runtime,
    get identity(): IdentityServices {
      use('provider.identity');
      if (!deps.identity) {
        throw new PluginError(`Plugin "${name}": no identity services are wired into the host`, { plugin: name });
      }
      return deps.identity;
    },
    get secrets(): SecretService {
      use('provider.identity');
      if (!deps.secrets) {
        throw new PluginError(`Plugin "${name}": no secret service is wired into the host`, { plugin: name });
      }
      return deps.secrets;
    },
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
