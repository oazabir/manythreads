import { createAppPool, createMemoryKv, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginLogger } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bots from '../src/index.ts';
import { ENSURE_BRAIN_QUEUE, ensureWorkspaceBrainAtStart } from '../src/workspace-brain.ts';

// P20-07: a fresh deploy has its workspace Brain when the plugin starts, not at the next 15-minute slot. The start call is the same ensure the job runs, never throws, and
// two replicas starting together do not both do the work.

const WS = personas.omar.workspaceId;

let db: TestDatabase;
let sysPool: pg.Pool;
let appPool: pg.Pool;
const logs: string[] = [];
const log: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(m) };
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const brainIds = (): Promise<string[]> => sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE workspace_id = $1 AND scope = 'workspace' AND slug = 'brain'`, [WS])).rows.map((r) => r.id));

const context = (pools: boolean) =>
  createPluginContext(bots.manifest, {
    registries: new ExtensionRegistries(),
    storage: createMemoryKv(),
    mail: { configured: true, send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: () => Promise.resolve(),
    ...(pools ? { pool: appPool, systemPool: sysPool } : {}),
  });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 4);
  appPool = createAppPool(db.appUrl, 2);
}, 120_000);

afterAll(async () => {
  await sysPool?.end();
  await appPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the workspace Brain at start', () => {
  it('survives a host with no database: the call answers false with a warning and registering the plugin does not throw', async () => {
    const bare = context(false);
    expect(await ensureWorkspaceBrainAtStart(bare, log)).toBe(false);
    expect(logs.join('\n')).toMatch(/not ensured at start/);
    await expect(Promise.resolve(bots.register(bare))).resolves.toBeUndefined();
    expect(await brainIds()).toEqual([]);
  });

  it('does nothing while another replica holds the start lock, and does the work once the lock is gone', async () => {
    const holder = await sysPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ENSURE_BRAIN_QUEUE]);
      expect(await ensureWorkspaceBrainAtStart(context(true), log)).toBe(false);
      expect(await brainIds()).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await ensureWorkspaceBrainAtStart(context(true), log)).toBe(true);
    expect(await brainIds()).toHaveLength(1);
  });

  it('is idempotent: starting again changes nothing', async () => {
    const [before] = await brainIds();
    expect(await ensureWorkspaceBrainAtStart(context(true), log)).toBe(true);
    expect(await brainIds()).toEqual([before]);
    const versions = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.workspace_bot_definitions WHERE workspace_id = $1', [WS])).rows.length);
    expect(versions).toBe(1);
  });

  it('is made by registering the plugin itself, with no job slot due', async () => {
    await sys(async (tx) => {
      await tx.query('DELETE FROM app.workspace_bot_definitions WHERE workspace_id = $1', [WS]);
      await tx.query(`DELETE FROM app.bots WHERE workspace_id = $1 AND scope = 'workspace'`, [WS]);
    });
    expect(await brainIds()).toEqual([]);
    await bots.register(context(true));
    const deadline = Date.now() + 20_000;
    let ids: string[] = [];
    while (Date.now() < deadline) {
      ids = await brainIds();
      if (ids.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ids).toHaveLength(1);
  });
});
