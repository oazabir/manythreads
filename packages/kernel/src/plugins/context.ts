import { guardPluginTx } from '@manythreads/sdk';
import type {
  AuditEvent,
  CapabilityAuthorizeContext,
  CapabilityDecision,
  CapabilityHandler,
  EmitEvent,
  EnqueueJobOptions,
  GetOneOrCreateInput,
  HttpCaller,
  HttpRequest,
  JobHandler,
  JobOptions,
  PluginAccess,
  PluginDb,
  PluginTemplates,
  IdentityServices,
  MailService,
  PluginContext,
  PluginEvent,
  PluginRealtime,
  PluginRuntime,
  PluginRuns,
  PluginTx,
  ProviderImpl,
  ProviderKind,
  ScopedKv,
  SecretService,
  StorageScope,
} from '@manythreads/sdk';
import type { ExtensionPoint, PluginManifest, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import { getOneOrCreate } from '../db/get-or-create.ts';
import { createEntityLinkService } from '../entity-links/index.ts';
import { createReadStateService } from '../read-state/index.ts';
import { parseCron } from '../jobs/cron.ts';
import { publishRealtime } from '../transport/realtime.ts';
import { NIL_UUID, withActor, withSystem, type Actor, type Tx } from '../db/with-actor.ts';
import { enqueue } from '../jobs/index.ts';
import { createTemplateService } from '../templates/service.ts';
import { runEgressChain } from './egress.ts';
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
  /** The capability broker behind `ctx.capabilities.authorize`; without one the call rejects (fail closed). */
  broker?: { authorize(actor: Actor, capability: string, context?: CapabilityAuthorizeContext): Promise<CapabilityDecision> };
  /** `ctx.runs`, the MCP gateway's run/tool door (PLAN P5-09); absent when the host has no database pools. */
  runs?: PluginRuns;
  /** The app pool (`ctx.db.as`) and the system pool (`ctx.db.system`); absent when the host has no database. */
  pool?: pg.Pool;
  systemPool?: pg.Pool;
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

  /** For a door more than one trust domain may use: passes when the manifest lists any of `points`. */
  const useOneOf = (points: readonly ExtensionPoint[], label: string): void => {
    if (!points.some((point) => declared.has(point))) {
      throw new PluginError(
        `Plugin "${name}" used ${label} but its manifest lists none of "${points.join('", "')}" in "extends"`,
        { plugin: name },
      );
    }
  };

  let approvedDoor: PluginRuns | undefined;
  let closeOnlyDoor: PluginRuns | undefined;
  let resolveOnlyDoor: PluginRuns | undefined;

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
    as: async <T>(caller: HttpCaller | null, fn: (tx: PluginTx) => Promise<T>): Promise<T> => {
      if (!deps.pool) throw new PluginError(`Plugin "${name}": ctx.db.as needs a database pool`, { plugin: name });
      const actor: Actor = caller
        ? { kind: caller.kind, id: caller.actorId as Actor['id'], workspaceId: caller.workspaceId as Actor['workspaceId'] }
        : { kind: 'person', id: NIL_UUID as Actor['id'], workspaceId: NIL_UUID as Actor['workspaceId'] };
      return withActor(actor, (tx) => fn(guardPluginTx(tx as unknown as PluginTx)), { pool: deps.pool });
    },
    system: async <T>(fn: (tx: PluginTx) => Promise<T>, options: { workspaceId?: string } = {}): Promise<T> => {
      if (!deps.systemPool) throw new PluginError(`Plugin "${name}": ctx.db.system needs a database pool`, { plugin: name });
      // `workspaceId` scopes the transaction to one workspace (what a secret written from it belongs to); without it the system actor sees all of them.
      return withSystem((tx) => fn(guardPluginTx(tx as unknown as PluginTx)), {
        pool: deps.systemPool,
        ...(options.workspaceId ? { workspaceId: options.workspaceId as WorkspaceId } : {}),
      });
    },
  };

  const templates = deps.templates ?? createTemplateService();

  const realtime: PluginRealtime = {
    pushToPerson: (tx, personId, type, payload) =>
      publishRealtime(guardPluginTx(tx), [{ workspaceId: tx.actor.workspaceId, personId, type, payload }]),
    // One publish call (one statement) for the whole audience, whatever its size.
    pushToPeople: (tx, personIds, type, payload) =>
      publishRealtime(
        guardPluginTx(tx),
        [...new Set(personIds)].map((personId) => ({ workspaceId: tx.actor.workspaceId, personId, type, payload })),
      ),
    pushMany: (tx, pushes) =>
      publishRealtime(guardPluginTx(tx), pushes.map((p) => ({ workspaceId: tx.actor.workspaceId, ...p }))),
  };

  const idsOf = async (tx: PluginTx, text: string, perm: string): Promise<string[]> => {
    const res = await guardPluginTx(tx).query<{ ids: string[] | null }>(text, [perm]);
    return res.rows[0]?.ids ?? [];
  };
  const access: PluginAccess = {
    readableTeamIds: (tx, perm) => idsOf(tx, 'SELECT app.readable_team_ids($1::text) AS ids', perm),
    readableChannelIds: (tx, perm) => idsOf(tx, 'SELECT app.visible_channel_ids($1::text) AS ids', perm),
  };

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
      async runPreEgress(tx, input) {
        use('hook.pre_egress');
        return runEgressChain(registries.preEgress.list(), input, guardPluginTx(tx));
      },
    },
    providers: {
      register(kind, impl) {
        use(`provider.${kind}`);
        registries.providers[kind].add(name, impl);
      },
      get<T extends ProviderImpl = ProviderImpl>(kind: ProviderKind, id?: string): T | undefined {
        const all = registries.providers[kind].values() as T[];
        // Without an id: the first one, in load order. With one: an exact `id` match, and never a fallback — a bot whose
        // `runtime` names a provider that is not loaded must fail loudly rather than run on whichever registered first.
        return id === undefined ? all[0] : all.find((provider) => provider.id === id);
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
      async authorize(tx: PluginTx, capability: string, context: CapabilityAuthorizeContext = {}) {
        if (!deps.broker) throw new PluginError(`Plugin "${name}": no capability broker is wired into the host`, { plugin: name });
        return deps.broker.authorize(tx.actor as unknown as Actor, capability, context);
      },
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
    get runs(): PluginRuns {
      // `run.close` alone is the janitor's door: `close` works, every other member of `ctx.runs` refuses (it needs `tool.invoke`).
      if (!manifest.extends.includes('tool.invoke') && manifest.extends.includes('run.close')) {
        if (!deps.runs) {
          throw new PluginError(`Plugin "${name}": ctx.runs is only available when the plugin host has database pools`, { plugin: name });
        }
        const runs = deps.runs;
        const refuse = (member: string) => (): never => {
          throw new PluginError(`Plugin "${name}" extends "run.close" only: ctx.runs.${member} needs "tool.invoke"`, { plugin: name });
        };
        return (closeOnlyDoor ??= {
          close: (runId, status) => runs.close(runId, status),
          open: refuse('open'),
          resolve: refuse('resolve'),
          asBot: refuse('asBot'),
          asApproved: refuse('asApproved'),
          asReader: refuse('asReader'),
          authorize: refuse('authorize'),
          may: refuse('may'),
          catalog: refuse('catalog'),
          invoke: refuse('invoke'),
          logSource: refuse('logSource'),
          inheritSources: refuse('inheritSources'),
          openRunOf: refuse('openRunOf'),
        } as PluginRuns);
      }
      // `run.resolve` alone is the token checker's door: `resolve` works (a presented run token to the run it opens, or null), every other member refuses.
      // It is for an endpoint that takes the run's token as its credential without acting for the run (the run-scoped model proxy, P6-06).
      if (!manifest.extends.includes('tool.invoke') && manifest.extends.includes('run.resolve')) {
        if (!deps.runs) {
          throw new PluginError(`Plugin "${name}": ctx.runs is only available when the plugin host has database pools`, { plugin: name });
        }
        const runs = deps.runs;
        const refuse = (member: string) => (): never => {
          throw new PluginError(`Plugin "${name}" extends "run.resolve" only: ctx.runs.${member} needs "tool.invoke"`, { plugin: name });
        };
        return (resolveOnlyDoor ??= {
          resolve: (hash: Buffer) => runs.resolve(hash),
          close: refuse('close'),
          open: refuse('open'),
          asBot: refuse('asBot'),
          asApproved: refuse('asApproved'),
          asReader: refuse('asReader'),
          authorize: refuse('authorize'),
          may: refuse('may'),
          catalog: refuse('catalog'),
          invoke: refuse('invoke'),
          logSource: refuse('logSource'),
          inheritSources: refuse('inheritSources'),
          openRunOf: refuse('openRunOf'),
        } as PluginRuns);
      }
      // The door that can open a bot run and enter a transaction as its bot (PLAN P5-09); see docs/plugins/security.md.
      use('tool.invoke');
      if (!deps.runs) {
        throw new PluginError(`Plugin "${name}": ctx.runs is only available when the plugin host has database pools`, { plugin: name });
      }
      // `asApproved` waives `needsApproval`: it is a door of its own, declared as `approval.resume` (only the approvals plugin does).
      const runs = deps.runs;
      return (approvedDoor ??= {
        ...runs,
        asApproved: async (run, capability, fn) => {
          use('approval.resume');
          return runs.asApproved(run, capability, fn);
        },
      });
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
        if (definition.ws && definition.handler) throw new PluginError(`Plugin "${name}": a route is either a handler or a socket, not both`, { plugin: name });
        if (definition.ws && definition.method !== 'GET') throw new PluginError(`Plugin "${name}": a socket route must be GET`, { plugin: name });
        if (!definition.ws && !definition.handler) throw new PluginError(`Plugin "${name}": a route needs a handler or a socket`, { plugin: name });
        registries.httpRoutes.add(name, {
          ...definition,
          ...(definition.handler
            ? { handler: (request: HttpRequest, tx: PluginTx) => definition.handler!(request, guardPluginTx(tx)) }
            : {}),
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
          if (options.cron !== undefined) parseCron(options.cron); // a bad expression fails the plugin at load, not at 3 a.m.
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
    readState: createReadStateService({ counters: registries.unreadCounters, plugin: name }),
    links: createEntityLinkService({ resolvers: registries.entityResolvers, plugin: name }),
    realtime,
    access,
    get identity(): IdentityServices {
      use('provider.identity');
      if (!deps.identity) {
        throw new PluginError(`Plugin "${name}": no identity services are wired into the host`, { plugin: name });
      }
      return deps.identity;
    },
    get secrets(): SecretService {
      // The secret service also encrypts a model provider's API key (gateway-llm, PLAN P5-06), so a plugin that
      // extends `provider.llm` may use it too; `docs/plugins/security.md` explains both doors.
      useOneOf(['provider.identity', 'provider.llm', 'provider.hermes.profiles', 'secret.seal'], 'ctx.secrets');
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
