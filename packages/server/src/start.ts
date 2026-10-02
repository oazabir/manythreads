import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilityBroker,
  CapabilityRegistry,
  DEFAULT_APP_PASSWORD,
  KMS_REWRAP_QUEUE,
  createAppPool,
  createSystemPool,
  createDbGrantSource,
  createKmsRewrapHandler,
  createEventAuditSink,
  createRealtime,
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
  schedule,
  startConsumer,
  startScheduler,
  startWorker,
  subscribe,
  withSystem,
  type Consumer,
  type Mailer,
  type MigrationSource,
  type PluginHost,
  type PluginSource,
  type Tx,
  type Worker,
} from '@manythreads/kernel';
import { guardPluginTx, type IdentityServices, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import type { PersonId, WorkspaceId } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildServer } from './build-server.ts';
import { createSessionService, sessionConfigFromEnv, type SessionConfig, type SessionService } from './session/index.ts';

/**
 * `MANYTHREADS_TRUST_PROXY`: unset/0/false = off; 1/true = one proxy hop (the ingress); a number N = N hops; anything
 * else = a comma-separated list of proxy addresses or CIDRs to trust. Never "trust everything": Fastify would then take
 * the LEFTMOST x-forwarded-for entry, which the client writes, and a spoofed address defeats the sign-in lockout.
 */
export function trustProxyFromEnv(raw: string | undefined): boolean | number | string[] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * The token behind `POST /api/test/session`. It is a way to sign in as anyone without a password, so a production
 * process refuses to start with it set, and a weak value is refused anywhere.
 */
export function resolveTestAuthToken(explicit: string | null | undefined, env: NodeJS.ProcessEnv): string | null {
  const token = explicit === undefined ? (env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? null) : explicit;
  if (token === null || token === '') return null;
  if (env['NODE_ENV'] === 'production') {
    throw new Error('MANYTHREADS_TEST_AUTH_TOKEN is set in production: the test sign-in endpoint must never run on a real deployment.');
  }
  if (token.length < 16) throw new Error('MANYTHREADS_TEST_AUTH_TOKEN must be at least 16 characters.');
  return token;
}

export const pluginsDir = fileURLToPath(new URL('../../plugins/', import.meta.url));

/** Packages under packages/plugins that only exist for tests and examples; loaded when MANYTHREADS_TEST_PLUGINS=1. */
export const TEST_ONLY_PLUGIN_DIRS: ReadonlySet<string> = new Set(['test-kernel', 'example-hello']);

/** The two plugins that register the one `storage` provider; `MANYTHREADS_STORAGE` decides which of them loads. */
export const STORAGE_PLUGIN_DIRS: Readonly<Record<'local' | 's3', string>> = { local: 'storage-local', s3: 'storage-s3' };

