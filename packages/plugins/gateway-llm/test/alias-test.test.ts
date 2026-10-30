import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { causeMessage, classifyFailure } from '../src/alias-test.ts';
import { LiteLlmError } from '../src/litellm.ts';

// P10-01 step 2: the test call of a model alias, through the real server and a proxy stand-in. What it proves: a result comes from a real call (the
// proxy saw it, with fallbacks switched off), a failure gets the right cause in plain words that never repeat the provider's text, a result stops
// counting once the alias or its provider changes, only admins may ask, and aliases without a text test say so.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000 });

type Answer = string | { status: number; body: unknown };
let answer: Answer = 'ready';
let delayMs = 0;
let world: World;
let fake: FakeLlm;
let providerId = '';
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'], timeout: process.env['MANYTHREADS_LLM_TEST_TIMEOUT_MS'] };

interface TestBody {
  test: { alias: string; outcome: string; cause: string | null; message: string; model: string | null; current: boolean; latencyMs: number };
}

const runTest = (alias: string, who = omar) => world.call<TestBody>(who, 'POST', `/api/workspace/llm/aliases/${alias}/test`);
/** A save is pushed to the proxy a moment later, so the route will not test for a few seconds; the tests move the save into the past instead of waiting. */
const settle = () =>
  world.system(async (tx) => {
    await tx.query(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await tx.query(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
  });
const chatCalls = () => fake.state.calls.filter((c) => c.path === '/chat/completions');

beforeAll(async () => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: async () => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return answer;
    },
  });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  world = await createWorld();
  const created = await world.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', {
    name: 'OpenAI',
    kind: 'openai',
    apiKey: 'sk-provider-secret-0001',
  });
  providerId = created.body.provider.id;
  const bound = await world.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId, model: 'gpt-4o', fallbacks: [] });
  expect(bound.status).toBe(200);
  await settle();
}, 120_000);

