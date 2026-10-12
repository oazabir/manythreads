import { createPluginContext, createSecretService, ExtensionRegistries, createMemoryKv, createAppPool, createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  gatewayLlmMigrationSource,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import gatewayLlm from '../src/index.ts';
import { pushLlmConfig } from '../src/config.ts';
import { keyPrefix, mintBotKey, newBotKey, revokeBotKey } from '../src/keys.ts';

// P5-06, the key half and the config push, against a real database: the plugin is registered exactly as the server registers
// it, then its job handlers are invoked with a system transaction. No proxy is configured (MANYTHREADS_LITELLM_URL is
// cleared), which is the path a dev box and this suite take: keys are minted and stored, and nothing is pushed.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let emitted: PluginEvent[];
let jobs: Map<string, { handler: (payload: Record<string, unknown>, tx: PluginTx, job: { jobId: string; attempt: number; workerId: string; log: { info: (m: string) => void; warn: (m: string) => void } }) => Promise<void> | void }>;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

/** A bot row the key jobs can attach to (the loader would write it; the job only needs the row to exist). */
async function makeBot(tx: Tx, slug: string): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, $3, 'a gateway-llm test bot', 'agent', 'hermes', 'team', $4, 'active') RETURNING id`,
    [omar.workspaceId, ENG, slug, 'a'.repeat(64)],
  );
  return res.rows[0]!.id;
}

const runJob = (queue: string, payload: Record<string, unknown>): Promise<void> =>
  sys(async (tx) => {
    const job = jobs.get(queue);
    if (!job) throw new Error(`no handler for ${queue}`);
    await job.handler(payload, tx as unknown as PluginTx, { jobId: 'job-1', attempt: 1, workerId: 'w', log: { info: () => undefined, warn: () => undefined } });
  });

beforeAll(async () => {
  delete process.env['MANYTHREADS_LITELLM_URL'];
  delete process.env['MANYTHREADS_LITELLM_MASTER_KEY'];
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, gatewayLlmMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  emitted = [];
  jobs = new Map();
  const registries = new ExtensionRegistries();
  ctx = createPluginContext(gatewayLlm.manifest, {
    registries,
    storage: createMemoryKv(),
    mail: { send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: async (_tx, event) => void emitted.push(event),
  });
  await gatewayLlm.register(ctx);
  for (const entry of registries.jobs.list()) {
    jobs.set(entry.value.queue, { handler: entry.value.handler as never });
  }
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(() => {
  emitted.length = 0;
});

describe('newBotKey', () => {
  it('is unguessable, sk-prefixed, and its stored head fits the row constraint', () => {
    const key = newBotKey();
    expect(key).toMatch(/^sk-[A-Za-z0-9_-]{32}$/);
    expect(keyPrefix(key)).toHaveLength(11);
    expect(keyPrefix(key)).toMatch(/^sk-[A-Za-z0-9_-]{8}$/);
    expect(newBotKey()).not.toBe(key);
  });
});

describe('the gateway queues', () => {
  it('registers the config, sync-key and reconcile queues under the plugin namespace', () => {
    expect([...jobs.keys()].sort()).toEqual(['gateway-llm.apply-config', 'gateway-llm.reconcile', 'gateway-llm.sync-key']);
  });
});

describe('mintBotKey / revokeBotKey', () => {
  it('mints once, stores the key as a secret, and revokes it with the bot', async () => {
    const { botId } = await sys(async (tx) => ({ botId: await makeBot(tx, 'mint-probe') }));

    const minted = await sys((tx) => mintBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId));
    expect(minted).toBe(true);
    // Idempotent: an event replay finds the live key and changes nothing.
    expect(await sys((tx) => mintBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe(false);

    const row = await sys(async (tx) =>
      (await tx.query<{ secret_id: string; key_prefix: string }>('SELECT secret_id, key_prefix FROM app.llm_keys WHERE bot_id = $1', [botId])).rows[0],
    );
    expect(row?.key_prefix).toMatch(/^sk-[A-Za-z0-9_-]{8}$/);
    const key = await sys((tx) => ctx.secrets.get(tx as unknown as PluginTx, row!.secret_id));
    expect(key).toMatch(/^sk-[A-Za-z0-9_-]{32}$/);
    expect(keyPrefix(key)).toBe(row?.key_prefix);
    expect(emitted.map((e) => e['type'])).toEqual(['llm.key.changed']);
    expect(emitted[0]?.['action']).toBe('minted');

    expect(await sys((tx) => revokeBotKey(ctx, tx as unknown as PluginTx, botId))).toBe(true);
    const gone = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1', [botId])).rows.length);
    expect(gone).toBe(0);
    // The secret went with the row: reading it now fails.
    await expect(sys((tx) => ctx.secrets.get(tx as unknown as PluginTx, row!.secret_id))).rejects.toThrow();
    expect(emitted.map((e) => e['type'])).toEqual(['llm.key.changed', 'llm.key.changed']);
    expect(emitted[1]?.['action']).toBe('revoked');
    // Revoking again is a no-op, not an error.
    expect(await sys((tx) => revokeBotKey(ctx, tx as unknown as PluginTx, botId))).toBe(false);
  });

  it('the sync-key job mints for a live bot and revokes for one that is gone', async () => {
    const botId = await sys((tx) => makeBot(tx, 'job-probe'));
    await runJob('gateway-llm.sync-key', { workspaceId: omar.workspaceId, botId, action: 'mint' });
    const live = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1 AND revoked_at IS NULL', [botId])).rows.length);
    expect(live).toBe(1);

    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [botId]));
    await runJob('gateway-llm.sync-key', { workspaceId: omar.workspaceId, botId, action: 'revoke' });
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1', [botId])).rows.length)).toBe(0);

    // A mint for a bot that no longer exists must not resurrect a key (the event can arrive after the delete).
    await runJob('gateway-llm.sync-key', { workspaceId: omar.workspaceId, botId, action: 'mint' });
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1', [botId])).rows.length)).toBe(0);
  });

  it('rejects a payload that is not the job it claims to be', async () => {
    await expect(runJob('gateway-llm.sync-key', { workspaceId: 'not-a-uuid', botId: 'x', action: 'mint' })).rejects.toThrow();
  });
});

describe('pushLlmConfig', () => {
  it('builds the document from the rows and records the applied counts with no proxy configured', async () => {
    const result = await sys(async (tx) => {
      const providerId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Test provider', 'openai') RETURNING id`,
          [omar.workspaceId],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'smart', $2, 'gpt-4o', '{fast}')`,
        [omar.workspaceId, providerId],
      );
      return pushLlmConfig(ctx, tx as unknown as PluginTx, omar.workspaceId);
    });
    expect(result).toEqual({ providers: 1, aliases: 1, fallbacks: 1, pushed: false });
    const event = emitted.find((e) => e['type'] === 'llm.config.applied');
    expect(event?.['providers']).toBe(1);
    expect(event?.['fallbacks']).toBe(1);
  });
});
