import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  EmitEvent,
  IdentityServices,
  MailService,
  PluginDefinition,
  PluginEvent,
  PluginRuntime,
  PluginTx,
  ScopedKv,
  SecretService,
} from '@manythreads/sdk';
import { PluginManifest } from '@manythreads/shared';
import type pg from 'pg';
import { CapabilityRegistry } from '../capabilities/registry.ts';
import { kernelMigrationSource, runMigrations, type MigrationSource } from '../db/migrate.ts';
import { createMemoryMailer } from '../mail/memory.ts';
import { renderMail } from '../mail/templates.ts';
import type { Mailer } from '../mail/types.ts';
import { withSystem } from '../db/with-actor.ts';
import { createSecretService } from '../kms/service.ts';
import { createDbKv } from '../storage/kv.ts';
import { createMemoryKv, createPluginContext } from './context.ts';
import { PluginError } from './errors.ts';
import { ExtensionRegistries } from './registries.ts';

/**
 * Where a plugin comes from: a package directory (its package.json `manythreads.entry` default-exports a
 * `definePlugin` result), or an already-built definition (tests, in-process plugins).
 */
export type PluginSource = { dir: string } | { definition: PluginDefinition; dir?: string };

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Package directory, when known. */
  dir: string | undefined;
  definition: PluginDefinition;
}

export interface LoadPluginsOptions {
  /** Explicit list. Combined with `scanDir` when both are given. */
  plugins?: readonly PluginSource[];
  /** Directory scanned for subdirectories whose package.json has a `manythreads` field, e.g. `packages/plugins`. */
  scanDir?: string;
  /**
   * Database to migrate and record plugins in. Omit to load without touching Postgres (ordering and
   * registration only).
   */
  database?: {
    /** manythreads_owner connection string: the role that owns tables and runs migrations. */
    ownerUrl: string;
    /** manythreads_app pool (unused by the host itself; kept so callers can share one options object). */
    pool?: pg.Pool;
    /** manythreads_system pool used to write `app.plugins` and back the default storage (default: the shared system pool). */
    systemPool?: pg.Pool;
    appPassword?: string | null;
    /** Migration sources ahead of the plugins (default: the kernel directory). */
    baseSources?: readonly MigrationSource[];
  };
  emit?: EmitEvent;
  /**
   * Storage handed to plugins: one instance, or a factory called with the plugin name. Default: `app.scoped_kv`
   * (namespaced per plugin) when `database` is set, in-memory otherwise.
   */
  storage?: ScopedKv | ((plugin: string) => ScopedKv);
  capabilities?: CapabilityRegistry;
  registries?: ExtensionRegistries;
  /** Delivers `ctx.mail.send` (default: an in-memory mailer that keeps messages, i.e. nothing is delivered). */
  mailer?: Mailer;
  /** `ctx.runtime`: public URL and clock (default: http://localhost:3000 and the system clock). */
  runtime?: PluginRuntime;
  /** `ctx.identity`, for plugins that extend `provider.identity`. The server builds it (it owns sessions). */
  identity?: IdentityServices;
  /** `ctx.secrets` (default: envelope encryption with the process KMS, see kms/service.ts). */
  secrets?: SecretService;
}

export interface PluginHost {
  /** Plugins in load order (dependencies first). */
  readonly plugins: readonly LoadedPlugin[];
  readonly registries: ExtensionRegistries;
  readonly capabilities: CapabilityRegistry;
  /** Run every subscriber of `event.type`, in load order. Used by the outbox consumer. */
  dispatch(event: PluginEvent, tx: PluginTx): Promise<void>;
}

interface PackageJsonmanythreads {
  entry: string;
}

const formatIssues = (issues: readonly { path: PropertyKey[]; message: string }[]): string =>
  issues.map((i) => `${i.path.map(String).join('.') || '(manifest)'}: ${i.message}`).join('; ');

