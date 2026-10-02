import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { definePlugin, type PluginContext, type PluginDefinition, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSystemPool,
  createTemplateService,
  loadPlugins,
  withSystem,
  type PluginHost,
  type PluginSource,
  type Tx,
} from '../../src/index.ts';

// P3-00: the SDK helpers that replace what plugins used to copy out of the kernel: ctx.db, ctx.audit, ctx.templates, ctx.jobs.

type Manifest = Parameters<typeof definePlugin>[0]['manifest'];
const source = (name: string, extra: Partial<Manifest>, register: PluginDefinition['register'] = () => undefined): PluginSource => ({
  definition: definePlugin({ manifest: { name, version: '1.0.0', kind: 'server', ...extra }, register }),
});

/** Loads one plugin and hands back its ctx (the same object `register` got). */
async function withCtx(
  extra: Partial<Manifest>,
  options: Parameters<typeof loadPlugins>[0] = {},
  name = 'p',
): Promise<{ ctx: PluginContext; host: PluginHost }> {
  let ctx: PluginContext | undefined;
  const host = await loadPlugins({ ...options, plugins: [source(name, extra, (c) => void (ctx = c))] });
  return { ctx: ctx as PluginContext, host };
}

describe('ctx.audit.emit', () => {
  const tx = { actor: { kind: 'person', id: randomUUID(), workspaceId: randomUUID() }, query: () => Promise.reject(new Error('no db')) } as PluginTx;
  const capture = () => {
    const seen: PluginEvent[] = [];
    return { seen, emit: (_tx: unknown, event: unknown) => { seen.push(event as PluginEvent); return Promise.resolve(); } };
  };

  it('fills schemaVersion (1) and workspaceId (the transaction\'s), and keeps explicit values', async () => {
    const c = capture();
    const { ctx } = await withCtx({ extends: ['event.emit'], events: { emits: ['a.b.c'], consumes: [] } }, { emit: c.emit });
    await ctx.audit.emit(tx, { type: 'a.b.c', thing: 1 });
    await ctx.audit.emit(tx, { type: 'a.b.c', schemaVersion: 3, workspaceId: 'w-explicit' });
    expect(c.seen).toEqual([
      { type: 'a.b.c', thing: 1, schemaVersion: 1, workspaceId: tx.actor.workspaceId },
      { type: 'a.b.c', schemaVersion: 3, workspaceId: 'w-explicit' },
    ]);
  });

  it('is gated like events.emit: needs event.emit and the type in events.emits', async () => {
    const c = capture();
    const noPoint = await withCtx({ events: { emits: ['a.b.c'], consumes: [] } }, { emit: c.emit });
    await expect(noPoint.ctx.audit.emit(tx, { type: 'a.b.c' })).rejects.toThrow(/"event\.emit".*extends/s);
    const undeclared = await withCtx({ extends: ['event.emit'] }, { emit: c.emit });
    await expect(undeclared.ctx.audit.emit(tx, { type: 'a.b.c' })).rejects.toThrow(/events\.emits/);
    expect(c.seen).toEqual([]);
  });
});

describe('ctx.templates', () => {
  let tmp: string;
  const yaml = (id: string) => `id: ${id}
name: ${id}
description: d
version: 1
channels:
  - name: "#general"
    purpose: p
board:
  name: B
  columns: [Open]
bots:
  - slug: brain
    name: Brain
    role: r
roleTags: []
`;
  const put = async (id: string, text = yaml(id)): Promise<void> => {
    await mkdir(path.join(tmp, id), { recursive: true });
    await writeFile(path.join(tmp, id, 'template.yaml'), text);
    await writeFile(path.join(tmp, id, 'TEAM.md'), `---\nname: ${id}\n---\n`);
  };
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'manythreads-tpl-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('lists the five shipped templates by default and gets one by id', async () => {
    const { ctx } = await withCtx({});
    const all = await ctx.templates.list();
    expect(all.map((t) => t.id)).toEqual(['customer-support', 'engineering', 'marketing', 'product-design', 'research']);
    expect((await ctx.templates.get('engineering'))?.channels.map((c) => c.name)).toContain('#dev');
    expect(await ctx.templates.get('nope')).toBeUndefined();
  });

  it('reads once and caches; a failed read is not cached, so a fixed file is picked up', async () => {
    await put('good');
    await put('broken', 'id: broken\nname: [');
    const service = createTemplateService(tmp);
    await expect(service.list()).rejects.toThrow(/broken/);
    await rm(path.join(tmp, 'broken'), { recursive: true });
    expect((await service.list()).map((t) => t.id)).toEqual(['good']);
    await put('late');
    expect((await service.list()).map((t) => t.id)).toEqual(['good']); // cached
    expect(await service.get('good')).toMatchObject({ id: 'good' });
  });

  it('the host takes a service of its own (tests, alternative template sets)', async () => {
    const { ctx } = await withCtx({}, { templates: createTemplateService(tmp) });
    expect((await ctx.templates.list()).map((t) => t.id)).toEqual(['good', 'late']);
  });
});