afterAll(async () => {
  await world?.close();
  await fake?.close();
  for (const [name, value] of [
    ['MANYTHREADS_LITELLM_URL', saved.url],
    ['MANYTHREADS_LITELLM_MASTER_KEY', saved.key],
    ['MANYTHREADS_LLM_TEST_TIMEOUT_MS', saved.timeout],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('causes in plain words', () => {
  it('maps what the proxy client throws to a cause', () => {
    const err = (status: number, body: unknown) => new LiteLlmError('/chat/completions', { status, body });
    expect(classifyFailure(err(401, 'x'))).toBe('auth');
    expect(classifyFailure(err(403, 'x'))).toBe('auth');
    expect(classifyFailure(err(404, 'x'))).toBe('model_not_found');
    expect(classifyFailure(err(400, { error: { message: 'Invalid model name passed in model=smart' } }))).toBe('model_not_found');
    expect(classifyFailure(err(400, 'something else'))).toBe('other');
    expect(classifyFailure(err(429, 'x'))).toBe('rate_limited');
    expect(classifyFailure(err(502, 'x'))).toBe('provider_error');
    expect(classifyFailure(err(0, 'no LiteLLM URL is configured'))).toBe('no_gateway');
    expect(classifyFailure(err(200, 'the completion has no text'))).toBe('empty_answer');
    expect(classifyFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('unreachable');
    expect(classifyFailure('boom')).toBe('other');
  });

  it('every cause has a sentence of its own that names no key and no vendor text', () => {
    const causes = ['no_gateway', 'unbound', 'refused', 'auth', 'model_not_found', 'rate_limited', 'provider_error', 'timeout', 'unreachable', 'empty_answer', 'other'] as const;
    const sentences = causes.map((c) => causeMessage(c));
    expect(new Set(sentences).size).toBe(causes.length);
    for (const s of sentences) expect(s).not.toMatch(/sk-|Bearer|api[_ ]key:/i);
    expect(causeMessage('timeout', { seconds: 7 })).toContain('7 seconds');
  });
});

describe('POST /api/workspace/llm/aliases/:alias/test', () => {
  it('a model that answers is a passing, current result, made as a real call with fallbacks off and recorded as spend', async () => {
    answer = 'ready';
    delayMs = 0;
    const before = chatCalls().length;
    const res = await runTest('smart');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.test).toMatchObject({ alias: 'smart', outcome: 'ok', cause: null, current: true });
    expect(res.body.test.model).toBe('smart');
    expect(res.body.test.message).toMatch(/answered/i);
    const calls = chatCalls();
    expect(calls.length).toBe(before + 1);
    const sent = calls.at(-1)?.body as { model: string; fallbacks: unknown; metadata: Record<string, string>; max_tokens: number };
    expect(sent.model).toBe('smart');
    expect(sent.fallbacks).toEqual([]);
    expect(sent.metadata['purpose']).toBe('alias-test');
    expect(sent.max_tokens).toBeLessThanOrEqual(64);
    const spend = await world.system((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.llm_spend WHERE alias = 'smart' AND bot_id IS NULL`));
    expect(Number(spend.rows[0]?.n)).toBeGreaterThanOrEqual(1);

    const listed = await world.call<{ tests: TestBody['test'][]; untestable: string[] }>(omar, 'GET', '/api/workspace/llm/alias-tests');
    expect(listed.status).toBe(200);
    expect(listed.body.tests.find((t) => t.alias === 'smart')).toMatchObject({ outcome: 'ok', current: true });
    expect(listed.body.untestable.sort()).toEqual(['embed', 'image', 'transcribe']);
  });

  it.each([
    [{ status: 401, body: { error: { message: 'Incorrect API key provided: sk-live-abcdefghijklmnop' } } }, 'auth'],
    [{ status: 429, body: { error: { message: 'You exceeded your current quota' } } }, 'rate_limited'],
    [{ status: 400, body: { error: { message: 'Invalid model name passed in model=smart' } } }, 'model_not_found'],
    [{ status: 503, body: { error: { message: 'upstream is overloaded' } } }, 'provider_error'],
    ['', 'empty_answer'],
  ] as Array<[Answer, string]>)('a failing answer %j is reported with the cause %s and none of the provider\'s text', async (given, cause) => {
    answer = given;
    const res = await runTest('smart');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.test).toMatchObject({ outcome: 'failed', cause });
    expect(res.body.test.message).not.toMatch(/sk-live|quota|overloaded|Invalid model name/);
    const listed = await world.call<{ tests: TestBody['test'][] }>(omar, 'GET', '/api/workspace/llm/alias-tests');
    expect(listed.body.tests.find((t) => t.alias === 'smart')).toMatchObject({ outcome: 'failed', cause });
  });

  it('a model that does not answer in time is a timeout, not a hang', async () => {
    process.env['MANYTHREADS_LLM_TEST_TIMEOUT_MS'] = '300';
    answer = 'ready';
    delayMs = 1_500;
    const started = Date.now();
    const res = await runTest('smart');
    delayMs = 0;
    delete process.env['MANYTHREADS_LLM_TEST_TIMEOUT_MS'];
    expect(res.body.test).toMatchObject({ outcome: 'failed', cause: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_400);
  });

  it('a result stops counting when the alias or its provider is changed afterwards', async () => {
    answer = 'ready';
    expect((await runTest('smart')).body.test.current).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await world.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId, model: 'gpt-4o-mini', fallbacks: [] })).status).toBe(200);
    const afterAlias = await world.call<{ tests: TestBody['test'][] }>(omar, 'GET', '/api/workspace/llm/alias-tests');
    expect(afterAlias.body.tests.find((t) => t.alias === 'smart')).toMatchObject({ outcome: 'ok', current: false });

    await settle();
    expect((await runTest('smart')).body.test.current).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secretOf = async (): Promise<string | null> =>
      (await world.system((tx) => tx.query<{ secret_id: string | null }>('SELECT secret_id FROM app.llm_providers WHERE id = $1', [providerId]))).rows[0]?.secret_id ?? null;
    const oldSecret = await secretOf();
    const patched = await world.call(omar, 'PATCH', `/api/workspace/llm/providers/${providerId}`, { apiKey: 'sk-provider-secret-0002' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    // the key was replaced, not added: the row points at a new secret and the old one is gone
    const newSecret = await secretOf();
    expect(newSecret).not.toBeNull();
    expect(newSecret).not.toBe(oldSecret);
    const left = await world.system((tx) => tx.query<{ id: string }>('SELECT id FROM app.secrets WHERE id = $1', [oldSecret]));
    expect(left.rows).toEqual([]);
    const afterProvider = await world.call<{ tests: TestBody['test'][] }>(omar, 'GET', '/api/workspace/llm/alias-tests');
    expect(afterProvider.body.tests.find((t) => t.alias === 'smart')?.current).toBe(false);
    await settle();
  });

  it('a save a moment ago is not tested yet: the proxy may still hold the old settings, and nothing is sent', async () => {
    const before = chatCalls().length;
    expect((await world.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId, model: 'gpt-4o', fallbacks: [] })).status).toBe(200);
    const early = await runTest('smart');
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toMatch(/saved a moment ago/);
    expect(chatCalls().length).toBe(before);
    await settle();
    expect((await runTest('smart')).body.test.outcome).toBe('ok');
  });

  it('a workspace rule that stops the call is a refusal, and nothing reached the proxy', async () => {
    answer = 'ready';
    expect((await world.call(omar, 'PUT', '/api/workspace/llm/settings', { preset: 'air-gapped' })).status).toBe(200);
    const before = chatCalls().length;
    const res = await runTest('smart');
    expect((await world.call(omar, 'PUT', '/api/workspace/llm/settings', { preset: 'standard' })).status).toBe(200);
    expect(res.body.test).toMatchObject({ outcome: 'failed', cause: 'refused' });
    expect(chatCalls().length).toBe(before);
  });

  it('a proxy that cannot be reached is named as such', async () => {
    const url = process.env['MANYTHREADS_LITELLM_URL'];
    process.env['MANYTHREADS_LITELLM_URL'] = 'http://127.0.0.1:1';
    try {
      const res = await runTest('smart');
      expect(res.body.test).toMatchObject({ outcome: 'failed', cause: 'unreachable' });
    } finally {
      process.env['MANYTHREADS_LITELLM_URL'] = url;
    }
  });

  it('refuses members, an alias that is not bound, and an alias that has no text test', async () => {
    expect((await runTest('smart', nadia)).status).toBe(403);
    expect((await world.call(nadia, 'GET', '/api/workspace/llm/alias-tests')).status).toBe(403);
    const unbound = await runTest('fast');
    expect(unbound.status).toBe(404);
    const embed = await world.call<{ code?: string; error?: { code?: string } }>(omar, 'POST', '/api/workspace/llm/aliases/embed/test');
    expect(embed.status).toBe(409);
    expect((await world.call(omar, 'POST', '/api/workspace/llm/aliases/nope/test')).status).toBe(400);
  });

  it('only the newest result of an alias is kept, and the audit trail has one event per test', async () => {
    const rows = await world.system((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.llm_alias_tests WHERE alias = 'smart'`));
    expect(Number(rows.rows[0]?.n)).toBe(1);
    const events = await world.system((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.events WHERE type = 'llm.alias.tested'`));
    expect(Number(events.rows[0]?.n)).toBeGreaterThanOrEqual(8);
  });
});