/** Package directories under `scanDir` whose package.json has a `manythreads` field. Sorted by directory name. */
export async function discoverPlugins(scanDir: string): Promise<PluginSource[]> {
  const out: PluginSource[] = [];
  const names = (await readdir(scanDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    const dir = join(scanDir, name);
    let text: string;
    try {
      text = await readFile(join(dir, 'package.json'), 'utf8');
    } catch {
      continue;
    }
    const pkg = JSON.parse(text) as { manythreads?: unknown };
    if (pkg.manythreads !== undefined) out.push({ dir });
  }
  return out;
}

async function loadSource(source: PluginSource): Promise<LoadedPlugin> {
  let definition: PluginDefinition;
  let dir: string | undefined;
  if ('definition' in source) {
    definition = source.definition;
    dir = source.dir === undefined ? undefined : resolve(source.dir);
  } else {
    dir = resolve(source.dir);
    let pkg: { manythreads?: Partial<PackageJsonmanythreads> };
    try {
      pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as typeof pkg;
    } catch (err) {
      throw new PluginError(`Cannot read package.json of plugin at ${dir}`, { cause: err });
    }
    const entry = pkg.manythreads?.entry;
    if (typeof entry !== 'string') {
      throw new PluginError(`package.json at ${dir} has no manythreads.entry field`);
    }
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as { default?: PluginDefinition };
    if (!mod.default || typeof mod.default.register !== 'function') {
      throw new PluginError(`Plugin entry ${join(dir, entry)} must default-export a definePlugin() result`);
    }
    definition = mod.default;
  }

  const parsed = PluginManifest.safeParse(definition.manifest);
  if (!parsed.success) {
    const name = (definition.manifest as { name?: unknown } | undefined)?.name;
    throw new PluginError(
      `Invalid manifest for plugin "${typeof name === 'string' ? name : (dir ?? 'unknown')}": ${formatIssues(parsed.error.issues)}`,
      typeof name === 'string' ? { plugin: name, cause: parsed.error } : { cause: parsed.error },
    );
  }
  return { manifest: parsed.data, dir, definition: { ...definition, manifest: parsed.data } };
}

/** Dependencies first; ties keep the order given. Missing dependencies and cycles throw, naming plugins. */
export function orderPlugins(plugins: readonly LoadedPlugin[]): LoadedPlugin[] {
  const byName = new Map<string, LoadedPlugin>();
  for (const p of plugins) {
    if (byName.has(p.manifest.name)) throw new PluginError(`Duplicate plugin "${p.manifest.name}"`, { plugin: p.manifest.name });
    byName.set(p.manifest.name, p);
  }
  for (const p of plugins) {
    for (const dep of p.manifest.dependsOn) {
      if (!byName.has(dep)) {
        throw new PluginError(`Plugin "${p.manifest.name}" depends on "${dep}", which is not loaded`, {
          plugin: p.manifest.name,
        });
      }
    }
  }

  const ordered: LoadedPlugin[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      throw new PluginError(`Plugin dependency cycle: ${cycle.join(' -> ')}`, { plugin: name });
    }
    state.set(name, 'visiting');
    stack.push(name);
    const plugin = byName.get(name);
    if (!plugin) throw new PluginError(`Unknown plugin "${name}"`);
    for (const dep of plugin.manifest.dependsOn) visit(dep);
    stack.pop();
    state.set(name, 'done');
    ordered.push(plugin);
  };
  for (const p of plugins) visit(p.manifest.name);
  return ordered;
}

async function migrationSourceFor(plugin: LoadedPlugin): Promise<MigrationSource | undefined> {
  const rel = plugin.manifest.migrations;
  if (rel === undefined) return undefined;
  if (plugin.dir === undefined) {
    throw new PluginError(`Plugin "${plugin.manifest.name}" declares migrations but has no package directory`, {
      plugin: plugin.manifest.name,
    });
  }
  const dir = resolve(plugin.dir, rel);
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new PluginError(
      `Plugin "${plugin.manifest.name}": migrations directory "${rel}" does not exist (looked in ${dir})`,
      { plugin: plugin.manifest.name },
    );
  }
  return { namespace: plugin.manifest.name, dir };
}

