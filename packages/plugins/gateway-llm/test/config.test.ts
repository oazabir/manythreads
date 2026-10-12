import { describe, expect, it } from 'vitest';
import { ALL_ALIASES, buildConfigDocument, nextLocal, resolveModel } from '../src/config.ts';
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
  local: false,
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

/**
 * A transport that records every call and answers a queued reply per path (2xx by default); `GET /model/info` answers the
 * deployments in `listing` unless a reply is queued for it.
 */
function fakeTransport(queue: Record<string, LiteLlmResult[]> = {}, listing: Array<{ id: string; name: string }> = []) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: LiteLlmTransport = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const forPath = queue[path];
      if (forPath?.length) return forPath.shift() as LiteLlmResult;
      if (path === '/model/info') return { status: 200, body: { data: listing.map((m) => ({ model_name: m.name, model_info: { id: m.id } })) } };
      return { status: 200, body: { ok: true } };
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
  const client = (fake: ReturnType<typeof fakeTransport>, masterKey: string | null = null) =>
    createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey, transport: fake.transport });

  it('lists the proxy, creates a model under its own deployment id and sets the fallbacks', async () => {
    const fake = fakeTransport();
    expect(await client(fake, 'sk-master').applyConfig(document)).toBe(1);
    expect(fake.paths()).toEqual(['/model/info', '/model/new', '/config/update']);
    expect(fake.calls[1]?.body).toEqual({
      model_name: 'smart',
      litellm_params: { model: 'openai/gpt-4o' },
      model_info: { id: 'mt-smart' },
    });
    expect(fake.calls[2]?.body).toEqual({ router_settings: { fallbacks: [{ smart: ['fast'] }] } });
  });

  it('updates in place by id when the proxy already has the deployment — never a second one', async () => {
    const fake = fakeTransport({}, [{ id: 'mt-smart', name: 'smart' }]);
    await client(fake).applyConfig(document);
    expect(fake.paths()).toEqual(['/model/info', '/model/update', '/config/update']);
  });

  it('deletes by id what the document no longer names: an unbound alias and a duplicate an older push left', async () => {
    const fake = fakeTransport({}, [
      { id: 'mt-smart', name: 'smart' },
      { id: 'a1b2c3', name: 'smart' }, // a random-id duplicate from before deployments were named
      { id: 'mt-code', name: 'code' },
      { id: 'other-team-model', name: 'something-else' }, // not ours: left alone
    ]);
    await client(fake).applyConfig(document);
    const deletes = fake.calls.filter((c) => c.path === '/model/delete').map((c) => c.body);
    expect(deletes).toEqual([{ id: 'a1b2c3' }, { id: 'mt-code' }]);
  });

  it('turns a create that collides on its id (a stale listing) into an update', async () => {
    const fake = fakeTransport({ '/model/new': [{ status: 500, body: { error: { message: 'Failed to add model to db' } } }] });
    await client(fake).applyConfig(document);
    expect(fake.paths()).toEqual(['/model/info', '/model/new', '/model/update', '/config/update']);
  });

  it('tolerates deleting a deployment the proxy no longer has (it answers 400 "not found in db")', async () => {
    const fake = fakeTransport({ '/model/delete': [{ status: 400, body: { error: { message: "Model with id=mt-code not found in db" } } }] }, [
      { id: 'mt-code', name: 'code' },
    ]);
    await expect(client(fake).applyConfig(document)).resolves.toBe(1);
    const real500 = fakeTransport({ '/model/delete': [{ status: 500, body: 'boom' }] }, [{ id: 'mt-code', name: 'code' }]);
    await expect(client(real500).applyConfig(document)).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('mints a caller-chosen key and treats a duplicate retry as success', async () => {
    const fake = fakeTransport({ '/key/generate': [{ status: 400, body: { error: 'key already exists' } }] });
    await expect(client(fake).mintKey({ key: 'sk-abc', aliases: ['smart'], metadata: { bot_id: 'b' } })).resolves.toBeUndefined();
    expect(fake.calls[0]?.body).toEqual({ key: 'sk-abc', models: ['smart'], metadata: { bot_id: 'b' } });
  });

  it('updates a key, registers it again when the proxy lost it, and refuses an empty alias list outright', async () => {
    const fake = fakeTransport({ '/key/update': [{ status: 404, body: 'Key not found.' }] });
    await client(fake).updateKey({ key: 'sk-abc', aliases: ['smart', 'fast'], metadata: { bot_id: 'b' } });
    expect(fake.paths()).toEqual(['/key/update', '/key/generate']);
    expect(fake.calls[1]?.body).toEqual({ key: 'sk-abc', models: ['smart', 'fast'], metadata: { bot_id: 'b' } });

    const none = fakeTransport();
    await expect(client(none).mintKey({ key: 'sk-abc', aliases: [], metadata: {} })).rejects.toThrow(/no aliases/);
    await expect(client(none).updateKey({ key: 'sk-abc', aliases: [], metadata: {} })).rejects.toThrow(/no aliases/);
    expect(none.calls).toEqual([]); // nothing reached the wire
  });

  it('revokes a key, tolerating one the proxy never had, and surfaces any other failure', async () => {
    const gone = fakeTransport({ '/key/delete': [{ status: 404, body: 'not found' }] });
    await expect(client(gone).revokeKey('sk-abc')).resolves.toBeUndefined();

    const broken = fakeTransport({ '/key/delete': [{ status: 500, body: 'boom' }] });
    await expect(client(broken).revokeKey('sk-abc')).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('is disabled with no URL: nothing is pushed', async () => {
    const disabled = createLiteLlmClient({ baseUrl: null, masterKey: null });
    expect(disabled.enabled).toBe(false);
    await expect(disabled.applyConfig(document)).rejects.toBeInstanceOf(LiteLlmError);
  });

  it('sends the master key as a bearer token', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    // The default transport is what carries the header; assert it through the real client against a capture fetch.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string> | undefined;
      seen.push({ authorization: headers?.['authorization'] });
      return { status: 200, text: async () => '{"data":[]}' } as unknown as Response;
    }) as typeof fetch;
    try {
      const real = createLiteLlmClient({ baseUrl: 'http://litellm:4000', masterKey: 'sk-master' });
      await real.applyConfig(document);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]?.authorization).toBe('Bearer sk-master');
  });
});

