import { createAppPool, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, createMemoryKv, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginEvent, PluginTx } from '@manythreads/sdk';
import { LlmBudgetExceededEvent, LlmGuardDecidedEvent, type LlmAliasName } from '@manythreads/shared';
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
import { spendSummary, type LlmCallDecision, type LlmCallRequest } from '../src/limits.ts';
import type { LlmProviderServices } from '../src/provider.ts';

// P5-07 against a real database, through the `provider.llm` door a runtime uses: the preset's egress rule, the pre-call
// DLP hook, the budgets and rate limits of every scope, the two guard events in their stored shape, and the spend
// ledger. No proxy and no model: the check is what happens *before* a call.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let emitted: PluginEvent[];
let gateway: LlmProviderServices;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

/** A bot row (the loader would write it; the limits only need the id to exist). */
async function makeBot(tx: Tx, slug: string): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, $3, 'a gateway-llm preflight bot', 'agent', 'hermes', 'team', $4, 'active') RETURNING id`,
    [omar.workspaceId, ENG, slug, 'a'.repeat(64)],
  );
  return res.rows[0]!.id;
}

const call = (botId: string, over: Partial<LlmCallRequest> = {}): LlmCallRequest => ({
  workspaceId: omar.workspaceId,
  botId,
  teamId: ENG,
  sessionId: null,
  alias: 'smart' as LlmAliasName,
  text: 'how do I rotate the deploy key?',
  ...over,
});

const check = (request: LlmCallRequest): Promise<LlmCallDecision> => sys((tx) => gateway.preflight(tx as unknown as PluginTx, request));

beforeAll(async () => {
  delete process.env['MANYTHREADS_LITELLM_URL'];
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, gatewayLlmMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  emitted = [];
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
  gateway = ctx.providers.get<LlmProviderServices>('llm')!;
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(() => {
  emitted.length = 0;
});

describe('the provider.llm door', () => {
  it('is registered by the plugin and answers the config half too', () => {
    expect(gateway.id).toBe('gateway-llm');
    expect(typeof gateway.preflight).toBe('function');
    expect(typeof gateway.recordSpend).toBe('function');
  });
});

describe('preflight: allow', () => {
  it('lets a plain call through with the default settings and nothing to pay', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-clean'));
    const decision = await check(call(botId));
    expect(decision).toEqual({
      allowed: true,
      reason: null,
      message: null,
      outcome: 'allow',
      preset: 'standard',
      text: 'how do I rotate the deploy key?',
      rules: [],
      retryAfterMs: null,
      limit: null,
      spentUsd: null,
    });
    expect(emitted).toEqual([]);
  });

  it('redacts under standard and still allows the call', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-redact'));
    const decision = await check(call(botId, { text: 'my key is sk-abcdefghijklmnopqrstuvwx' }));
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe('redact');
    expect(decision.text).toBe('my key is [redacted:api-key]');
    const guard = emitted.find((e) => e['type'] === 'llm.guard.decided');
    expect(LlmGuardDecidedEvent.parse(guard)).toMatchObject({ outcome: 'redact', rules: ['api-key'], preset: 'standard', reason: null });
  });
});

describe('preflight: budgets', () => {
  it('refuses once the workspace budget is spent, and records why', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-budget'));
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]);
      await tx.query(
        `INSERT INTO app.llm_spend (workspace_id, bot_id, alias, cost_usd) VALUES ($1, $2, 'smart', 1.5)`,
        [omar.workspaceId, botId],
      );
    });
    const decision = await check(call(botId));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('budget');
    expect(decision.limit?.scope).toBe('workspace');
    expect(decision.spentUsd).toBe(1.5);
    const event = emitted.find((e) => e['type'] === 'llm.budget.exceeded');
    expect(LlmBudgetExceededEvent.parse(event)).toMatchObject({
      scope: 'workspace',
      reason: 'budget',
      limitUsd: 1,
      spentUsd: 1.5,
      botId,
      alias: 'smart',
    });
    await sys((tx) => tx.query(`DELETE FROM app.llm_limits WHERE workspace_id = $1`, [omar.workspaceId]));
  });

  it('counts a session against the session budget only, and only for that session', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-session'));
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'session', $2, 0.5)`, [
        omar.workspaceId,
        botId,
      ]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, bot_id, session_id, alias, cost_usd) VALUES ($1, $2, 'conv-1', 'smart', 0.5)`, [
        omar.workspaceId,
        botId,
      ]);
    });
    expect((await check(call(botId, { sessionId: 'conv-1' }))).reason).toBe('budget');
    expect((await check(call(botId, { sessionId: 'conv-2' }))).allowed).toBe(true);
    // A call with no session at all has nothing to spend against, so the session budget does not apply to it.
    expect((await check(call(botId))).allowed).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.llm_limits WHERE bot_id = $1`, [botId]));
  });

  it('a limit that only caps the rate is not a budget', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-rate-only'));
    await sys((tx) =>
      tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, requests_per_minute) VALUES ($1, 'bot', $2, 100)`, [
        omar.workspaceId,
        botId,
      ]),
    );
    const decision = await check(call(botId));
    expect(decision.allowed).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.llm_limits WHERE bot_id = $1`, [botId]));
  });
});

