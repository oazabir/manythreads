import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilityBroker,
  CapabilityRegistry,
  DEFAULT_APP_PASSWORD,
  createAppPool,
  createSystemPool,
    createDbGrantSource,
  createEventAuditSink,
  discoverPlugins,
  emit,
  kernelMigrationSource,
  loadPlugins,
  processedOnce,
  readMigrationFiles,
  startConsumer,
  subscribe,
  withSystem,
  type Consumer,
  type MigrationSource,
  type PluginHost,
  type PluginSource,
  type Tx,
} from '@manythreads/kernel';
import type { WorkspaceId } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildServer } from './build-server.ts';

export const pluginsDir = fileURLToPath(new URL('../../plugins/', import.meta.url));

/** Packages under packages/plugins that only exist for tests and examples; loaded when MANYTHREADS_TEST_PLUGINS=1. */
export const TEST_ONLY_PLUGIN_DIRS: ReadonlySet<string> = new Set(['test-kernel', 'example-hello']);

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** manythreads_owner URL: migrations only. */
  ownerUrl: string;
  /** manythreads_app URL for request handling. */
  appUrl: string;
  /** manythreads_system URL: the kernel's system actor (outbox, jobs, plugin registry). Never used for requests. */
  systemUrl: string;
  /** Password given to manythreads_app by the migration runner (null leaves it alone). */
  appPassword?: string | null;
  /**
   * Wraps migration and plugin loading (default: none). Roles are cluster-wide, so tests that migrate several
   * databases concurrently pass a cluster lock here.
   */
  migrationLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Load the test-only plugins (test-kernel, example-hello). */
  testPlugins?: boolean;
  devAuth?: boolean;
  logger?: boolean | object;
}

export interface RunningServer {
  app: FastifyInstance;
  host: PluginHost;
  pools: { app: pg.Pool; system: pg.Pool };
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  close(): Promise<void>;
}

const OUTBOX_SUBSCRIBER = 'plugins';

/**
 * Migrates the kernel and plugins, wires the capability broker audit sink and the plugin outbox consumer, mounts
 * plugin routes and starts listening. `close()` stops consumers, the server and the pool.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const appPool = createAppPool(options.appUrl);
  const systemPool = createSystemPool(options.systemUrl);

  const sources: PluginSource[] = (await discoverPlugins(pluginsDir)).filter((s) => {
    if (!('dir' in s) || s.dir === undefined) return true;
    const dirName = s.dir.split('/').filter(Boolean).pop() ?? '';
    return options.testPlugins === true || !TEST_ONLY_PLUGIN_DIRS.has(dirName);
  });

  const capabilities = new CapabilityRegistry();
  const lock = options.migrationLock ?? (<T>(fn: () => Promise<T>) => fn());
  const host = await lock(() => loadPlugins({
    plugins: sources,
    capabilities,
    database: {
      ownerUrl: options.ownerUrl,
      pool: appPool,
      systemPool,
      appPassword: options.appPassword === undefined ? DEFAULT_APP_PASSWORD : options.appPassword,
    },
    // Plugins see the kernel's emit; validation against the event registry happens there.
    emit: (tx, event) => emit(tx as unknown as Tx, event),
  }));

  // Denials by the capability broker become kernel.capability.denied events (the audit log).
  const broker = new CapabilityBroker({
    registry: capabilities,
    grants: createDbGrantSource({ pool: systemPool }),
    audit: createEventAuditSink(emit, { withTx: (fn) => withSystem(fn, { pool: systemPool }) }),
  });

  const migrationSources: MigrationSource[] = [kernelMigrationSource];
  for (const p of host.plugins) {
    if (p.manifest.migrations !== undefined && p.dir !== undefined) {
      migrationSources.push({ namespace: p.manifest.name, dir: resolve(p.dir, p.manifest.migrations) });
    }
  }
  const expectedMigrations = (await readMigrationFiles(migrationSources)).length;

  const app = await buildServer({
    host,
    pool: appPool,
    systemPool,
    expectedMigrations,
    ...(options.devAuth !== undefined ? { devAuth: options.devAuth } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  app.decorate('broker', broker);

  // Plugin event subscribers: one outbox consumer fans events out to host.dispatch, exactly once in effect.
  const consumers: Consumer[] = [];
  const types = [...new Set(host.registries.eventSubscriptions.list().map((e) => e.value.type))];
  if (types.length > 0) {
    await withSystem(async (tx) => {
      for (const type of types) await subscribe(tx, OUTBOX_SUBSCRIBER, type);
    }, { pool: systemPool });
    consumers.push(
      startConsumer({
        subscriber: OUTBOX_SUBSCRIBER,
        pool: systemPool,
        pollMs: 500,
        handler: async (event, meta) => {
          await withSystem(
            async (tx) => {
              if (!(await processedOnce(tx, OUTBOX_SUBSCRIBER, meta.eventId))) return;
              await host.dispatch(event as never, tx as never);
            },
            { pool: systemPool, workspaceId: (event as { workspaceId: WorkspaceId }).workspaceId },
          );
        },
      }),
    );
  }

  await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);

  return {
    app,
    host,
    port,
    pools: { app: appPool, system: systemPool },
    url: `http://127.0.0.1:${port}`,
    async close() {
      await Promise.all(consumers.map((c) => c.stop()));
      await app.close();
      await Promise.all([appPool.end(), systemPool.end()]);
    },
  };
}