describe('LiteLlmError', () => {
  it('carries nothing key-shaped from the proxy\'s answer: virtual keys, key-ish fields, bearer tokens and encrypted blobs', () => {
    const body = {
      error: {
        message: "{'error': 'bad key sk-proj-abcdefghijklmnopqrstuvwxyz', \"api_key\": \"super-secret-value\", 'token': 'abc123'}",
        stored: 'q9bnpyfCsfS4AH2MHQznZ_-L2PKw8J0l9ynb0NXZmueBYrrfsrgxmDwlvWHUpBCE6AO4ipMKS8K3rAZr3TcXT0FYCPI=',
        header: 'Authorization: Bearer abcdefghijklmnop',
      },
    };
    const message = new LiteLlmError('/key/generate', { status: 500, body }).message;
    for (const leaked of ['sk-proj-abc', 'super-secret-value', 'abc123', 'q9bnpyf', 'abcdefghijklmnop']) expect(message).not.toContain(leaked);
    expect(message).toContain('LiteLLM /key/generate answered 500');
  });

  it('keeps a plain, useful message', () => {
    expect(new LiteLlmError('/model/delete', { status: 400, body: { error: { message: 'Model with id=mt-code not found in db' } } }).message).toContain(
      'not found in db',
    );
  });
});

describe('nextLocal', () => {
  const before = { local: true, api_base: 'http://ollama.models.svc:11434' };
  it('clears local when the base URL changes and the request does not say', () => {
    expect(nextLocal(before, { apiBase: 'https://api.example.com' })).toBe(false);
    expect(nextLocal(before, { apiBase: null })).toBe(false);
  });
  it('keeps what the request says, and what an unrelated change leaves alone', () => {
    expect(nextLocal(before, { apiBase: 'https://api.example.com', local: true })).toBe(true);
    expect(nextLocal(before, { local: false })).toBe(false);
    expect(nextLocal(before, {})).toBe(true);
    expect(nextLocal(before, { apiBase: 'http://ollama.models.svc:11434' })).toBe(true); // the same address
  });
  it('never turns local on by itself', () => {
    expect(nextLocal({ local: false, api_base: null }, { apiBase: 'http://localhost:11434' })).toBe(false);
  });
});