/**
 * Discover, validate and order plugins; migrate (namespace = plugin name); record `app.plugins`; then call
 * each plugin's `register(ctx)` in dependency order.
 */
export async function loadPlugins(options: LoadPluginsOptions = {}): Promise<PluginHost> {
  const sources = [...(options.plugins ?? [])];
  if (options.scanDir) sources.push(...(await discoverPlugins(options.scanDir)));
  const loaded = await Promise.all(sources.map(loadSource));
  const ordered = orderPlugins(loaded);

  const capabilities = options.capabilities ?? new CapabilityRegistry();
  for (const p of ordered) {
    for (const c of p.manifest.capabilities) {
      capabilities.register({ name: c.name, destructive: c.destructive, plugin: p.manifest.name });
    }
  }

  const database = options.database;
  if (database) {
    const pluginSources: MigrationSource[] = [];
    for (const p of ordered) {
      const source = await migrationSourceFor(p);
      if (source) pluginSources.push(source);
    }
    await runMigrations({
      connectionString: database.ownerUrl,
      sources: [...(database.baseSources ?? [kernelMigrationSource]), ...pluginSources],
      ...(database.appPassword !== undefined ? { appPassword: database.appPassword } : {}),
    });
    await withSystem(
      async (tx) => {
        for (const p of ordered) {
          await tx.query(
            `INSERT INTO app.plugins (name, version, manifest) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, manifest = EXCLUDED.manifest, updated_at = now()`,
            [p.manifest.name, p.manifest.version, JSON.stringify(p.manifest)],
          );
        }
      },
      database.systemPool ? { pool: database.systemPool } : {},
    );
  }

  const registries = options.registries ?? new ExtensionRegistries();
  const memoryKv = createMemoryKv();
  const storageFor = (plugin: string): ScopedKv => {
    const configured = options.storage;
    if (typeof configured === 'function') return configured(plugin);
    if (configured) return configured;
    return database ? createDbKv({ plugin, ...(database.systemPool ? { pool: database.systemPool } : {}) }) : memoryKv;
  };
  // Without the server (unit tests of the host) a sign-in plugin still loads; using the services is what fails.
  const unavailable = (what: string) => (): never => {
    throw new PluginError(`ctx.identity.${what} is only available when the plugin host runs inside the server`);
  };
  const identity: IdentityServices = options.identity ?? {
    runAsSystem: unavailable('runAsSystem'),
    ensureActor: unavailable('ensureActor'),
    hashPassword: unavailable('hashPassword'),
    verifyPassword: unavailable('verifyPassword'),
    sessions: {
      issue: unavailable('sessions.issue'),
      list: unavailable('sessions.list'),
      revoke: unavailable('sessions.revoke'),
      revokeAll: unavailable('sessions.revokeAll'),
    },
    onStart: () => undefined,
  };
  const mailer = options.mailer ?? createMemoryMailer();
  const mail: MailService = { send: (message) => mailer.send(renderMail(message)) };
  const secrets = createSecretService();
  const runtime: PluginRuntime = options.runtime ?? { publicUrl: 'http://localhost:3000', now: () => new Date() };
  for (const p of ordered) {
    const ctx = createPluginContext(p.manifest, {
      registries,
      storage: storageFor(p.manifest.name),
      mail,
      runtime,
      identity,
      secrets: options.secrets ?? secrets,
      ...(options.emit ? { emit: options.emit } : {}),
    });
    try {
      await p.definition.register(ctx);
    } catch (err) {
      if (err instanceof PluginError && err.plugin === p.manifest.name) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new PluginError(`Plugin "${p.manifest.name}" failed to register: ${reason}`, {
        plugin: p.manifest.name,
        cause: err,
      });
    }
  }

  return {
    plugins: ordered,
    registries,
    capabilities,
    async dispatch(event, tx) {
      for (const { value } of registries.eventSubscriptions.list()) {
        if (value.type === event.type) await value.handler(event, tx);
      }
    },
  };
}
