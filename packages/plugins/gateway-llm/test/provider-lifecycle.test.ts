import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';

// The config push end to end through the real server: an admin edits providers and aliases over HTTP, the apply-config job
// runs in the server's own job worker, and the proxy (tools/fake-llm, which answers like LiteLLM) ends up holding exactly the
// models the database describes — never a model with no key, never a duplicate, nothing left behind by a deleted provider.

const { omar } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: World;
let fake: FakeLlm;
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

const until = async <T>(fn: () => T | false | undefined | null, what: string, ms = 60_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const deployed = (): string[] => [...fake.state.models.values()].map((m) => m.model_name).sort();

beforeAll(async () => {
  fake = await startFakeLlm({ masterKey: 'sk-fake' });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  world = await createWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
  await fake?.close();
  for (const [name, value] of [['MANYTHREADS_LITELLM_URL', saved.url], ['MANYTHREADS_LITELLM_MASTER_KEY', saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('providers and aliases, pushed to the proxy', () => {
  it('a provider with a key and an alias bound to it become one deployment; deleting the provider removes it', async () => {
    const created = await world.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'OpenAI', kind: 'openai', apiKey: 'sk-provider-secret-0001' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const providerId = created.body.provider.id;
    const bound = await world.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId, model: 'gpt-4o', fallbacks: ['fast'] });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);

    await until(() => fake.state.models.get('mt-smart'), 'the alias to be deployed');
    expect(fake.state.models.get('mt-smart')?.litellm_params).toMatchObject({ model: 'openai/gpt-4o', api_key: 'sk-provider-secret-0001' });
    // `fast` is not bound, so the chain does not name it (a fallback to a model the proxy lacks would fail the call it rescues)
    await until(() => fake.state.calls.some((c) => c.path === '/config/update'), 'the fallbacks to be pushed');
    expect(fake.state.fallbacks).toEqual([]);

    const removed = await world.call(omar, 'DELETE', `/api/workspace/llm/providers/${providerId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    await until(() => deployed().length === 0, 'the deleted provider\'s model to leave the proxy');
    // the alias went with its provider, instead of lingering as a model nobody can call
    const aliases = await world.call<{ aliases: unknown[] }>(omar, 'GET', '/api/workspace/llm/aliases');
    expect(aliases.body.aliases).toEqual([]);
    // and at no point did a model reach the proxy without its key
    const sent = fake.state.calls.filter((c) => c.path === '/model/new' || c.path === '/model/update');
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) expect((call.body as { litellm_params: Record<string, unknown> }).litellm_params['api_key']).toBe('sk-provider-secret-0001');
  });

  it('pushing again never doubles a deployment, and disabling a provider takes its models away', async () => {
    const created = await world.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'Anthropic', kind: 'anthropic', apiKey: 'sk-ant-secret-0002' });
    const providerId = created.body.provider.id;
    for (const [alias, model] of [['smart', 'claude-sonnet-4'], ['fast', 'claude-haiku-4']] as const) {
      expect((await world.call(omar, 'PUT', `/api/workspace/llm/aliases/${alias}`, { providerId, model, fallbacks: alias === 'smart' ? ['fast'] : [] })).status).toBe(200);
    }
    await until(() => deployed().join() === 'fast,smart' && fake.state.fallbacks.length === 1, 'both aliases and the chain');
    expect(fake.state.fallbacks).toEqual([{ smart: ['fast'] }]);

    // several edits in a row (each queues a push): the proxy still holds one deployment per alias
    for (const name of ['Anthropic 2', 'Anthropic 3', 'Anthropic']) {
      expect((await world.call(omar, 'PATCH', `/api/workspace/llm/providers/${providerId}`, { name })).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(deployed()).toEqual(['fast', 'smart']);

    expect((await world.call(omar, 'PATCH', `/api/workspace/llm/providers/${providerId}`, { enabled: false })).status).toBe(200);
    await until(() => deployed().length === 0, 'the disabled provider\'s models to leave the proxy');
  });
});
