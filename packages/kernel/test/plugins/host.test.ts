import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { definePlugin, type PluginDefinition } from '@majlis/sdk';
import { ActorId, TeamId, WorkspaceId } from '@majlis/shared';
import { createTestDatabase, dropTestDatabase, findRlsViolations, type TestDatabase } from '@majlis/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppPool, createSystemPool, loadPlugins, withActor, withSystem, type PluginSource } from '../../src/index.ts';

const pluginsDir = fileURLToPath(new URL('../../../plugins/', import.meta.url));
const helloDir = fileURLToPath(new URL('../../../plugins/example-hello', import.meta.url));

const fake = (
  name: string,
  dependsOn: string[] = [],
  extra: Partial<Parameters<typeof definePlugin>[0]['manifest']> = {},
  register: PluginDefinition['register'] = () => undefined,
): PluginSource => ({
  definition: definePlugin({
    manifest: { name, version: '1.0.0', kind: 'server', dependsOn, ...extra },
    register,
  }),
});

describe('plugin host: ordering and validation (no database)', () => {
  it('orders dependencies first and keeps input order otherwise', async () => {
    const order: string[] = [];
    const track = (n: string): PluginDefinition['register'] => () => void order.push(n);
    const host = await loadPlugins({
      plugins: [
        fake('c', ['b'], {}, track('c')),
        fake('a', [], {}, track('a')),
        fake('b', ['a'], {}, track('b')),
        fake('d', [], {}, track('d')),
      ],
    });
    expect(host.plugins.map((p) => p.manifest.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a dependency cycle is an error naming the plugins', async () => {
    await expect(loadPlugins({ plugins: [fake('a', ['b']), fake('b', ['c']), fake('c', ['a'])] })).rejects.toThrow(
      /cycle: a -> b -> c -> a/,
    );
  });

  it('a missing dependency is an error naming both plugins', async () => {
    await expect(loadPlugins({ plugins: [fake('a', ['ghost'])] })).rejects.toThrow(/"a" depends on "ghost"/);
  });

  it('rejects duplicate names', () => {
    return expect(loadPlugins({ plugins: [fake('a'), fake('a')] })).rejects.toThrow(/Duplicate plugin "a"/);
  });

  it('manifest validation names the field', async () => {
    const bad: PluginSource = {
      definition: {
        manifest: { name: 'Bad Name', version: 'one', kind: 'server', extends: ['surface.nope'] } as never,
        register: () => undefined,
      },
    };
    const err = String(await loadPlugins({ plugins: [bad] }).catch((e: unknown) => e));
    expect(err).toMatch(/name: /);
    expect(err).toMatch(/version: .*semantic version/);
    expect(err).toMatch(/extends\.0: /);
    expect(() => definePlugin({ manifest: { name: 'x', version: '1.0.0', kind: 'server', capabilities: [{ name: 'bad', destructive: false }] }, register: () => undefined })).toThrow(
      /capabilities.*name/s,
    );
  });

  it('a plugin may only use extension points it declared', async () => {
    const use = (point: (ctx: Parameters<PluginDefinition['register']>[0]) => void, extend: string[] = []) =>
      loadPlugins({
        plugins: [fake('p', [], { extends: extend as never }, (ctx) => point(ctx))],
      });

    await expect(use((ctx) => ctx.surfaces.nav({ id: 'n', title: 'N' }))).rejects.toThrow(
      /Plugin "p".*"surface\.nav".*extends/s,
    );
    await expect(use((ctx) => ctx.hooks.prePersist(() => undefined))).rejects.toThrow(/hook\.pre_persist/);
    await expect(use((ctx) => ctx.providers.register('memory', { id: 'm' }))).rejects.toThrow(/provider\.memory/);
    await expect(use((ctx) => ctx.commands.register({ name: 'c', run: () => undefined }))).rejects.toThrow(
      /command\.register/,
    );

    const host = await use((ctx) => ctx.surfaces.nav({ id: 'n', title: 'N', order: 10 }), ['surface.nav']);
    expect(host.registries.nav.byPlugin('p')).toEqual([{ id: 'n', title: 'N', order: 10 }]);
  });

  it('events must be declared in the manifest, and capabilities too', async () => {
    await expect(
      loadPlugins({
        plugins: [fake('p', [], { extends: ['event.subscribe'] }, (ctx) => ctx.events.subscribe('a.b.c', () => undefined))],
      }),
    ).rejects.toThrow(/events\.consumes/);
    await expect(
      loadPlugins({ plugins: [fake('p', [], {}, (ctx) => ctx.capabilities.register('p.do', () => undefined))] }),
    ).rejects.toThrow(/does not declare it/);
  });

  it('registers manifest capabilities with their destructive tag; clashes across plugins fail', async () => {
    const host = await loadPlugins({
      plugins: [fake('p', [], { capabilities: [{ name: 'p.do', destructive: true }] })],
    });
    expect(host.capabilities.get('p.do')).toEqual({ name: 'p.do', destructive: true, plugin: 'p' });
    await expect(
      loadPlugins({
        plugins: [
          fake('p', [], { capabilities: [{ name: 'x.do', destructive: false }] }),
          fake('q', [], { capabilities: [{ name: 'x.do', destructive: false }] }),
        ],
      }),
    ).rejects.toThrow(/"x\.do" is already registered by plugin "p"/);
  });

  it('http routes are mounted at their declared absolute path', async () => {
    const host = await loadPlugins({
      plugins: [fake('p', [], {}, (ctx) => ctx.http.route({ method: 'GET', path: '/api/ping', handler: () => ({ body: 'pong' }) }))],
    });
    expect(host.registries.httpRoutes.values()[0]?.fullPath).toBe('/api/ping');
  });

  it('duplicate method+path across plugins fails at load naming both plugins', async () => {
    const route = (ctx: { http: { route: (d: never) => void } }): void =>
      ctx.http.route({ method: 'GET', path: '/api/ping', handler: () => ({ body: 'pong' }) } as never);
    await expect(
      loadPlugins({ plugins: [fake('p', [], {}, route as never), fake('q', [], {}, route as never)] }),
    ).rejects.toThrow(/GET \/api\/ping.*"p"|"p".*GET \/api\/ping/);
  });

  it('discovers plugins by the package.json majlis field', async () => {
    const host = await loadPlugins({ scanDir: pluginsDir });
    expect(host.plugins.map((p) => p.manifest.name)).toContain('example-hello');
  });
});

describe('plugin host: example-hello against Postgres', () => {
  let db: TestDatabase;
  let owner: pg.Client;
  let pool: pg.Pool;
  let sys: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    pool = createAppPool(db.appUrl, 4);
    sys = createSystemPool(db.systemUrl, 4);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await sys?.end();
    await owner?.end();
    if (db) await dropTestDatabase(db);
  }, 60_000);

  it('applies the plugin migration, records the plugin, passes the RLS harness, and runs the subscriber', async () => {
    const options = { plugins: [{ dir: helloDir }], database: { ownerUrl: db.ownerUrl, pool, systemPool: sys } };
    const host = await loadPlugins(options);

    const applied = await owner.query<{ id: string }>("SELECT id FROM app.schema_migrations WHERE id LIKE 'example-hello/%'");
    expect(applied.rows.map((r) => r.id)).toEqual([
      'example-hello/0001_hello_greetings.sql',
      'example-hello/0002_rls_comment.sql',
    ]);
    const plugins = await owner.query<{ name: string; version: string }>('SELECT name, version FROM app.plugins');
    expect(plugins.rows).toEqual([{ name: 'example-hello', version: '0.1.0' }]);
    expect(await findRlsViolations(owner)).toEqual([]);
    expect(host.capabilities.get('hello.greet')).toMatchObject({ destructive: false });

    // Loading twice applies nothing new and keeps one row.
    await loadPlugins(options);
    expect((await owner.query('SELECT 1 FROM app.plugins')).rowCount).toBe(1);

    const workspaceId = WorkspaceId.parse(randomUUID());
    const teamId = TeamId.parse(randomUUID());
    await withSystem(
      (tx) =>
        host.dispatch(
          { type: 'channel.message.posted', schemaVersion: 1, teamId, workspaceId },
          tx,
        ),
      { pool: sys },
    );
    const rows = await withSystem((tx) => tx.query('SELECT team_id FROM app.hello_greetings'), { pool: sys });
    expect(rows.rows).toEqual([{ team_id: teamId }]);

    // RLS: a non-system actor that is not a member of the team sees nothing.
    const outsider = { kind: 'person' as const, id: ActorId.parse(randomUUID()), workspaceId };
    const seen = await withActor(outsider, (tx) => tx.query('SELECT 1 FROM app.hello_greetings'), { pool });
    expect(seen.rowCount).toBe(0);
  });

  it('a missing migrations directory is an error naming the plugin', async () => {
    await expect(
      loadPlugins({
        plugins: [{ ...fake('nomig', [], { migrations: 'nope' }), dir: '/tmp' } as PluginSource],
        database: { ownerUrl: db.ownerUrl, pool, systemPool: sys },
      }),
    ).rejects.toThrow(/Plugin "nomig".*"nope"/);
  });
});
