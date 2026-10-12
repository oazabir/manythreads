import { describe, expect, it } from 'vitest';
import { ALL_ALIASES, buildConfigDocument, resolveModel } from '../src/config.ts';
import type { AliasRow, ProviderRow } from '../src/rows.ts';
import { LiteLlmError, createLiteLlmClient, type LiteLlmConfigDocument, type LiteLlmResult, type LiteLlmTransport } from '../src/litellm.ts';

// P5-06, the config half: the document the database produces, and the client that pushes it. No proxy and no database here —
// the transport is a fake that records what would go on the wire.

const now = new Date('2026-01-01T00:00:00.000Z');

const provider = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'p-openai',
  workspace_id: 'w-1',
  name: 'OpenAI',
  kind: 'openai',
  api_base: null,
  api_version: null,
  secret_id: 's-1',
  enabled: true,
  created_at: now,
  updated_at: now,
  ...over,
});

const alias = (over: Partial<AliasRow> = {}): AliasRow => ({
  alias: 'smart',
  provider_id: 'p-openai',
  model: 'gpt-4o',
  fallbacks: [],
  updated_at: now,
  ...over,
});

/** A transport that records every call and answers a queued reply per path (2xx by default). */
function fakeTransport(queue: Record<string, LiteLlmResult[]> = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const transport: LiteLlmTransport = {
    async post(path, body) {
      calls.push({ path, body });
      const forPath = queue[path];
      return forPath?.length ? (forPath.shift() as LiteLlmResult) : { status: 200, body: { ok: true } };
    },
  };
  return { transport, calls, paths: () => calls.map((c) => c.path) };
}

describe('resolveModel', () => {
  it('adds the provider prefix a bare model lacks', () => {
    expect(resolveModel('openai', 'gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(resolveModel('google', 'gemini-2.5-pro')).toBe('gemini/gemini-2.5-pro');
    expect(resolveModel('openai_compatible', 'llama-3.3-70b')).toBe('openai/llama-3.3-70b');
  });

  it('leaves a model that already names its provider alone', () => {
    expect(resolveModel('openai', 'anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
  });
});

describe('buildConfigDocument', () => {
  it('names every bound alias, carries the decrypted key, and lists the rest as deletions', () => {
    const document = buildConfigDocument({
      providers: [provider()],
      aliases: [
        alias({ alias: 'smart', model: 'gpt-4o', fallbacks: ['fast'] }),
        alias({ alias: 'fast', provider_id: null, model: 'anthropic/claude-haiku-4' }),
      ],
      keyFor: (id) => (id === 'p-openai' ? 'sk-provider-key' : null),
    });

    expect(document.model_list).toEqual([
      { model_name: 'smart', litellm_params: { model: 'openai/gpt-4o', api_key: 'sk-provider-key' } },
      { model_name: 'fast', litellm_params: { model: 'anthropic/claude-haiku-4' } },
    ]);
    expect(document.fallbacks).toEqual([{ smart: ['fast'] }]);
    expect(document.deleted).toEqual(['code', 'local', 'embed', 'vision', 'image', 'transcribe']);
  });

  it('drops an alias whose provider is disabled, keeping its model out of the proxy', () => {
    const document = buildConfigDocument({
      providers: [provider({ enabled: false })],
      aliases: [alias({ alias: 'smart' })],
      keyFor: () => 'sk-provider-key',
    });
    expect(document.model_list).toEqual([]);
    expect(document.deleted).toEqual([...ALL_ALIASES]);
  });

  it('sends no api_key for a keyless endpoint, and passes api_base and api_version through', () => {
    const document = buildConfigDocument({
      providers: [provider({ kind: 'azure', api_base: 'https://x.openai.azure.com', api_version: '2024-10-21', secret_id: null })],
      aliases: [alias({ model: 'gpt-4o' })],
      keyFor: () => null,
    });
    expect(document.model_list[0]?.litellm_params).toEqual({
      model: 'azure/gpt-4o',
      api_base: 'https://x.openai.azure.com',
      api_version: '2024-10-21',
    });
  });
});

describe('createLiteLlmClient', () => {
  const document: LiteLlmConfigDocument = {
    model_list: [{ model_name: 'smart', litellm_params: { model: 'openai/gpt-4o' } }],
    fallbacks: [{ smart: ['fast'] }],
    deleted: ['code'],
  };

  it('creates each model, deletes the unbound aliases and sets the fallbacks', async () => {
    const fake = fakeTransport();
    const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: 'sk-master', transport: fake.transport });
    expect(await client.applyConfig(document)).toBe(1);
    expect(fake.paths()).toEqual(['/model/new', '/model/delete', '/config/update']);
    expect(fake.calls[2]?.body).toEqual({ router_settings: { fallbacks: [{ smart: ['fast'] }] } });
  });

  it('updates a model the proxy already has', async () => {
    const fake = fakeTransport({ '/model/new': [{ status: 400, body: { detail: 'already exists' } }] });
    const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: null, transport: fake.transport });
    await client.applyConfig(document);
    expect(fake.paths()).toEqual(['/model/new', '/model/update', '/model/delete', '/config/update']);
  });

  it('tolerates deleting a model the proxy does not have', async () => {
    const fake = fakeTransport({ '/model/delete': [{ status: 404, body: 'not found' }] });
    const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: null, transport: fake.transport });
    await expect(client.applyConfig(document)).resolves.toBe(1);
  });

  it('mints a caller-chosen key and treats a duplicate retry as success', async () => {
    const fake = fakeTransport({ '/key/generate': [{ status: 400, body: { error: 'key already exists' } }] });
    const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: null, transport: fake.transport });
    await expect(client.mintKey({ key: 'sk-abc', aliases: ['smart'], metadata: { bot_id: 'b' } })).resolves.toBeUndefined();
    expect(fake.calls[0]?.body).toEqual({ key: 'sk-abc', models: ['smart'], metadata: { bot_id: 'b' } });
  });

  it('revokes a key, tolerating one the proxy never had, and surfaces any other failure', async () => {
    const gone = fakeTransport({ '/key/delete': [{ status: 404, body: 'not found' }] });
    const ok = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: null, transport: gone.transport });
    await expect(ok.revokeKey('sk-abc')).resolves.toBeUndefined();

    const broken = fakeTransport({ '/key/delete': [{ status: 500, body: 'boom' }] });
    const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: null, transport: broken.transport });
    await expect(client.revokeKey('sk-abc')).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('is disabled with no URL: nothing is pushed', async () => {
    const client = createLiteLlmClient({ baseUrl: null, masterKey: null });
    expect(client.enabled).toBe(false);
    await expect(client.applyConfig(document)).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('sends the master key as a bearer token', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    // The default transport is what carries the header; assert it through the real client against a capture fetch.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string> | undefined;
      seen.push({ authorization: headers?.['authorization'] });
      return { status: 200, text: async () => '{}' } as unknown as Response;
    }) as typeof fetch;
    try {
      const client = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: 'sk-master' });
      await client.applyConfig(document);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]?.authorization).toBe('Bearer sk-master');
  });
});