describe('preflight: rate limits', () => {
  it('refuses the call past the limit and answers a retry-after, narrowest scope first', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-rate'));
    await sys((tx) =>
      tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, requests_per_minute) VALUES ($1, 'bot', $2, 2)`, [
        omar.workspaceId,
        botId,
      ]),
    );
    const first = await check(call(botId));
    expect(first.allowed).toBe(true);
    expect((await check(call(botId))).allowed).toBe(true);
    const refused = await check(call(botId));
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('rate');
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.limit?.scope).toBe('bot');
    const event = emitted.find((e) => e['type'] === 'llm.budget.exceeded');
    expect(LlmBudgetExceededEvent.parse(event)).toMatchObject({ scope: 'bot', reason: 'rate', requestsPerMinute: 2 });
    await sys((tx) => tx.query(`DELETE FROM app.llm_limits WHERE bot_id = $1`, [botId]));
  });

  it('does not count a call it refused', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-rate-quiet'));
    await sys((tx) =>
      tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, requests_per_minute) VALUES ($1, 'bot', $2, 1)`, [
        omar.workspaceId,
        botId,
      ]),
    );
    expect((await check(call(botId))).allowed).toBe(true);
    const refused = await check(call(botId));
    expect(refused.allowed).toBe(false);
    // The bucket still holds one accepted call, so a second refusal answers the rest of that same window (never a fresh
    // one): the retry-after only shrinks as the window drains.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    const again = await check(call(botId));
    expect(again.allowed).toBe(false);
    expect(again.retryAfterMs).toBeGreaterThan(0);
    expect(again.retryAfterMs).toBeLessThan(refused.retryAfterMs!);
    await sys((tx) => tx.query(`DELETE FROM app.llm_limits WHERE bot_id = $1`, [botId]));
  });
});

describe('preflight: presets and the pre-call hook', () => {
  it('air-gapped refuses everything but the local alias', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-air'));
    await sys((tx) => tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'air-gapped')`, [omar.workspaceId]));
    const refused = await check(call(botId));
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('preset');
    expect(refused.outcome).toBe('block');
    expect(LlmGuardDecidedEvent.parse(emitted.find((e) => e['type'] === 'llm.guard.decided'))).toMatchObject({
      preset: 'air-gapped',
      outcome: 'block',
      reason: 'preset',
      alias: 'smart',
    });
    const local = await check(call(botId, { alias: 'local' as LlmAliasName }));
    expect(local.allowed).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.llm_settings WHERE workspace_id = $1`, [omar.workspaceId]));
  });

  it('strict-egress needs the host on the allowlist', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-strict'));
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'strict-egress')`, [omar.workspaceId]);
      await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, model) VALUES ($1, 'smart', 'openai/gpt-4o')`, [omar.workspaceId]);
    });
    const refused = await check(call(botId));
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain('api.openai.com');
    await sys((tx) => tx.query(`UPDATE app.llm_settings SET egress_allowlist = '{api.openai.com}' WHERE workspace_id = $1`, [omar.workspaceId]));
    expect((await check(call(botId))).allowed).toBe(true);
    await sys(async (tx) => {
      await tx.query(`DELETE FROM app.llm_settings WHERE workspace_id = $1`, [omar.workspaceId]);
      await tx.query(`DELETE FROM app.llm_aliases WHERE workspace_id = $1 AND alias = 'smart'`, [omar.workspaceId]);
    });
  });

  it('customer-facing refuses the call rather than redacting it', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-customer'));
    await sys((tx) => tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'customer-facing')`, [omar.workspaceId]));
    const refused = await check(call(botId, { text: 'card 4111111111111111' }));
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('dlp');
    expect(refused.outcome).toBe('block');
    expect(refused.rules).toEqual(['card-number']);
    expect(LlmGuardDecidedEvent.parse(emitted.find((e) => e['type'] === 'llm.guard.decided'))).toMatchObject({
      preset: 'customer-facing',
      outcome: 'block',
      rules: ['card-number'],
      reason: 'dlp',
    });
    await sys((tx) => tx.query(`DELETE FROM app.llm_settings WHERE workspace_id = $1`, [omar.workspaceId]));
  });
});

describe('recordSpend', () => {
  it('appends a line only the system role may write, and the summary counts it', async () => {
    const botId = await sys((tx) => makeBot(tx, 'preflight-ledger'));
    const id = await sys((tx) =>
      gateway.recordSpend(tx as unknown as PluginTx, {
        workspaceId: omar.workspaceId,
        teamId: ENG,
        botId,
        sessionId: 'conv-9',
        runId: null,
        alias: 'smart',
        model: 'openai/gpt-4o',
        promptTokens: 1_200,
        completionTokens: 300,
        costUsd: 0.042,
      }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const summary = await sys((tx) =>
      spendSummary(tx as unknown as PluginTx, omar.workspaceId, { since: new Date(0), until: new Date(Date.now() + 60_000) }),
    );
    // The summary covers the whole workspace, so earlier tests' lines are in it too; this call's own row is exact.
    expect(summary.calls).toBeGreaterThanOrEqual(1);
    expect(summary.totalUsd).toBeGreaterThanOrEqual(0.042);
    expect(summary.byBot.find((row) => row.botId === botId)).toMatchObject({ spentUsd: 0.042, calls: 1 });
    // Append-only: the system role holds an UPDATE grant (the default privileges of new tables) but no policy grants
    // UPDATE on this table, so the statement changes nothing rather than changing a line of the ledger.
    const changed = await sys((tx) => tx.query(`UPDATE app.llm_spend SET cost_usd = 0 WHERE id = $1 RETURNING id`, [id]));
    expect(changed.rows).toEqual([]);
    const line = await sys((tx) =>
      tx.query<{ cost_usd: string }>('SELECT cost_usd FROM app.llm_spend WHERE id = $1', [id]),
    );
    expect(Number(line.rows[0]?.cost_usd)).toBeCloseTo(0.042, 6);
  });
});
