import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLiteLlmClient, type LiteLlmConfigDocument } from '../src/litellm.ts';

// The client against the REAL LiteLLM proxy (opt-in). The fake in tools/fake-llm answers like the proxy because this file
// says what the proxy does; if LiteLLM changes one of these habits, this is the test that notices.
//
//   pnpm llm:up        # ghcr.io/berriai/litellm:main-stable on http://127.0.0.1:4000 (needs the `litellm` database; deploy/compose)
//   MANYTHREADS_TEST_LITELLM_URL=http://127.0.0.1:4000 MANYTHREADS_TEST_LITELLM_MASTER_KEY=sk-manythreads-dev-master \
//     pnpm exec vitest run packages/plugins/gateway-llm/test/litellm.integration.test.ts
//
// No model provider is called: only the management API is exercised, so the provider keys below are placeholders. The test
// deletes every deployment under the eight alias names and every key it makes, so run it against a dev proxy.

const URL_ = process.env['MANYTHREADS_TEST_LITELLM_URL'] ?? '';
const MASTER = process.env['MANYTHREADS_TEST_LITELLM_MASTER_KEY'] ?? 'sk-manythreads-dev-master';
const suite = URL_ === '' ? describe.skip : describe;
vi.setConfig({ testTimeout: 60_000 });

const raw = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> & { data?: unknown; info?: { models: string[] } } }> => {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${MASTER}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed as never };
};

const ALIASES = new Set(['smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe']);
const listed = async (): Promise<Array<{ id: string; name: string; model: string }>> =>
  ((await raw('GET', '/model/info')).body.data as Array<{ model_info: { id: string }; model_name: string; litellm_params: { model: string } }>)
    .map((m) => ({ id: m.model_info.id, name: m.model_name, model: m.litellm_params.model }))
    .filter((m) => ALIASES.has(m.name) || m.id.startsWith('mt-'))
    .sort((a, b) => a.name.localeCompare(b.name));

const wipe = async (): Promise<void> => {
  for (const model of await listed()) await raw('POST', '/model/delete', { id: model.id });
};

const entry = (name: string, model: string) => ({ model_name: name, litellm_params: { model, api_key: 'sk-placeholder-not-a-real-key-0000' } });
const doc = (list: Array<[string, string]>, fallbacks: Array<Record<string, string[]>> = []): LiteLlmConfigDocument => ({
  model_list: list.map(([name, model]) => entry(name, model)),
  fallbacks,
  deleted: [],
});

const KEYS = ['sk-itest-key-aaaaaaaaaaaaaaaaaaaa', 'sk-itest-lost-key-bbbbbbbbbbbbbbbb'];