describe('ctx.jobs', () => {
  const jobs = (extra: Partial<Manifest> = { extends: ['job.register'] }, name = 'p') => withCtx(extra, {}, name);

  it('needs the job.register extension point', async () => {
    const { ctx } = await jobs({});
    expect(() => ctx.jobs).toThrow(/"job\.register".*extends/s);
  });

  it('registers a queue in the plugin\'s own namespace, once', async () => {
    const { ctx, host } = await jobs();
    ctx.jobs.register('p.work', () => undefined, { concurrency: 2 });
    expect(host.registries.jobs.list().map((e) => [e.plugin, e.value.queue, e.value.options])).toEqual([['p', 'p.work', { concurrency: 2 }]]);
    expect(() => ctx.jobs.register('p.work', () => undefined)).toThrow(/already registered by plugin "p"/);
    for (const bad of ['work', 'other.work', 'p.', 'p.Work', 'kms.rewrap', 'p.has space', `p.${'x'.repeat(80)}`]) {
      expect(() => ctx.jobs.register(bad, () => undefined), bad).toThrow(/must be named "p\.<name>"/);
    }
  });

  it('a queue outside the plugin\'s own namespace is refused, so two plugins cannot collide on one', async () => {
    const shared = (ctx: PluginContext) => ctx.jobs.register('a.work', () => undefined);
    const ext = { extends: ['job.register' as const] };
    await expect(loadPlugins({ plugins: [source('a', ext, shared), source('b', ext, (ctx) => ctx.jobs.register('a.work', () => undefined))] })).rejects.toThrow(
      /must be named "b\.<name>"/,
    );
  });
});

describe('ctx.db.getOneOrCreate', () => {
  let db: TestDatabase;
  let pool: ReturnType<typeof createSystemPool>;
  let ctx: PluginContext;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createSystemPool(db.systemUrl, 8);
    ({ ctx } = await withCtx({}));
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (db) await dropTestDatabase(db);
  });

  const run = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => withSystem((tx: Tx) => fn(tx as unknown as PluginTx), { pool });
  const slugInput = (slug: string, name: string) => ({
    table: 'app.workspaces',
    values: { slug, name },
    conflict: ['slug'],
    returning: ['id', 'name'],
  });

  it('creates the row, then returns the same one without writing (the name of the second caller is ignored)', async () => {
    const first = await run((tx) => ctx.db.getOneOrCreate<{ id: string; name: string }>(tx, slugInput('acme', 'Acme')));
    const second = await run((tx) => ctx.db.getOneOrCreate<{ id: string; name: string }>(tx, slugInput('acme', 'Other name')));
    expect(second).toEqual(first);
    expect(first.name).toBe('Acme');
    expect(await run(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM app.workspaces WHERE slug = 'acme'")).rows[0])).toEqual({ n: 1 });
  });

  it('twenty concurrent callers converge on one row', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => run((tx) => ctx.db.getOneOrCreate<{ id: string }>(tx, { ...slugInput('race', 'Race'), returning: ['id'] }))),
    );
    expect(new Set(ids.map((r) => r.id)).size).toBe(1);
    expect(await run(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM app.workspaces WHERE slug = 'race'")).rows[0])).toEqual({ n: 1 });
  });

  it('a pre-drawn id tells the caller whether it created the row', async () => {
    const draw = async (tx: PluginTx) => (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id as string;
    const make = (slug: string) =>
      run(async (tx) => {
        const id = await draw(tx);
        const row = await ctx.db.getOneOrCreate<{ id: string }>(tx, { table: 'app.workspaces', values: { id, slug, name: slug }, conflict: ['slug'], returning: ['id'] });
        return row.id === id;
      });
    expect(await make('drawn')).toBe(true);
    expect(await make('drawn')).toBe(false);
  });

  it('rejects unsafe identifiers and a conflict column missing from the values', async () => {
    await expect(run((tx) => ctx.db.getOneOrCreate(tx, { table: 'app.workspaces; DROP TABLE x', values: { slug: 'x' }, conflict: ['slug'] }))).rejects.toThrow(/Unsafe SQL identifier/);
    await expect(run((tx) => ctx.db.getOneOrCreate(tx, { table: 'app.workspaces', values: { name: 'x' }, conflict: ['slug'] }))).rejects.toThrow(/Conflict column "slug"/);
    await expect(run((tx) => ctx.db.getOneOrCreate(tx, { table: 'app.workspaces', values: {}, conflict: ['slug'] }))).rejects.toThrow(/at least one value/);
  });
});
