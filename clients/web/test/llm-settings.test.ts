import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, setTransport, type TransportRequest } from '../src/api/client';
import {
  createLlmProvider,
  deleteLlmAlias,
  deleteLlmLimit,
  deleteLlmProvider,
  fetchLlmAliases,
  fetchLlmLimits,
  fetchLlmProviders,
  fetchLlmSettings,
  fetchLlmSpend,
  saveLlmSettings,
  setLlmAlias,
  setLlmLimit,
  updateLlmProvider,
} from '../src/api/endpoints';
import { spendRange } from '../src/screens/admin/llm/spendRange';

/*
 * The Workspace → LLM page's client side (PLAN P5-08). The page itself is a React screen — the repo proves those in
 * Playwright, not in vitest, and the gate runs vitest — so what is asserted here is the part a wrong line would break
 * silently: that each function reaches the route the server registered, with the body the shared schema expects, and
 * that the response is validated rather than trusted.
 *
 * The route table below is deliberately explicit rather than derived from the route descriptors: deriving it from the
 * same objects the client uses would prove only that the code agrees with itself. These are the URLs the gateway plugin
 * mounts, written out, so a change to one of them fails here.
 */

const WS = '00000000-0000-7000-8000-000000000001';
const PROVIDER = '00000000-0000-7000-8000-000000000010';
const LIMIT = '00000000-0000-7000-8000-000000000020';
const AT = '2026-03-01T00:00:00.000Z';

const REPLIES: Record<string, unknown> = {
  'GET /api/workspace/llm/providers': {
    providers: [{ id: PROVIDER, workspaceId: WS, name: 'Anthropic', kind: 'anthropic', apiBase: null, apiVersion: null, enabled: true, local: false, hasSecret: true, createdAt: AT, updatedAt: AT }],
  },
  [`POST /api/workspace/llm/providers`]: {
    provider: { id: PROVIDER, workspaceId: WS, name: 'Anthropic', kind: 'anthropic', apiBase: null, apiVersion: null, enabled: true, local: false, hasSecret: false, createdAt: AT, updatedAt: AT },
  },
  [`PATCH /api/workspace/llm/providers/${PROVIDER}`]: {
    provider: { id: PROVIDER, workspaceId: WS, name: 'Anthropic', kind: 'anthropic', apiBase: null, apiVersion: null, enabled: false, local: false, hasSecret: true, createdAt: AT, updatedAt: AT },
  },
  [`DELETE /api/workspace/llm/providers/${PROVIDER}`]: { ok: true, deletedAt: AT },
  'GET /api/workspace/llm/aliases': { aliases: [{ alias: 'smart', providerId: null, model: 'anthropic/claude-sonnet-4', fallbacks: ['fast'], updatedAt: AT }] },
  'PUT /api/workspace/llm/aliases/smart': { alias: { alias: 'smart', providerId: null, model: 'anthropic/claude-sonnet-4', fallbacks: [], updatedAt: AT } },
  'DELETE /api/workspace/llm/aliases/smart': { ok: true },
  'GET /api/workspace/llm/limits': { limits: [{ id: LIMIT, workspaceId: WS, scope: 'workspace', teamId: null, botId: null, window: 'month', limitUsd: 50, requestsPerMinute: null, updatedAt: AT }] },
  'PUT /api/workspace/llm/limits': { limit: { id: LIMIT, workspaceId: WS, scope: 'workspace', teamId: null, botId: null, window: 'month', limitUsd: 50, requestsPerMinute: null, updatedAt: AT } },
  [`DELETE /api/workspace/llm/limits/${LIMIT}`]: { ok: true },
  'GET /api/workspace/llm/settings': { settings: { preset: 'standard', egressAllowlist: [], caching: true, updatedAt: AT } },
  'PUT /api/workspace/llm/settings': { settings: { preset: 'air-gapped', egressAllowlist: ['localhost:11434'], caching: false, updatedAt: AT } },
  'GET /api/workspace/llm/spend': {
    summary: { since: AT, until: AT, totalUsd: 1.25, calls: 3, promptTokens: 100, completionTokens: 200, byTeam: [], byBot: [] },
  },
};

let seen: TransportRequest[] = [];

beforeEach(() => {
  seen = [];
  setTransport(async (req) => {
    seen.push(req);
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const body = REPLIES[key];
    if (body === undefined) return { status: 404, body: { error: { code: 'not_found', message: `no reply for ${key}` } } };
    return { status: 200, body };
  });
});

const last = (): TransportRequest => {
  const req = seen[seen.length - 1];
  if (!req) throw new Error('no request was sent');
  return req;
};