/** `MANYTHREADS_STORAGE`: `local` (default, `storage-local`) or `s3` (`storage-s3`). Anything else stops the start: a typo must not pick a store. */
export function storageFromEnv(raw: string | undefined): 'local' | 's3' {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'local') return 'local';
  if (v === 's3') return 's3';
  throw new Error(`MANYTHREADS_STORAGE must be "local" or "s3" (got "${raw}")`);
}

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
  /**
   * Run the job workers: the kernel's `kms.rewrap` queue and every queue a plugin registered with `ctx.jobs.register`
   * (default true; `MANYTHREADS_JOB_WORKERS=0` turns it off for the `main` entry point, e.g. for a web-only replica).
   */
  jobWorkers?: boolean;
  /** How often an idle job worker polls (it is also woken by NOTIFY); default 5000 ms. */
  jobPollMs?: number;
  /** Load the test-only plugins (test-kernel, example-hello). */
  testPlugins?: boolean;
  /** Which storage plugin loads: `local` (storage-local) or `s3` (storage-s3). Default from `MANYTHREADS_STORAGE`, else `local`. */
  storage?: 'local' | 's3';
  /** The test-only dev header (only ever honoured when NODE_ENV=test; see dev-actor.ts). */
  devAuth?: boolean;
  logger?: boolean | object;
  /** Behind a reverse proxy that appends to x-forwarded-for (default from `MANYTHREADS_TRUST_PROXY`, see `trustProxyFromEnv`). */
  trustProxy?: boolean | number | string | string[];
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
  /** Queues with a running worker in this process (kernel and plugin queues). */
  jobQueues: readonly string[];
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

  // One `storage` provider only: the plugin of the other store is not even loaded.
  const storage = options.storage ?? storageFromEnv(process.env['MANYTHREADS_STORAGE']);
  const storageDirs = new Set(Object.values(STORAGE_PLUGIN_DIRS));
  const sources: PluginSource[] = (await discoverPlugins(pluginsDir)).filter((s) => {
    if (!('dir' in s) || s.dir === undefined) return true;
    const dirName = s.dir.split('/').filter(Boolean).pop() ?? '';
    if (storageDirs.has(dirName)) return dirName === STORAGE_PLUGIN_DIRS[storage];
    return options.testPlugins === true || !TEST_ONLY_PLUGIN_DIRS.has(dirName);
  });

  const testAuthToken = resolveTestAuthToken(options.testAuthToken, process.env);
  const clock = options.now ?? (() => new Date());
  const publicUrl = (options.publicUrl ?? process.env['MANYTHREADS_PUBLIC_URL'] ?? `http://localhost:${options.port ?? 3000}`).replace(/\/+$/, '');
  // The Secure flag follows the URL the operator configured, not the localhost fallback above: a production server
  // started without MANYTHREADS_PUBLIC_URL must not end up with plain cookies.
  const configuredPublicUrl = options.publicUrl ?? process.env['MANYTHREADS_PUBLIC_URL'];
  const sessionConfig: SessionConfig = {
    ...sessionConfigFromEnv({ ...process.env, MANYTHREADS_PUBLIC_URL: configuredPublicUrl }),
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
  // Denials by the capability broker become kernel.capability.denied events (the audit log). Built before the plugins load so
  // `ctx.capabilities.authorize` can reach it; the registry fills as manifests are read.
  const broker = new CapabilityBroker({
    registry: capabilities,
    grants: createDbGrantSource({ pool: systemPool }),
    audit: createEventAuditSink(emit, { withTx: (fn) => withSystem(fn, { pool: systemPool }) }),
  });
  const lock = options.migrationLock ?? (<T>(fn: () => Promise<T>) => fn());
  const host = await lock(() => loadPlugins({
    plugins: sources,
    capabilities,
    broker,
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

  const migrationSources: MigrationSource[] = [kernelMigrationSource];
  for (const p of host.plugins) {
    if (p.manifest.migrations !== undefined && p.dir !== undefined) {
      migrationSources.push({ namespace: p.manifest.name, dir: resolve(p.dir, p.manifest.migrations) });
    }
  }
  const expectedMigrations = (await readMigrationFiles(migrationSources)).length;

  // Live pushes: this process's sockets by person, fed by NOTIFY from every replica (including this one).
  const realtime = createRealtime();
  await realtime.start(appPool);

  const app = await buildServer({
    host,
    realtime,
    pool: appPool,
    systemPool,
    expectedMigrations,
    sessions,
    trustProxy: options.trustProxy ?? trustProxyFromEnv(process.env['MANYTHREADS_TRUST_PROXY']),
    testAuthToken,
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

  // Job workers: the kernel's own queue and the queues plugins registered. Handlers of plugins run as the system actor, one
  // transaction per attempt (see `JobHandler` in the SDK); a throw rolls back and the worker retries with backoff.
  const workers: Worker[] = [];
  const jobQueues: string[] = [];
  if (options.jobWorkers !== false) {
    const workerBase = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const pollMs = options.jobPollMs ?? 5000;
    jobQueues.push(KMS_REWRAP_QUEUE);
    workers.push(
      startWorker({
        queue: KMS_REWRAP_QUEUE,
        handler: createKmsRewrapHandler(undefined, { pool: systemPool }),
        workerId: `${workerBase}-${KMS_REWRAP_QUEUE}`,
        pool: systemPool,
        pollMs,
      }),
    );
    for (const { plugin, value } of host.registries.jobs.list()) {
      if (jobQueues.includes(value.queue)) {
        throw new Error(`Plugin "${plugin}" job queue "${value.queue}" collides with a kernel queue`);
      }
      jobQueues.push(value.queue);
      workers.push(
        startWorker({
          queue: value.queue,
          workerId: `${workerBase}-${value.queue}`,
          pool: systemPool,
          pollMs,
          ...(value.options.concurrency !== undefined ? { concurrency: value.options.concurrency } : {}),
          ...(value.options.maxAttempts !== undefined ? { maxAttempts: value.options.maxAttempts } : {}),
          handler: (payload, job) => {
            const workspaceId = typeof payload['workspaceId'] === 'string' ? (payload['workspaceId'] as WorkspaceId) : undefined;
            return withSystem(
              async (tx) => {
                await value.handler(payload, guardPluginTx(tx as unknown as PluginTx), { ...job, log });
              },
              { pool: systemPool, ...(workspaceId ? { workspaceId } : {}) },
            );
          },
        }),
      );
    }
  }

  // Cron schedules declared by plugins (`ctx.jobs.register(queue, handler, { cron })`): stored under the queue's name (idempotent), then one
  // ticker per process enqueues the latest due slot; replicas race safely (the schedule row is locked, the dedupe key is name@slot).
  let scheduler: { stop(): void } | undefined;
  if (options.jobWorkers !== false) {
    const scheduled = host.registries.jobs.list().filter((e) => e.value.options.cron !== undefined);
    if (scheduled.length > 0) {
      await withSystem(
        async (tx) => {
          for (const { value } of scheduled) await schedule(tx, value.queue, value.options.cron as string, value.queue, {});
        },
        { pool: systemPool },
      );
      scheduler = startScheduler({ pool: systemPool });
    }
  }

  await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);

  return {
    app,
    host,
    jobQueues,
    sessions,
    mailer,
    publicUrl,
    port,
    pools: { app: appPool, system: systemPool },
    url: `http://127.0.0.1:${port}`,
    async close() {
      scheduler?.stop();
      await Promise.all([...consumers.map((c) => c.stop()), ...workers.map((x) => x.stop())]);
      await realtime.stop();
      await app.close();
      await Promise.all([appPool.end(), systemPool.end()]);
    },
  };
}
