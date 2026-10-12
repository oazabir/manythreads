import { afterEach, describe, expect, it } from 'vitest';
import { LiteLlmError, createLiteLlmClient } from '../../../packages/plugins/gateway-llm/src/litellm.ts';
import { startFakeLlm, type FakeLlm } from '../src/server.ts';

/*
 * The gateway's LiteLLM client, over real HTTP, against a real server (PLAN P5-08, `tools/fake-llm`).
 *
 * Every other test of this client injects a transport, which proves the client's own logic but nothing about the wire:
 * a wrong path, a mislabelled body or a status the client does not recognise would pass all of them and fail against a
 * proxy. Here the client's own `fetch` transport runs against a socket, so the paths, the JSON bodies, the bearer header
 * and the duplicate/404 handling are all verified against something that answers like the real thing.
 */

let fake: FakeLlm | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const DOC = {
  model_list: [
    { model_name: 'smart', litellm_params: { model: 'anthropic/claude-sonnet-4' } },
    { model_name: 'fast', litellm_params: { model: 'anthropic/claude-haiku-4' } },
  ],
  fallbacks: [{ smart: ['fast'] }],
  deleted: ['code'],
};

describe('the gateway client against a real proxy', () => {
  it('pushes a config: creates each model, deletes the stale ones and sets the fallback chains', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });

    expect(gateway.enabled).toBe(true);
    expect(await gateway.applyConfig(DOC)).toBe(2);

    expect([...fake.state.models.keys()].sort()).toEqual(['fast', 'smart']);
    expect(fake.state.fallbacks).toEqual([{ smart: ['fast'] }]);
    // The paths the client used, in order — this is the assertion an injected transport cannot make.
    expect(fake.state.calls.map((c) => c.path)).toContain('/model/new');
    expect(fake.state.calls.map((c) => c.path)).toContain('/model/delete');
    expect(fake.state.calls.map((c) => c.path)).toContain('/config/update');
    expect(fake.state.calls.every((c) => c.authorized)).toBe(true);
    // The bearer header, not just the body: the proxy refuses without it.
    expect(fake.state.calls[0]?.method).toBe('POST');
  });

  it('is idempotent: a second push takes the proxy\'s "already exists" for an update rather than failing', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });

    await gateway.applyConfig(DOC);
    // The proxy answers 400 "already exists" to /model/new the second time; the client must turn that into /model/update.
    await expect(gateway.applyConfig(DOC)).resolves.toBe(2);
    expect([...fake.state.models.keys()].sort()).toEqual(['fast', 'smart']);
    expect(fake.state.calls.filter((c) => c.path === '/model/update').length).toBe(2);
  });

  it('mints a key, survives minting it twice, and revokes it twice without complaining', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });

    const input = { key: 'sk-bot-1', aliases: ['smart', 'fast'], metadata: { bot: 'brain' } };
    await gateway.mintKey(input);
    expect(fake.state.keys.get('sk-bot-1')).toEqual({ models: ['smart', 'fast'], metadata: { bot: 'brain' } });

    // A retry after a crash mints the same caller-chosen key: the proxy's 400 is the desired state, not a failure.
    await expect(gateway.mintKey(input)).resolves.toBeUndefined();
    expect(fake.state.keys.size).toBe(1);

    await gateway.revokeKey('sk-bot-1');
    expect(fake.state.keys.size).toBe(0);
    // Revoking twice is a no-op; the proxy answers 404 and the client must swallow exactly that.
    await expect(gateway.revokeKey('sk-bot-1')).resolves.toBeUndefined();
  });

  it('reports a refused master key as a LiteLlmError with the proxy\'s status', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-wrong' });

    await expect(gateway.applyConfig(DOC)).rejects.toBeInstanceOf(LiteLlmError);
    await expect(gateway.applyConfig(DOC)).rejects.toMatchObject({ status: 401 });
    // The refused call is recorded, so a test can prove the client really sent the wrong credential rather than skipping.
    expect(fake.state.calls.some((c) => !c.authorized && c.path === '/model/new')).toBe(true);
    expect(fake.state.models.size).toBe(0);
  });

  it('stays disabled without a URL: it fails loudly instead of pretending to have pushed', async () => {
    const gateway = createLiteLlmClient({ baseUrl: null, masterKey: null });
    expect(gateway.enabled).toBe(false);
    await expect(gateway.applyConfig(DOC)).rejects.toBeInstanceOf(LiteLlmError);
    await expect(gateway.mintKey({ key: 'sk-bot-1', aliases: [], metadata: {} })).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('answers a completion with usage, so a call path can be proven without a provider', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { prompt_tokens: number; completion_tokens: number } };
    expect(body.usage.prompt_tokens).toBe(12);
    expect(body.usage.completion_tokens).toBe(7);
  });

  it('refuses an unknown management path before revealing whether it exists, and 404s it to a keyed caller', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });

    // 401 before 404 on purpose: answering "no route" to an unauthenticated caller would tell it which routes exist.
    const anonymous = await fetch(`${fake.url}/model/made/up`, { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const missing = await fetch(`${fake.url}/model/made/up`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-fake' },
    });
    expect(missing.status).toBe(404);

    // Health is open on purpose: a readiness probe has no credential to send.
    const health = await fetch(`${fake.url}/health/readiness`);
    expect(health.status).toBe(200);
  });
});
