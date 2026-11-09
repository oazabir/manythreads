import { randomUUID } from 'node:crypto';
import { createAppPool, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, createMemoryKv, withSystem, type Tx } from '@manythreads/kernel';
import { setTraceBridge, type PluginEvent, type PluginTx, type SpanAttributes, type TraceBridge } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  gatewayLlmMigrationSource,
  guardrailsDlpMigrationSource,
  guardrailsEgressMigrationSource,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import guardrailsDlp from '../../guardrails-dlp/src/index.ts';
import guardrailsEgress from '../../guardrails-egress/src/index.ts';
import gatewayLlm from '../src/index.ts';
import type { LlmChatRequest } from '../src/chat.ts';
import type { LlmProviderServices } from '../src/provider.ts';

// P19-10: one turn of a bot's run on an LLM gateway runner, through the `provider.llm` door and a proxy stand-in. What it proves: the model's text or tool call comes back, the call is the
// platform's (master key, tagged with the bot and the run), the spend lands in the ledger under the bot and the run, a budget refusal sends nothing, and an alias that is not bound is
// answered, never thrown.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;
const SAVED = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

type Answer = string | { status: number; body: unknown };
let answer: Answer = 'plain answer';
/** Runs inside the proxy stand-in while a call is being answered. */
let whileCalling: (() => void) | null = null;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let fake: FakeLlm;
let emitted: PluginEvent[];
let gateway: LlmProviderServices;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

async function makeBot(tx: Tx, slug: string): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, $3, 'a gateway-llm chat bot', 'agent', 'hermes', 'team', $4, 'active') RETURNING id`,
    [omar.workspaceId, ENG, slug, 'a'.repeat(64)],
  );
  return res.rows[0]!.id;
}

const request = (botId: string, over: Partial<LlmChatRequest> = {}): LlmChatRequest => ({
  workspaceId: omar.workspaceId,
  botId,
  teamId: ENG,
  runId: randomUUID(),
  alias: 'smart',
  messages: [
    { role: 'system', content: 'You answer from the team notes.' },
    { role: 'user', content: 'what did we decide about pricing?' },
  ],
  tools: [],
  maxTokens: 256,
  firstTurn: true,
  checkedUpTo: 0,
  ...over,
});

// What the run job passes: a way to open a short system transaction for each step, not a transaction.
const opened = { count: 0 };
const turn = (r: LlmChatRequest) =>
  gateway.chat((fn) => {
    opened.count += 1;
    return sys((tx) => fn(tx as unknown as PluginTx));
  }, r);
const chatCalls = () => fake.state.calls.filter((c) => c.path === '/chat/completions');
const spendOf = (runId: string) =>
  sys(async (tx) =>
    (await tx.query<{ bot_id: string; team_id: string; alias: string; prompt_tokens: number; completion_tokens: number; cost_usd: string; session_id: string }>('SELECT bot_id, team_id, alias, prompt_tokens, completion_tokens, cost_usd, session_id FROM app.llm_spend WHERE run_id = $1', [runId])).rows,
  );

beforeAll(async () => {
  fake = await startFakeLlm({ masterKey: 'sk-fake', completion: () => {
      whileCalling?.();
      return answer;
    },
  });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, gatewayLlmMigrationSource, guardrailsDlpMigrationSource, guardrailsEgressMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  emitted = [];
  const deps = {
    registries: new ExtensionRegistries(),
    storage: createMemoryKv(),
    mail: { configured: true, send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: async (_tx: unknown, event: PluginEvent) => void emitted.push(event),
  };
  for (const guardrail of [guardrailsEgress, guardrailsDlp]) await guardrail.register(createPluginContext(guardrail.manifest, deps));
  const ctx = createPluginContext(gatewayLlm.manifest, deps);
  await gatewayLlm.register(ctx);
  gateway = ctx.providers.get<LlmProviderServices>('llm')!;
  // The workspace's `smart` alias is bound to a provider and a model (the proxy stand-in answers whatever it is asked).
  await sys(async (tx) => {
    const provider = (await tx.query<{ id: string }>(`INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'OpenAI', 'openai') RETURNING id`, [omar.workspaceId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'smart', $2, 'gpt-4o', '{}')`, [omar.workspaceId, provider]);
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
  await fake?.close();
  for (const [name, value] of [
    ['MANYTHREADS_LITELLM_URL', SAVED.url],
    ['MANYTHREADS_LITELLM_MASTER_KEY', SAVED.key],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  emitted.length = 0;
  answer = 'plain answer';
  whileCalling = null;
  opened.count = 0;
});

