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
import { botKeyModels, forgetBootHeal, forgetKeyChecks, keyPrefix, mintBotKey, newBotKey, requestKeyCheck, revokeBotKey, syncBotKey } from '../src/keys.ts';
import { configFingerprint } from '../src/config.ts';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';

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
async function makeBot(tx: Tx, slug: string, modelAliases: string[] = ['smart']): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, model_aliases)
     VALUES ($1, $2, $3, $3, 'a gateway-llm test bot', 'agent', 'hermes', 'team', $4, 'active', $5) RETURNING id`,
    [omar.workspaceId, ENG, slug, 'a'.repeat(64), modelAliases],
  );
  return res.rows[0]!.id;
}

/** Bind aliases (replacing what was bound) with no provider: a bare prefixed model needs none. `fallbacks` maps alias to its chain. */
async function bind(aliases: string[], fallbacks: Record<string, string[]> = {}): Promise<void> {
  await sys(async (tx) => {
    await tx.query('DELETE FROM app.llm_aliases WHERE workspace_id = $1', [omar.workspaceId]);
    for (const alias of aliases) {
      await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, $2, NULL, $3, $4)`, [
        omar.workspaceId,
        alias,
        `openai/model-${alias}`,
        fallbacks[alias] ?? [],
      ]);
    }
  });
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
    // Slow on purpose: an emit the caller does not await lands after the call returned, and the assertions below catch it.
    emit: async (_tx, event) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      emitted.push(event);
    },
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
  it('registers the config, sync-key, reconcile and boot-heal queues under the plugin namespace', () => {
    expect([...jobs.keys()].sort()).toEqual(['gateway-llm.apply-config', 'gateway-llm.boot-heal', 'gateway-llm.reconcile', 'gateway-llm.sync-key']);
  });
});