describe('the LLM endpoints reach the routes the gateway mounts', () => {
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string | RegExp; body?: unknown }> = [
    { name: 'lists providers', run: fetchLlmProviders, method: 'GET', url: '/api/workspace/llm/providers' },
    {
      name: 'creates a provider',
      run: () => createLlmProvider({ name: 'Anthropic', kind: 'anthropic' }),
      method: 'POST',
      url: '/api/workspace/llm/providers',
      body: { name: 'Anthropic', kind: 'anthropic' },
    },
    {
      name: 'creates a provider the admin says runs inside this deployment',
      run: () => createLlmProvider({ name: 'Ollama (cluster)', kind: 'ollama', apiBase: 'http://ollama.models.svc:11434', local: true }),
      method: 'POST',
      url: '/api/workspace/llm/providers',
      body: { name: 'Ollama (cluster)', kind: 'ollama', apiBase: 'http://ollama.models.svc:11434', local: true },
    },
    {
      name: 'marks a provider as local',
      run: () => updateLlmProvider(PROVIDER, { local: true }),
      method: 'PATCH',
      url: `/api/workspace/llm/providers/${PROVIDER}`,
      body: { local: true },
    },
    {
      name: 'changes the base URL and says local again in the same request',
      run: () => updateLlmProvider(PROVIDER, { apiBase: 'http://ollama.models.svc:11434', local: true }),
      method: 'PATCH',
      url: `/api/workspace/llm/providers/${PROVIDER}`,
      body: { apiBase: 'http://ollama.models.svc:11434', local: true },
    },
    {
      name: 'changes one field of a provider',
      run: () => updateLlmProvider(PROVIDER, { enabled: false }),
      method: 'PATCH',
      url: `/api/workspace/llm/providers/${PROVIDER}`,
      body: { enabled: false },
    },
    { name: 'deletes a provider', run: () => deleteLlmProvider(PROVIDER), method: 'DELETE', url: `/api/workspace/llm/providers/${PROVIDER}` },
    { name: 'lists aliases', run: fetchLlmAliases, method: 'GET', url: '/api/workspace/llm/aliases' },
    {
      name: 'binds an alias',
      run: () => setLlmAlias('smart', { model: 'anthropic/claude-sonnet-4', fallbacks: ['fast'] }),
      method: 'PUT',
      url: '/api/workspace/llm/aliases/smart',
      body: { model: 'anthropic/claude-sonnet-4', fallbacks: ['fast'] },
    },
    { name: 'unbinds an alias', run: () => deleteLlmAlias('smart'), method: 'DELETE', url: '/api/workspace/llm/aliases/smart' },
    { name: 'lists limits', run: fetchLlmLimits, method: 'GET', url: '/api/workspace/llm/limits' },
    {
      name: 'sets a limit',
      run: () => setLlmLimit({ scope: 'workspace', window: 'month', limitUsd: 50, requestsPerMinute: null }),
      method: 'PUT',
      url: '/api/workspace/llm/limits',
      body: { scope: 'workspace', window: 'month', limitUsd: 50, requestsPerMinute: null },
    },
    { name: 'removes a limit', run: () => deleteLlmLimit(LIMIT), method: 'DELETE', url: `/api/workspace/llm/limits/${LIMIT}` },
    { name: 'reads the guard settings', run: fetchLlmSettings, method: 'GET', url: '/api/workspace/llm/settings' },
    {
      name: 'saves the guard settings',
      run: () => saveLlmSettings({ preset: 'air-gapped', egressAllowlist: ['localhost:11434'], caching: false }),
      method: 'PUT',
      url: '/api/workspace/llm/settings',
      body: { preset: 'air-gapped', egressAllowlist: ['localhost:11434'], caching: false },
    },
    { name: 'reads the spend report', run: () => fetchLlmSpend({}), method: 'GET', url: '/api/workspace/llm/spend' },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      await c.run();
      const req = last();
      expect(req.method).toBe(c.method);
      if (c.url instanceof RegExp) expect(req.url).toMatch(c.url);
      else expect(req.url).toBe(c.url);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('sends the spend range as an encoded query, and omits a day that was not chosen', async () => {
    await fetchLlmSpend({ since: '2026-03-01T00:00:00.000Z' });
    const req = last();
    expect(req.url.startsWith('/api/workspace/llm/spend?')).toBe(true);
    const query = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
    expect(query.get('since')).toBe('2026-03-01T00:00:00.000Z');
    expect(query.get('until')).toBeNull();
  });

  it('validates the response instead of trusting it', async () => {
    setTransport(async () => ({ status: 200, body: { not: 'a limit list' } }));
    await expect(fetchLlmLimits()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchLlmLimits()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('the spend report\'s date range', () => {
  it('leaves both bounds off when neither day was chosen', () => {
    expect(spendRange('', '')).toEqual({});
  });

  it('starts the from-day and ends the day AFTER the to-day, so the chosen day is included', () => {
    expect(spendRange('2026-03-01', '2026-03-31')).toEqual({
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
    });
  });

  it('handles one bound on its own, and a month end across a leap year', () => {
    expect(spendRange('2026-03-01', '')).toEqual({ since: '2026-03-01T00:00:00.000Z' });
    expect(spendRange('', '2026-03-31')).toEqual({ until: '2026-04-01T00:00:00.000Z' });
    // 2028 is a leap year: the 28th of February really is followed by the 29th.
    expect(spendRange('2028-02-28', '2028-02-28')).toEqual({
      since: '2028-02-28T00:00:00.000Z',
      until: '2028-02-29T00:00:00.000Z',
    });
  });
});
