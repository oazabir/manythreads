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
  ensureActor,
  hashPassword,
  verifyPassword,
  mailerFromEnv,
  kernelMigrationSource,
  loadPlugins,
  processedOnce,
  readMigrationFiles,
  startConsumer,
  subscribe,
  withSystem,
  type Consumer,
  type Mailer,
  type MigrationSource,
  type PluginHost,
  type PluginSource,
  type Tx,
} from '@manythreads/kernel';
import { guardPluginTx, type IdentityServices, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import type { PersonId, WorkspaceId } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildServer } from './build-server.ts';
import { createSessionService, sessionConfigFromEnv, type SessionConfig, type SessionService } from './session/index.ts';

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
  /** The test-only dev header (only ever honoured when NODE_ENV=test; see dev-actor.ts). */
  devAuth?: boolean;
  logger?: boolean | object;
  /** Behind a reverse proxy that sets x-forwarded-for (default: `MANYTHREADS_TRUST_PROXY=1`). */
  trustProxy?: boolean;
  /** Public base URL (`MANYTHREADS_PUBLIC_URL`) used for links in mails and the bootstrap line. Default http://localhost:<port>. */
  publicUrl?: string;
  /** Delivers mail (default: SMTP from `MANYTHREADS_SMTP_URL`, otherwise it logs that nothing was sent). */
  mailer?: Mailer;
  /** The server's clock; tests inject one to prove idle and absolute session expiry. */
  now?: () => Date;
  /** Session lifetimes and cookie flags; defaults come from the environment (`sessionConfigFromEnv`). */
  session?: Partial<SessionConfig>;
  /**
   * TEST ONLY. When set, `POST /api/test/session` exists and answers requests carrying `x-test-auth: <value>`.
   * Default: `MANYTHREADS_TEST_AUTH_TOKEN`. Pass `null` to ignore the environment.
   */
  testAuthToken?: string | null;
}

export interface RunningServer {
  app: FastifyInstance;
  host: PluginHost;
  sessions: SessionService;
  mailer: Mailer;
  publicUrl: string;
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

  const clock = options.now ?? (() => new Date());
  const publicUrl = (options.publicUrl ?? process.env['MANYTHREADS_PUBLIC_URL'] ?? `http://localhost:${options.port ?? 3000}`).replace(/\/+$/, '');
  const sessionConfig: SessionConfig = {
    ...sessionConfigFromEnv({ ...process.env, MANYTHREADS_PUBLIC_URL: publicUrl }),
    ...options.session,
  };
  const sessions = createSessionService({ pool: systemPool, config: sessionConfig, now: clock });
  let mailWarn: (line: string) => void = () => undefined; // bound to the app logger once the app exists
  const mailer = options.mailer ?? mailerFromEnv(process.env, (line) => mailWarn(line));
  const startTasks: Array<(tx: PluginTx, log: PluginLogger) => Promise<void>> = [];
  // What a sign-in plugin (extends provider.identity) may do beyond a normal plugin; see docs/plugins/security.md.
  const identity: IdentityServices = {
    runAsSystem: (fn, opts) =>
      withSystem((tx) => fn(guardPluginTx(tx as unknown as PluginTx)), {
        pool: systemPool,
        ...(opts?.workspaceId ? { workspaceId: opts.workspaceId as WorkspaceId } : {}),
      }),
    ensureActor: async (tx, input) =>
      (await ensureActor(tx as unknown as Tx, { kind: 'person', workspaceId: input.workspaceId as WorkspaceId, refId: input.personId as PersonId })).id,
    hashPassword,
    verifyPassword,
    sessions,
    onStart: (task) => {
      startTasks.push(task);
    },
  };

  const capabilities = new CapabilityRegistry();
  const lock = options.migrationLock ?? (<T>(fn: () => Promise<T>) => fn());
  const host = await lock(() => loadPlugins({
    plugins: sources,
    capabilities,
    mailer,
    runtime: { publicUrl, now: clock },
    identity,
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
    sessions,
    trustProxy: options.trustProxy ?? process.env['MANYTHREADS_TRUST_PROXY'] === '1',
    testAuthToken: options.testAuthToken === undefined ? (process.env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? null) : options.testAuthToken,
    ...(options.devAuth !== undefined ? { devAuth: options.devAuth } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  app.decorate('broker', broker);
  mailWarn = (line) => app.log.warn(line);

  // Start-up tasks of identity plugins (first-admin bootstrap line) run once, as the system actor, before listening.
  const log: PluginLogger = { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) };
  for (const task of startTasks) await withSystem((tx) => task(guardPluginTx(tx as unknown as PluginTx), log), { pool: systemPool });

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
    sessions,
    mailer,
    publicUrl,
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
