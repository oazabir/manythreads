import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { createHindsightClient, type HindsightTransport } from '../src/hindsight.ts';
import { bankIdFor, createMemoryProvider } from '../src/provider.ts';
import { refuseBankFields } from '../src/schemas.ts';

// The provider with a stub transaction (what `app.memory_run_scope()` and `app.teams` answer) and a recording transport. The forged-bank
// cases against a real server and database are in cross-team/.

const scopeRow = { run_id: 'run-1', team_id: 'team-a-id', team_slug: 'alpha', bot_id: 'bot-1', person_scoped: false };

function txOf(options: { kind?: 'bot' | 'person' | 'system'; scope?: Record<string, unknown> | null; slug?: string | null } = {}): PluginTx {
  return {
    actor: { kind: options.kind ?? 'bot', id: 'actor-1', workspaceId: 'ws' },
    async query(text: string) {
      if (text.includes('memory_run_scope')) return { rows: options.scope === null ? [] : [options.scope ?? scopeRow] } as never;
      if (text.includes('FROM app.teams')) return { rows: options.slug === null ? [] : [{ slug: options.slug ?? 'alpha' }] } as never;
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function setup() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: HindsightTransport = {
    async request(method, path, body) {
      requests.push({ method, path, body });
      if (path.endsWith('/recall')) return { status: 200, body: { results: [{ id: 'f1', text: 'a fact' }, { id: 'f2', text: 'another' }] } };
      return { status: 200, body: { items_count: 1 } };
    },
  };
  const client = createHindsightClient({ baseUrl: null, apiKey: null, transport });
  return { provider: createMemoryProvider({ client: () => client }), requests };
}

describe('bank ids', () => {
  it('are team:<slug>, and only for a usable slug', () => {
    expect(bankIdFor('engineering')).toBe('team:engineering');
    for (const bad of ['', 'Eng', 'a b', '../x', 'a/b', 'x'.repeat(65), '-x']) expect(() => bankIdFor(bad), bad).toThrow(/slug/);
  });
});

describe('forRun', () => {
  it('derives the bank from the run’s team and reads only that bank', async () => {
    const { provider, requests } = setup();
    const bank = await provider.forRun(txOf());
    expect(bank.id).toBe('team:alpha');
    const out = await bank.recall({ query: 'what do we know', limit: 1 });
    expect(out).toMatchObject({ bank: 'team:alpha', hits: [{ id: 'f1', text: 'a fact' }] });
    expect(out.hits).toHaveLength(1);
    expect(requests.every((r) => r.path.startsWith('/v1/default/banks/team%3Aalpha'))).toBe(true);
  });

  it('is refused outside a live run, and for a transaction the run does not belong to', async () => {
    const { provider, requests } = setup();
    await expect(provider.forRun(txOf({ scope: null }))).rejects.toMatchObject({ code: 'no_run' });
    expect(requests).toEqual([]);
  });

  it('stamps provenance after the caller’s metadata, and derives a document id from the run', async () => {
    const { provider, requests } = setup();
    const bank = await provider.forRun(txOf());
    await bank.retain([{ content: 'Decision: Postgres.', metadata: { run_id: 'forged', source: 'platform', link: 'https://x' } }]);
    const sent = requests.find((r) => r.path.endsWith('/memories'))!.body as { items: Array<{ document_id: string; metadata: Record<string, string> }> };
    expect(sent.items[0]!.metadata).toEqual({ link: 'https://x', source: 'run', team: 'alpha', run_id: 'run-1', bot_id: 'bot-1' });
    expect(sent.items[0]!.document_id).toMatch(/^run:run-1:[0-9a-f]{24}$/);
  });

  it('a run that read something person-scoped recalls but never retains', async () => {
    const { provider, requests } = setup();
    const bank = await provider.forRun(txOf({ scope: { ...scopeRow, person_scoped: true } }));
    await expect(bank.recall({ query: 'anything' })).resolves.toMatchObject({ bank: 'team:alpha' });
    await expect(bank.retain([{ content: 'my private note' }])).rejects.toMatchObject({ code: 'person_scoped' });
    expect(requests.filter((r) => r.path.endsWith('/memories'))).toEqual([]);
  });
});

describe('forTeam', () => {
  it('is for the system only', async () => {
    const { provider } = setup();
    await expect(provider.forTeam(txOf({ kind: 'bot' }), 'team-b-id')).rejects.toMatchObject({ code: 'system_required' });
    await expect(provider.forTeam(txOf({ kind: 'person' }), 'team-b-id')).rejects.toMatchObject({ code: 'system_required' });
    const bank = await provider.forTeam(txOf({ kind: 'system', slug: 'beta' }), 'team-b-id');
    expect(bank.id).toBe('team:beta');
  });

  it('a transaction that only claims to be the system (the database says otherwise) gets no team', async () => {
    const { provider } = setup();
    await expect(provider.forTeam(txOf({ kind: 'system', slug: null }), 'team-b-id')).rejects.toMatchObject({ code: 'unknown_team' });
  });
});

describe('a forged bank', () => {
  const spellings = ['bank', 'bank_id', 'bankId', 'BANK', 'memoryBank', 'team', 'teamId', 'team_id', 'teamSlug', 'workspace', 'workspaceId', 'tenant'];

  it.each(spellings)('is refused when passed as “%s” to recall, retain and forget, and nothing reaches the engine', async (key) => {
    const { provider, requests } = setup();
    const bank = await provider.forRun(txOf());
    await expect(bank.recall({ query: 'launch', [key]: 'team:beta' } as never)).rejects.toMatchObject({ code: 'bank_not_allowed' });
    await expect(bank.retain([{ content: 'x', [key]: 'team:beta' } as never])).rejects.toMatchObject({ code: 'bank_not_allowed' });
    await expect(bank.forget({ [key]: 'team:beta' } as never)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('is refused when it hides in a retain item of a batch, and unknown keys are refused too', async () => {
    const { provider, requests } = setup();
    const bank = await provider.forRun(txOf());
    await expect(bank.retain([{ content: 'fine' }, { content: 'x', bank: 'team:beta' } as never])).rejects.toMatchObject({ code: 'bank_not_allowed' });
    await expect(bank.recall({ query: 'x', filter: 'team:beta' } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toEqual([]);
  });

  it('refuseBankFields looks at keys, not values', () => {
    expect(() => refuseBankFields({ query: 'what did the team decide about the bank holiday?' })).not.toThrow();
    expect(() => refuseBankFields({ query: 'x', Bank: 'b' })).toThrow(/not accepted/);
  });
});

describe('no engine', () => {
  it('rejects with not_configured and says so in the provider', async () => {
    const provider = createMemoryProvider({ client: () => createHindsightClient({ baseUrl: null, apiKey: null }) });
    expect(provider.enabled).toBe(false);
    const bank = await provider.forRun(txOf());
    await expect(bank.recall({ query: 'x' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('an engine that is down is “unavailable”, not a crash', async () => {
    const client = createHindsightClient({
      baseUrl: null,
      apiKey: null,
      transport: { request: () => Promise.reject(new Error('ECONNREFUSED')) },
    });
    const bank = await createMemoryProvider({ client: () => client }).forRun(txOf());
    await expect(bank.recall({ query: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