describe('mintBotKey / revokeBotKey', () => {
  it('mints once, stores the key as a secret, and revokes it with the bot', async () => {
    await bind(['smart']);
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
    await bind(['smart']);
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
    await bind([]);
    const result = await sys(async (tx) => {
      const providerId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Test provider', 'openai') RETURNING id`,
          [omar.workspaceId],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'smart', $2, 'gpt-4o', '{fast,code}'), ($1, 'fast', $2, 'gpt-4o-mini', '{}')`,
        [omar.workspaceId, providerId],
      );
      return pushLlmConfig(ctx, tx as unknown as PluginTx, omar.workspaceId);
    });
    // `code` is not bound, so the chain keeps only `fast`: a fallback to an alias the proxy lacks would fail the call it rescues
    expect(result).toEqual({ providers: 2, aliases: 2, fallbacks: 1, pushed: false });
    const event = emitted.find((e) => e['type'] === 'llm.config.applied');
    expect(event?.['providers']).toBe(2);
    expect(event?.['fallbacks']).toBe(1);
  });
});

describe('concurrent syncs of one bot', () => {
  it('mint one key and one secret, not one each (the second waits on the per-bot lock and finds the first\'s row)', async () => {
    await bind(['smart']);
    const botId = await sys((tx) => makeBot(tx, 'race-probe', ['smart']));
    const secretsBefore = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);

    // Two separate transactions at once, as two workers would run them.
    const results = await Promise.all([
      sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId)),
      sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId)),
    ]);
    expect([...results].sort()).toEqual(['minted', 'unchanged']);

    const keys = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1 AND revoked_at IS NULL', [botId])).rows.length);
    expect(keys).toBe(1);
    const secretsAfter = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    expect(secretsAfter - secretsBefore).toBe(1); // no orphaned secret
    expect(emitted.filter((e) => e['action'] === 'minted')).toHaveLength(1);
  });
});

describe('which aliases a bot\'s key covers', () => {
  const keyRow = (botId: string) =>
    sys(async (tx) => (await tx.query<{ models: string[]; revoked_at: Date | null }>('SELECT models, revoked_at FROM app.llm_keys WHERE bot_id = $1', [botId])).rows[0]);

  it('is the bot\'s own aliases and their fallback chains — not every alias the workspace has bound', async () => {
    await bind(['smart', 'fast', 'code', 'local'], { smart: ['fast'], fast: ['local'] });
    const botId = await sys((tx) => makeBot(tx, 'scoped-probe', ['smart']));
    expect(await sys((tx) => botKeyModels(tx as unknown as PluginTx, omar.workspaceId, botId))).toEqual(['smart', 'fast', 'local']);
    // an alias nobody bound is not offered, whatever the definition asks
    const other = await sys((tx) => makeBot(tx, 'unbound-probe', ['smart', 'vision']));
    expect(await sys((tx) => botKeyModels(tx as unknown as PluginTx, omar.workspaceId, other))).toEqual(['smart', 'fast', 'local']);
  });

  it('is never empty: with nothing bound the bot gets no key at all, and gets one when an alias is bound', async () => {
    await bind([]);
    const botId = await sys((tx) => makeBot(tx, 'nothing-bound', ['smart']));
    expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('skipped');
    expect(await keyRow(botId)).toBeUndefined();

    await bind(['smart']);
    await runPush(); // the config push is what notices the new alias
    expect((await keyRow(botId))?.models).toEqual(['smart']);
  });

  it('follows the alias set: a config push updates the key, and unbinding the last alias takes the key away', async () => {
    await bind(['smart']);
    const botId = await sys((tx) => makeBot(tx, 'follow-probe', ['smart', 'fast']));
    expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('minted');
    expect((await keyRow(botId))?.models).toEqual(['smart']);
    expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('unchanged');

    await bind(['smart', 'fast']);
    await runPush();
    expect((await keyRow(botId))?.models).toEqual(['smart', 'fast']);
    expect(emitted.filter((e) => e['action'] === 'updated')).toHaveLength(1);

    await bind([]);
    await runPush();
    expect(await keyRow(botId)).toBeUndefined();
    expect(emitted.at(-2)?.['action']).toBe('revoked');
  });

  async function runPush(): Promise<unknown> {
    return runJob('gateway-llm.apply-config', { workspaceId: omar.workspaceId });
  }
});

describe('against a proxy', () => {
  let fake: FakeLlm;
  beforeAll(async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
    process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  });
  afterAll(async () => {
    delete process.env['MANYTHREADS_LITELLM_URL'];
    delete process.env['MANYTHREADS_LITELLM_MASTER_KEY'];
    await fake.close();
  });

  it('registers the key with exactly the bot\'s aliases, and /key/update follows the set', async () => {
    await bind(['smart', 'fast', 'code'], { smart: ['fast'] });
    const botId = await sys((tx) => makeBot(tx, 'proxy-probe', ['smart']));
    expect(await sys((tx) => mintBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe(true);
    const registered = [...fake.state.keys.values()].find((k) => k.metadata['manythreads_bot'] === botId);
    expect(registered?.models).toEqual(['smart', 'fast']); // not `code`: the workspace's other alias is not this bot's
    expect([...fake.state.keys.values()].every((k) => k.models.length > 0)).toBe(true); // the proxy reads [] as "every model"

    await sys((tx) => tx.query('UPDATE app.bots SET model_aliases = $2 WHERE id = $1', [botId, ['smart', 'code']]));
    expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('updated');
    expect([...fake.state.keys.values()].find((k) => k.metadata['manythreads_bot'] === botId)?.models).toEqual(['smart', 'fast', 'code']);
    expect(fake.state.calls.some((c) => c.path === '/key/update')).toBe(true);
  });

  it('a config pushed while another is being applied is not lost: the job queues one follow-up', async () => {
    await bind(['smart']);
    const before = await sys(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'gateway-llm.apply-config'")).rows[0]!.n);
    // The admin edits an alias in the middle of the push (after the job read its rows, before it finished).
    let edited = false;
    const original = fake;
    const racing = await startFakeLlm({
      masterKey: 'sk-fake',
      beforeRespond: async (call) => {
        if (call.path !== '/config/update' || edited) return;
        edited = true;
        await sys((tx) => tx.query(`UPDATE app.llm_aliases SET model = 'openai/model-changed', updated_at = now() WHERE workspace_id = $1 AND alias = 'smart'`, [omar.workspaceId]));
      },
    });
    process.env['MANYTHREADS_LITELLM_URL'] = racing.url;
    try {
      await runJob('gateway-llm.apply-config', { workspaceId: omar.workspaceId });
    } finally {
      process.env['MANYTHREADS_LITELLM_URL'] = original.url;
      await racing.close();
    }
    expect(edited).toBe(true);
    const after = await sys(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'gateway-llm.apply-config'")).rows[0]!.n);
    expect(after).toBe(before + 1);
    // And with nothing changing during a push, nothing is queued.
    await runJob('gateway-llm.apply-config', { workspaceId: omar.workspaceId });
    const quiet = await sys(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'gateway-llm.apply-config'")).rows[0]!.n);
    expect(quiet).toBe(after);
    expect(await sys((tx) => configFingerprint(tx as unknown as PluginTx, omar.workspaceId))).toHaveLength(32);
  });
  describe('a proxy that lost its keys (replaced, or its database wiped)', () => {
    const keyOf = async (botId: string): Promise<string> =>
      sys(async (tx) => {
        const row = (await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.llm_keys WHERE bot_id = $1', [botId])).rows[0]!;
        return ctx.secrets.get(tx as unknown as PluginTx, row.secret_id);
      });

    it('sync registers the SAME key again when the proxy does not know it, and leaves a known key alone', async () => {
      await bind(['smart']);
      const botId = await sys((tx) => makeBot(tx, 'lost-key', ['smart']));
      expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('minted');
      const key = await keyOf(botId);
      expect(fake.state.keys.has(key)).toBe(true);
      // the proxy knows it: nothing to do
      expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('unchanged');

      fake.state.keys.delete(key); // the proxy is replaced
      expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('healed');
      expect(fake.state.keys.get(key)?.models).toEqual(['smart']);
      expect(await keyOf(botId)).toBe(key); // not rotated: the runtime and the proxy agree on the value they already had
      expect(await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId))).toBe('unchanged');
    });

    it('the daily reconcile heals every active bot, one proxy call each', async () => {
      await bind(['smart']);
      const a = await sys((tx) => makeBot(tx, 'heal-a', ['smart']));
      const b = await sys((tx) => makeBot(tx, 'heal-b', ['smart']));
      for (const id of [a, b]) await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, id));
      const keys = [await keyOf(a), await keyOf(b)];
      fake.state.keys.clear();
      fake.state.calls.length = 0;
      await runJob('gateway-llm.reconcile', {});
      for (const k of keys) expect(fake.state.keys.has(k)).toBe(true);
      const perKey = fake.state.calls.filter((c) => c.path === '/key/update' || c.path === '/key/generate');
      expect(perKey.filter((c) => c.path === '/key/update').length).toBeGreaterThanOrEqual(2);
    });

    it('the boot heal does the reconcile once per process start, then does nothing', async () => {
      await bind(['smart']);
      const botId = await sys((tx) => makeBot(tx, 'boot-heal', ['smart']));
      await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId));
      const key = await keyOf(botId);
      fake.state.keys.clear();
      forgetBootHeal();
      await runJob('gateway-llm.boot-heal', {});
      expect(fake.state.keys.has(key)).toBe(true);
      fake.state.keys.clear();
      fake.state.calls.length = 0;
      await runJob('gateway-llm.boot-heal', {}); // already healed in this process: no proxy call at all
      expect(fake.state.calls).toEqual([]);
      expect(fake.state.keys.has(key)).toBe(false);
    });

    it('a revoke racing a sync leaves no key at the proxy and no row (both take the per-bot lock)', async () => {
      await bind(['smart']);
      const botId = await sys((tx) => makeBot(tx, 'race-revoke', ['smart']));
      await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId));
      const key = await keyOf(botId);
      fake.state.keys.delete(key); // the sync below will have to re-register it
      const slow = await startFakeLlm({
        masterKey: 'sk-fake',
        beforeRespond: async (call) => {
          if (call.path === '/key/update') await new Promise((r) => setTimeout(r, 400));
        },
      });
      const was = process.env['MANYTHREADS_LITELLM_URL'];
      process.env['MANYTHREADS_LITELLM_URL'] = slow.url;
      try {
        const syncing = sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId));
        await new Promise((r) => setTimeout(r, 150)); // the sync holds the lock and is waiting on the proxy
        const revoking = sys((tx) => revokeBotKey(ctx, tx as unknown as PluginTx, botId));
        await Promise.all([syncing, revoking]);
        expect(slow.state.keys.has(key)).toBe(false);
        expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.llm_keys WHERE bot_id = $1', [botId])).rows.length)).toBe(0);
      } finally {
        process.env['MANYTHREADS_LITELLM_URL'] = was;
        await slow.close();
      }
    });

    it('one bot that cannot be synced does not stop the others, and the boot heal stays armed', async () => {
      await bind(['smart']);
      const bad = await sys((tx) => makeBot(tx, 'heal-bad', ['smart']));
      const good = await sys((tx) => makeBot(tx, 'heal-good', ['smart']));
      for (const id of [bad, good]) await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, id));
      const badKey = await keyOf(bad);
      const goodKey = await keyOf(good);
      fake.state.keys.clear();
      const failing = await startFakeLlm({
        masterKey: 'sk-fake',
        beforeRespond: (call) => {
          const b = call.body as { key?: string } | null;
          if (call.path === '/key/update' && b?.key === badKey) throw new Error('boom');
        },
      });
      const was = process.env['MANYTHREADS_LITELLM_URL'];
      process.env['MANYTHREADS_LITELLM_URL'] = failing.url;
      try {
        forgetBootHeal();
        await runJob('gateway-llm.boot-heal', {});
        expect(failing.state.keys.has(goodKey)).toBe(true);
        failing.state.calls.length = 0;
        await runJob('gateway-llm.boot-heal', {}); // not marked done: it tries again
        expect(failing.state.calls.length).toBeGreaterThan(0);
      } finally {
        process.env['MANYTHREADS_LITELLM_URL'] = was;
        await failing.close();
      }
    });

    it('a bot that is not active gets no key check', async () => {
      const botId = await sys((tx) => makeBot(tx, 'inactive-check', ['smart']));
      await sys((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [botId]));
      forgetKeyChecks();
      expect(await sys((tx) => requestKeyCheck(ctx, tx as unknown as PluginTx, botId))).toBe(false);
    });

    it('a 401 reported for a bot queues one sync (deduplicated, rate-limited), and running it heals the key', async () => {
      await bind(['smart']);
      const botId = await sys((tx) => makeBot(tx, 'rejected-key', ['smart']));
      await sys((tx) => syncBotKey(ctx, tx as unknown as PluginTx, omar.workspaceId, botId));
      const key = await keyOf(botId);
      fake.state.keys.clear();
      forgetKeyChecks();
      const queued = (): Promise<number> =>
        sys(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'gateway-llm.sync-key' AND payload ->> 'botId' = $1", [botId])).rows[0]!.n);
      const before = await queued();
      expect(await sys((tx) => requestKeyCheck(ctx, tx as unknown as PluginTx, botId))).toBe(true);
      expect(await sys((tx) => requestKeyCheck(ctx, tx as unknown as PluginTx, botId))).toBe(false); // cooldown
      forgetKeyChecks();
      await sys((tx) => requestKeyCheck(ctx, tx as unknown as PluginTx, botId)); // dedupe key: still the one waiting
      expect((await queued()) - before).toBe(1);
      await runJob('gateway-llm.sync-key', { workspaceId: omar.workspaceId, botId, action: 'mint' });
      expect(fake.state.keys.has(key)).toBe(true);
    });
  });

});
