import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
let upstream: Server | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  upstream = undefined;
});

/** A real gateway's chat-completions endpoint, as tiny as it can be: it records what it was sent and answers as told. */
async function startUpstream(answer: (request: { body: Record<string, unknown>; authorization: string }, res: import('node:http').ServerResponse) => void): Promise<{
  url: string;
  seen: Array<{ body: Record<string, unknown>; authorization: string }>;
}> {
  const seen: Array<{ body: Record<string, unknown>; authorization: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, authorization: req.headers.authorization ?? '' };
      seen.push(request);
      answer(request, res);
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const DOC = {
  model_list: [
    { model_name: 'smart', litellm_params: { model: 'anthropic/claude-sonnet-4' } },
    { model_name: 'fast', litellm_params: { model: 'anthropic/claude-haiku-4' } },
  ],
  fallbacks: [{ smart: ['fast'] }],
  deleted: ['code'],
};

const names = (f: FakeLlm): string[] => [...f.state.models.values()].map((m) => m.model_name).sort();

describe('the gateway client against a real proxy', () => {
  it('pushes a config: one deployment per alias under its own id, stale ones deleted, fallback chains set', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });
    // A leftover: an unbound alias still deployed (and a duplicate of a bound one) from before the client named deployments.
    fake.state.models.set('legacy-1', { id: 'legacy-1', model_name: 'code', litellm_params: { model: 'openai/gpt-4o' } });
    fake.state.models.set('legacy-2', { id: 'legacy-2', model_name: 'smart', litellm_params: { model: 'openai/gpt-4o' } });

    expect(gateway.enabled).toBe(true);
    expect(await gateway.applyConfig(DOC)).toBe(2);

    expect([...fake.state.models.keys()].sort()).toEqual(['mt-fast', 'mt-smart']);
    expect(names(fake)).toEqual(['fast', 'smart']);
    expect(fake.state.fallbacks).toEqual([{ smart: ['fast'] }]);
    const paths = fake.state.calls.map((c) => c.path);
    expect(paths).toContain('/model/info');
    expect(paths).toContain('/model/new');
    expect(paths).toContain('/model/delete');
    expect(paths).toContain('/config/update');
    expect(fake.state.calls.every((c) => c.authorized)).toBe(true);
  });

  it('is idempotent: pushing the same config again updates in place and never adds a deployment', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });

    await gateway.applyConfig(DOC);
    await expect(gateway.applyConfig(DOC)).resolves.toBe(2);
    await expect(gateway.applyConfig(DOC)).resolves.toBe(2);
    expect(names(fake)).toEqual(['fast', 'smart']); // not four, not six: the proxy would load-balance across duplicates
    expect(fake.state.calls.filter((c) => c.path === '/model/new').length).toBe(2);
    expect(fake.state.calls.filter((c) => c.path === '/model/update').length).toBe(4);

    // A changed model is an update of the same deployment, and a model that left the document leaves the proxy.
    await gateway.applyConfig({ ...DOC, model_list: [{ model_name: 'smart', litellm_params: { model: 'anthropic/claude-opus-4' } }], fallbacks: [] });
    expect(names(fake)).toEqual(['smart']);
    expect(fake.state.models.get('mt-smart')?.litellm_params['model']).toBe('anthropic/claude-opus-4');
    expect(fake.state.fallbacks).toEqual([]);
  });

  it('survives a stale listing: a create that collides on its id becomes an update', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const url = fake.url;
    const real = createLiteLlmClient({ baseUrl: url, masterKey: 'sk-fake' });
    await real.applyConfig({ ...DOC, model_list: [DOC.model_list[0]!] });
    expect(names(fake)).toEqual(['smart']);

    // Another replica deployed `smart` after our listing was taken: the listing we act on is empty, the proxy has the id.
    const stale = createLiteLlmClient({
      baseUrl: url,
      masterKey: 'sk-fake',
      transport: {
        async request(method, path, body) {
          if (method === 'GET' && path === '/model/info') return { status: 200, body: { data: [] } };
          const res = await fetch(`${url}${path}`, {
            method,
            headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: res.status, body: await res.json() };
        },
      },
    });
    await expect(stale.applyConfig({ ...DOC, model_list: [DOC.model_list[0]!] })).resolves.toBe(1);
    expect(names(fake)).toEqual(['smart']); // the collision (a 500) was turned into an update; no duplicate
  });

  it('surfaces the proxy refusing the fallback chains when its config file owns them, without echoing a credential', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake', fallbacksLocked: true });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });
    const failure = await gateway.applyConfig(DOC).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LiteLlmError);
    expect((failure as LiteLlmError).status).toBe(400);
    expect((failure as LiteLlmError).message).toContain('set in the config file');
  });

  it('mints a key, updates its aliases, survives minting it twice, and revokes it twice without complaining', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });

    const input = { key: 'sk-bot-1', aliases: ['smart', 'fast'], metadata: { bot: 'brain' } };
    await gateway.mintKey(input);
    expect(fake.state.keys.get('sk-bot-1')).toEqual({ models: ['smart', 'fast'], metadata: { bot: 'brain' } });

    // A retry after a crash mints the same caller-chosen key: the proxy's 200 (or an older proxy's 400) is the desired state.
    await expect(gateway.mintKey(input)).resolves.toBeUndefined();
    expect(fake.state.keys.size).toBe(1);

    await gateway.updateKey({ ...input, aliases: ['code'] });
    expect(fake.state.keys.get('sk-bot-1')?.models).toEqual(['code']);
    // A key the proxy lost is registered again instead of leaving the bot without access.
    fake.state.keys.clear();
    await gateway.updateKey({ ...input, aliases: ['code'] });
    expect(fake.state.keys.get('sk-bot-1')).toEqual({ models: ['code'], metadata: { bot: 'brain' } });

    await gateway.revokeKey('sk-bot-1');
    expect(fake.state.keys.size).toBe(0);
    // Revoking twice is a no-op; the proxy answers 404 and the client must swallow exactly that.
    await expect(gateway.revokeKey('sk-bot-1')).resolves.toBeUndefined();
  });

  it('never registers a key with no aliases: an empty list means every model to the proxy', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });
    await expect(gateway.mintKey({ key: 'sk-bot-1', aliases: [], metadata: {} })).rejects.toThrow(/no aliases/);
    await expect(gateway.updateKey({ key: 'sk-bot-1', aliases: [], metadata: {} })).rejects.toThrow(/no aliases/);
    expect(fake.state.keys.size).toBe(0);
  });

  it('reports a refused master key as a LiteLlmError with the proxy\'s status', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-wrong' });

    await expect(gateway.applyConfig(DOC)).rejects.toBeInstanceOf(LiteLlmError);
    await expect(gateway.applyConfig(DOC)).rejects.toMatchObject({ status: 401 });
    // The refused call is recorded, so a test can prove the client really sent the wrong credential rather than skipping.
    expect(fake.state.calls.some((c) => !c.authorized && c.path === '/model/info')).toBe(true);
    expect(fake.state.models.size).toBe(0);
  });

  it('refuses a body carrying workspace_id, at any depth, as the real proxy does', async () => {
    fake = await startFakeLlm({ masterKey: 'sk-fake' });
    const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });
    await expect(gateway.mintKey({ key: 'sk-bot-1', aliases: ['smart'], metadata: { workspace_id: 'w' } })).rejects.toMatchObject({ status: 401 });
    await gateway.mintKey({ key: 'sk-bot-1', aliases: ['smart'], metadata: { manythreads_workspace: 'w', manythreads_bot: 'b' } });
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'hi' }], metadata: { workspace_id: 'w' } }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain('workspace_id is not allowed in request body');
  });

  it('stays disabled without a URL: it fails loudly instead of pretending to have pushed', async () => {
    const gateway = createLiteLlmClient({ baseUrl: null, masterKey: null });
    expect(gateway.enabled).toBe(false);
    await expect(gateway.applyConfig(DOC)).rejects.toBeInstanceOf(LiteLlmError);
    await expect(gateway.mintKey({ key: 'sk-bot-1', aliases: ['smart'], metadata: {} })).rejects.toBeInstanceOf(LiteLlmError);
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

  it('answers a completion with what the test scripted: text, a raw status, and the request it was handed', async () => {
    const seen: Array<{ model: string; roles: string[]; authorized: boolean }> = [];
    fake = await startFakeLlm({
      masterKey: 'sk-fake',
      completion: ({ model, messages, authorized }) => {
        seen.push({ model, roles: messages.map((m) => m.role), authorized });
        return messages.some((m) => m.content.includes('boom')) ? { status: 500, body: { error: { message: 'boom' } } } : 'YES';
      },
    });
    const url = fake.url;
    const ask = (path: string, content: string) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake' },
        body: JSON.stringify({ model: 'local', messages: [{ role: 'system', content: 'be a gate' }, { role: 'user', content }] }),
      });
    const ok = await ask('/chat/completions', 'hello');
    expect(((await ok.json()) as { choices: [{ message: { content: string } }] }).choices[0].message.content).toBe('YES');
    expect((await ask('/v1/chat/completions', 'hello')).status).toBe(200);
    expect((await ask('/chat/completions', 'boom')).status).toBe(500);
    expect(seen).toEqual([
      { model: 'local', roles: ['system', 'user'], authorized: true },
      { model: 'local', roles: ['system', 'user'], authorized: true },
      { model: 'local', roles: ['system', 'user'], authorized: true },
    ]);
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

  it('streams a completion as server-sent events when asked, with the same text as the plain answer', async () => {
    fake = await startFakeLlm({ scenario: 'demo' });
    const res = await fetch(`${fake.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'smart',
        stream: true,
        messages: [{ role: 'user', content: '@orchestrator plan the release checklist work' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await res.text()).split('\n\n').filter((f) => f !== '');
    expect(frames.at(-1)).toBe('data: [DONE]');
    const first = JSON.parse(frames[0]!.slice('data: '.length)) as { choices: [{ delta: { content: string }; finish_reason: null }] };
    expect(first.choices[0].delta.content).toContain('Orchestrator here');
    const last = JSON.parse(frames.at(-2)!.slice('data: '.length)) as { choices: [{ delta: object; finish_reason: string }] };
    expect(last.choices[0].finish_reason).toBe('stop');
  });
});

describe('fake-llm with a real gateway behind it', () => {
  /** The body the upstream answered, as the agent's own client would read it. */
  const answer = (content: string) => ({
    id: 'chatcmpl-real',
    model: 'default',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 },
  });

  it('sends a completion upstream with the gateway key, under the upstream model name, and keeps the key out of its state', async () => {
    const real = await startUpstream((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer('from the real model')));
    });
    fake = await startFakeLlm({ masterKey: 'sk-fake', upstream: { url: `${real.url}/v1`, apiKey: 'sk-upstream-secret', model: 'default' } });

    // The bot's own virtual key is what a run presents; the stand-in owns the upstream credential.
    const res = await fetch(`${fake.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-bot-abc' },
      body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'say hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }]; usage: { total_tokens: number } };
    expect(body.choices[0].message.content).toBe('from the real model');
    expect(body.usage.total_tokens).toBe(36);
    // The alias `smart` is manythreads' name for the model; the upstream is asked for its own.
    expect(real.seen).toHaveLength(1);
    expect(real.seen[0]?.body['model']).toBe('default');
    expect(real.seen[0]?.body['messages']).toEqual([{ role: 'user', content: 'say hi' }]);
    expect(real.seen[0]?.authorization).toBe('Bearer sk-upstream-secret');
    // The management side is still in memory: the gateway's push never reaches the real proxy.
    expect(JSON.stringify([...fake.state.keys.values()])).not.toContain('sk-upstream-secret');
    expect(fake.state.calls.some((c) => c.path === '/v1/chat/completions')).toBe(true);
  });

  it('streams the upstream\'s own frames through untouched, so an agent reads a real SSE answer', async () => {
    const real = await startUpstream((_request, res) => {
      const frame = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'chatcmpl-real', object: 'chat.completion.chunk', created: 1, model: 'default', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(frame({ role: 'assistant', content: '' }, null));
      res.write(frame({ content: 'streamed ' }, null));
      res.write(frame({ content: 'answer' }, null));
      res.end(`${frame({}, 'stop')}data: [DONE]\n\n`);
    });
    fake = await startFakeLlm({ upstream: { url: real.url, apiKey: 'sk-upstream-secret' } });

    const res = await fetch(`${fake.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', stream: true, messages: [{ role: 'user', content: 'say hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('streamed ');
    expect(text).toContain('answer');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // No `model` option: the caller's name goes through as asked.
    expect(real.seen[0]?.body['model']).toBe('default');
    expect(real.seen[0]?.body['stream']).toBe(true);
  });

  it('answers 502 when the upstream cannot be reached, rather than pretending a model answered', async () => {
    // A port nothing listens on: the gateway's own error path is what a run sees.
    fake = await startFakeLlm({ upstream: { url: 'http://127.0.0.1:9', apiKey: 'sk-upstream-secret' } });
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('upstream');
  });
});