suite('the gateway client against real LiteLLM', () => {
  const gateway = createLiteLlmClient({ baseUrl: URL_ || null, masterKey: MASTER });

  beforeAll(async () => {
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    await raw('POST', '/config/update', { router_settings: { fallbacks: [] } });
    for (const key of KEYS) await raw('POST', '/key/delete', { keys: [key] });
  });

  it('documents the proxy habits the client is built around', async () => {
    // 1. a repeated model_name is a 200 that adds a second deployment (so a naive "new, else update" push duplicates)
    expect((await raw('POST', '/model/new', entry('smart', 'openai/gpt-4o'))).status).toBe(200);
    expect((await raw('POST', '/model/new', entry('smart', 'openai/gpt-4o'))).status).toBe(200);
    expect((await listed()).filter((m) => m.name === 'smart')).toHaveLength(2);
    // 2. delete takes an id, and an unknown one is a 400 (not 404); no id at all is a 422
    expect((await raw('POST', '/model/delete', { id: 'mt-nope' })).status).toBe(400);
    expect((await raw('POST', '/model/delete', { model_name: 'smart' })).status).toBe(422);
    // 3. an explicit id can be created once; the repeat is a 500, and update by that id is a 200 (400 for an unknown id)
    const withId = { ...entry('fast', 'openai/gpt-4o-mini'), model_info: { id: 'mt-fast' } };
    expect((await raw('POST', '/model/new', withId)).status).toBe(200);
    expect((await raw('POST', '/model/new', withId)).status).toBe(500);
    expect((await raw('POST', '/model/update', withId)).status).toBe(200);
    expect((await raw('POST', '/model/update', { ...withId, model_info: { id: 'mt-unknown' } })).status).toBe(400);
    // 4. keys: generate twice is a 200; models [] is accepted (and means every model); update/delete of an unknown key is a 404
    expect((await raw('POST', '/key/generate', { key: KEYS[1], models: ['smart'] })).status).toBe(200);
    expect((await raw('POST', '/key/generate', { key: KEYS[1], models: ['smart'] })).status).toBe(200);
    expect((await raw('POST', '/key/update', { key: KEYS[1], models: [] })).status).toBe(200);
    expect((await raw('GET', `/key/info?key=${KEYS[1]}`)).body.info?.models).toEqual([]);
    expect((await raw('POST', '/key/update', { key: 'sk-itest-missing-cccccccccccccccc', models: ['smart'] })).status).toBe(404);
    expect((await raw('POST', '/key/delete', { keys: ['sk-itest-missing-cccccccccccccccc'] })).status).toBe(404);
    await raw('POST', '/key/delete', { keys: [KEYS[1]] });
    await wipe();
  });

  it('applyConfig is idempotent: any number of pushes leaves one deployment per alias, and cleans up older duplicates', async () => {
    // what the client before this change left behind: random-id duplicates under the alias names
    await raw('POST', '/model/new', entry('smart', 'openai/gpt-4o'));
    await raw('POST', '/model/new', entry('smart', 'openai/gpt-4o'));
    await raw('POST', '/model/new', entry('code', 'openai/gpt-4o'));
    expect(await listed()).toHaveLength(3);

    const first = doc([['smart', 'openai/gpt-4o'], ['fast', 'openai/gpt-4o-mini']], [{ smart: ['fast'] }]);
    expect(await gateway.applyConfig(first)).toBe(2);
    let now = await listed();
    expect(now.map((m) => m.id)).toEqual(['mt-fast', 'mt-smart']);

    await gateway.applyConfig(first);
    await gateway.applyConfig(first);
    expect((await listed()).map((m) => m.id)).toEqual(['mt-fast', 'mt-smart']);

    // a changed model is changed in place; an alias that leaves the document leaves the proxy
    await gateway.applyConfig(doc([['smart', 'openai/gpt-4.1'], ['fast', 'openai/gpt-4o-mini']], []));
    now = await listed();
    expect(now.find((m) => m.id === 'mt-smart')?.model).toBe('openai/gpt-4.1');
    await gateway.applyConfig(doc([['fast', 'openai/gpt-4o-mini']]));
    expect((await listed()).map((m) => m.id)).toEqual(['mt-fast']);
    await gateway.applyConfig(doc([]));
    expect(await listed()).toEqual([]);
  });

  it('keys: minted for named aliases, updated in place, re-registered when lost, never empty, revoked twice without complaint', async () => {
    const [key, lost] = KEYS as [string, string];
    await gateway.mintKey({ key, aliases: ['smart'], metadata: { bot_id: 'itest' } });
    expect((await raw('GET', `/key/info?key=${key}`)).body.info?.models).toEqual(['smart']);
    await gateway.mintKey({ key, aliases: ['smart'], metadata: { bot_id: 'itest' } }); // a retry

    await gateway.updateKey({ key, aliases: ['smart', 'fast'], metadata: { bot_id: 'itest' } });
    expect((await raw('GET', `/key/info?key=${key}`)).body.info?.models).toEqual(['smart', 'fast']);

    await gateway.updateKey({ key: lost, aliases: ['code'], metadata: { bot_id: 'itest' } }); // the proxy has never seen it
    expect((await raw('GET', `/key/info?key=${lost}`)).body.info?.models).toEqual(['code']);

    await expect(gateway.mintKey({ key, aliases: [], metadata: {} })).rejects.toThrow(/no aliases/);
    await gateway.revokeKey(key);
    await gateway.revokeKey(key);
    await gateway.revokeKey(lost);
    // (/key/info still answers from the proxy's cache for a moment after a delete; update is the honest probe)
    expect((await raw('POST', '/key/update', { key, models: ['smart'] })).status).toBe(404);
  });
});