describe('provider.llm chat (one turn of a model-runtime run)', () => {
  it('answers with the model\'s text, makes the call with the master key tagged with the bot and the run, and records the spend under the bot and the run', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-text'));
    const r = request(botId);
    const before = chatCalls().length;
    const result = await turn(r);
    expect(result).toMatchObject({ ok: true, text: 'plain answer', toolCalls: [], promptTokens: 12, completionTokens: 7, truncated: false });
    const calls = chatCalls();
    expect(calls).toHaveLength(before + 1);
    const sent = calls.at(-1)!.body as { model: string; metadata: Record<string, string>; messages: Array<{ role: string }> };
    expect(sent.model).toBe('smart');
    expect(sent.metadata).toMatchObject({ manythreads_bot: botId, manythreads_run: r.runId, manythreads_workspace: omar.workspaceId, purpose: 'run' });
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const rows = await spendOf(r.runId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bot_id: botId, team_id: ENG, alias: 'smart', prompt_tokens: 12, completion_tokens: 7, session_id: r.runId });
    expect(Number(rows[0]!.cost_usd)).toBe(0);
  });

  it('with tracing on, the turn is an `llm.chat` span of ids only and the call to the proxy carries the trace parent; with it off no header is added', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-trace'));
    const spans: Array<{ name: string; attributes: SpanAttributes }> = [];
    const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const stub: TraceBridge = {
      span: (name, attributes, fn) => {
        spans.push({ name, attributes });
        return fn();
      },
      root: (_name, _attributes, fn) => fn(),
      request: () => undefined,
      headers: () => ({ traceparent: TRACEPARENT }),
      traceId: () => undefined,
    };
    const seen: Array<Record<string, string>> = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/chat/completions')) seen.push({ ...(init?.headers as Record<string, string>) });
      return realFetch(input, init);
    });
    try {
      setTraceBridge(stub);
      const r = request(botId);
      expect((await turn(r)).ok).toBe(true);
      expect(spans.map((x) => x.name)).toContain('llm.chat');
      const span = spans.find((x) => x.name === 'llm.chat')!;
      expect(span.attributes).toMatchObject({ 'mt.llm.alias': 'smart', 'mt.run_id': r.runId, 'mt.bot_id': botId });
      // Ids, counts and kinds only: no message text.
      expect(JSON.stringify(span.attributes)).not.toMatch(/pricing|team notes/);
      expect(seen.at(-1)?.['traceparent']).toBe(TRACEPARENT);
      setTraceBridge(null);
      seen.length = 0;
      expect((await turn(request(botId))).ok).toBe(true);
      expect(seen.at(-1)).toBeDefined();
      expect(seen.at(-1)).not.toHaveProperty('traceparent');
    } finally {
      setTraceBridge(null);
      spy.mockRestore();
    }
  });

  it('offers the tools in the OpenAI form and returns the tool call the model asks for', async () => {
    answer = {
      status: 200,
      body: {
        id: 'chatcmpl-1',
        model: 'smart',
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'brain.search', arguments: '{"query":"pricing"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 },
      },
    };
    const botId = await sys((tx) => makeBot(tx, 'chat-tool'));
    const r = request(botId, { tools: [{ name: 'brain.search', description: 'Search the notes', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] });
    const result = await turn(r);
    expect(result).toMatchObject({ ok: true, text: null, toolCalls: [{ id: 'call_9', name: 'brain.search', arguments: '{"query":"pricing"}' }], promptTokens: 30, completionTokens: 9 });
    const sent = chatCalls().at(-1)!.body as { tools: Array<{ type: string; function: { name: string; parameters: unknown } }>; tool_choice: string };
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0]).toMatchObject({ type: 'function', function: { name: 'brain.search' } });
    expect(sent.tool_choice).toBe('auto');
    expect(await spendOf(r.runId!)).toHaveLength(1);
  });

  it('sends a tool answer back as a tool message tied to the call, and each turn is its own spend line under the same run', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-two-turns'));
    const first = request(botId);
    await turn(first);
    await turn({
      ...first,
      firstTurn: false,
      checkedUpTo: first.messages.length,
      messages: [
        ...first.messages,
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_9', name: 'brain.search', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_9', content: 'Pricing is per seat.' },
      ],
    });
    const sent = chatCalls().at(-1)!.body as { messages: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown[] }> };
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(sent.messages[2]!.tool_calls).toHaveLength(1);
    expect(sent.messages[3]!.tool_call_id).toBe('call_9');
    expect(await spendOf(first.runId!)).toHaveLength(2);
  });

  it('refuses without sending anything when a budget is spent, writes no spend line, and says why in the decision', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-budget'));
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'bot', $2, 1)`, [omar.workspaceId, botId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, bot_id, alias, cost_usd) VALUES ($1, $2, 'smart', 2)`, [omar.workspaceId, botId]);
    });
    const r = request(botId);
    const before = chatCalls().length;
    const result = await turn(r);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    if (!result.ok && result.reason === 'refused') expect(result.decision.reason).toBe('budget');
    expect(chatCalls()).toHaveLength(before);
    expect(await spendOf(r.runId!)).toHaveLength(0);
    expect(emitted.some((e) => e['type'] === 'llm.budget.exceeded')).toBe(true);
  });

  const SECRET = 'sk-abcdefghijklmnopqrstuvwx';

  it('redacts a secret in the prompt before it leaves, hands the redacted history back, and does not send the secret again on the next turn', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-redact'));
    const first = request(botId, {
      messages: [
        { role: 'system', content: 'You answer from the team notes.' },
        { role: 'user', content: `my key is ${SECRET}, is that fine?` },
      ],
    });
    const one = await turn(first);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    let sent = chatCalls().at(-1)!.body as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[1]!.content).toBe('my key is [redacted:api-key], is that fine?');
    expect(sent.messages[0]!.content).toBe('You answer from the team notes.');
    // The caller keeps the history it is handed back (same length, same order), not the one it sent.
    expect(one.messages).toHaveLength(2);
    expect(one.messages[1]!.content).toBe('my key is [redacted:api-key], is that fine?');
    expect(first.messages[1]!.content).toContain(SECRET);

    // Turn two: the history is the redacted one plus the call and its answer. Nothing in the call carries the secret, and the earlier messages are not checked again.
    const two = await turn({
      ...first,
      firstTurn: false,
      checkedUpTo: one.messages.length,
      messages: [...one.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'brain.search', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c1', content: 'nothing found' }],
    });
    expect(two.ok).toBe(true);
    sent = chatCalls().at(-1)!.body as { messages: Array<{ role: string; content: string }> };
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(sent.messages[1]!.content).toBe('my key is [redacted:api-key], is that fine?');
  });

  it('checks and redacts every tool answer added since the last turn, not only the last one (parallel tool calls)', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-parallel'));
    const base = request(botId);
    const result = await turn({
      ...base,
      firstTurn: false,
      checkedUpTo: base.messages.length,
      messages: [
        ...base.messages,
        { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'brain.search', arguments: '{}' }, { id: 'b', name: 'brain.search', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'a', content: `first note holds ${SECRET}` },
        { role: 'tool', toolCallId: 'b', content: 'second note is clean' },
      ],
    });
    expect(result.ok).toBe(true);
    const sent = chatCalls().at(-1)!.body as { messages: Array<{ role: string; content: string }> };
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(sent.messages[3]!.content).toBe('first note holds [redacted:api-key]');
    expect(sent.messages[4]!.content).toBe('second note is clean');
    if (result.ok) expect(result.messages[3]!.content).toBe('first note holds [redacted:api-key]');
  });

  it('refuses a turn when a message it must check is refused, and sends nothing', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-refuse-late'));
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'bot', $2, 1)`, [omar.workspaceId, botId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, bot_id, alias, cost_usd) VALUES ($1, $2, 'smart', 2)`, [omar.workspaceId, botId]);
    });
    const base = request(botId);
    const before = chatCalls().length;
    const result = await turn({ ...base, firstTurn: false, checkedUpTo: 2, messages: [...base.messages, { role: 'tool', toolCallId: 'a', content: 'note' }] });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(chatCalls()).toHaveLength(before);
  });

  it('holds no database connection while the proxy is being called', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-no-tx'));
    let inUse = -1;
    whileCalling = () => {
      inUse = sysPool.totalCount - sysPool.idleCount;
    };
    const result = await turn(request(botId));
    expect(result.ok).toBe(true);
    expect(inUse).toBe(0);
    // The check and the spend line are two short steps; the call is between them.
    expect(opened.count).toBe(2);
  });

  it('says the text was cut off when the model stopped at the length limit', async () => {
    answer = { status: 200, body: { id: 'x', model: 'smart', choices: [{ message: { role: 'assistant', content: 'The decision was to' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 256 } } };
    const botId = await sys((tx) => makeBot(tx, 'chat-length'));
    expect(await turn(request(botId))).toMatchObject({ ok: true, text: 'The decision was to', truncated: true });
  });

  it('answers "unbound" for an alias the workspace has not bound, and for a name that is no alias, without calling the proxy', async () => {
    const botId = await sys((tx) => makeBot(tx, 'chat-unbound'));
    const before = chatCalls().length;
    expect(await turn(request(botId, { alias: 'fast' }))).toMatchObject({ ok: false, reason: 'unbound' });
    expect(await turn(request(botId, { alias: 'not-an-alias' }))).toMatchObject({ ok: false, reason: 'unbound' });
    expect(chatCalls()).toHaveLength(before);
  });

  it('answers "unavailable" with no spend line when the proxy fails, and the words carry nothing the proxy said', async () => {
    answer = { status: 500, body: { error: { message: 'upstream blew up with sk-secret-token-1234' } } };
    const botId = await sys((tx) => makeBot(tx, 'chat-down'));
    const r = request(botId);
    const result = await turn(r);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('sk-secret-token-1234');
    expect(await spendOf(r.runId!)).toHaveLength(0);
  });

  it('answers "unavailable" when the proxy returns neither text nor a tool call', async () => {
    answer = { status: 200, body: { id: 'x', model: 'smart', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 0 } } };
    const botId = await sys((tx) => makeBot(tx, 'chat-empty'));
    expect(await turn(request(botId))).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('a call no bot makes (the "Add a bot" helper) is tagged with its purpose and no bot or run, and its spend is under the team and the session', async () => {
    const sessionId = randomUUID();
    const before = chatCalls().length;
    const result = await turn(request('x', { botId: null, runId: null, sessionId, purpose: 'setup' }));
    expect(result).toMatchObject({ ok: true, text: 'plain answer' });
    expect(chatCalls()).toHaveLength(before + 1);
    const sent = chatCalls().at(-1)!.body as { metadata: Record<string, string> };
    expect(sent.metadata).toMatchObject({ manythreads_workspace: omar.workspaceId, purpose: 'setup' });
    expect(sent.metadata).not.toHaveProperty('manythreads_bot');
    expect(sent.metadata).not.toHaveProperty('manythreads_run');
    const rows = await sys(async (tx) => (await tx.query<{ bot_id: string | null; team_id: string; run_id: string | null }>('SELECT bot_id, team_id, run_id FROM app.llm_spend WHERE session_id = $1', [sessionId])).rows);
    expect(rows).toEqual([{ bot_id: null, team_id: ENG, run_id: null }]);
  });
});
