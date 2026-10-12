import { describe, expect, it, vi } from 'vitest';
import type { LlmWorkspaceSettings } from '@manythreads/shared';
import { inspect } from '../src/dlp.ts';
import { createSlidingWindow, decide, rateKey, windowStart, type LlmScopeSnapshot, type RateHit } from '../src/limits.ts';

// P5-07, the decision half: the preset's egress rule, the hook's answer, and the budgets and rate limits of every scope,
// all as one pure function. No database and no proxy here.

const settings = (over: Partial<LlmWorkspaceSettings> = {}): LlmWorkspaceSettings => ({
  preset: 'standard',
  egressAllowlist: [],
  caching: true,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

const snapshot = (limit: Partial<LlmScopeSnapshot['limit']> = {}, spentUsd = 0): LlmScopeSnapshot => ({
  limit: {
    id: 'limit-1',
    scope: 'workspace',
    teamId: null,
    botId: null,
    window: 'day',
    limitUsd: null,
    requestsPerMinute: null,
    ...limit,
  },
  spentUsd,
});

const allowAll: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

const call = (over: Partial<Parameters<typeof decide>[0]> = {}) =>
  decide({
    alias: 'smart',
    sessionId: null,
    settings: settings(),
    egress: { host: 'api.anthropic.com', local: false },
    dlp: inspect('a plain question', 'standard'),
    limits: [],
    rate: allowAll,
    ...over,
  });

describe('windowStart', () => {
  it('answers the UTC start of the day or the month', () => {
    const now = new Date('2026-03-17T22:45:10.000Z');
    expect(windowStart('day', now).toISOString()).toBe('2026-03-17T00:00:00.000Z');
    expect(windowStart('month', now).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('decide', () => {
  it('allows a call nothing objects to', () => {
    const decision = call();
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.outcome).toBe('allow');
    expect(decision.limit).toBeNull();
  });

  it('redacts under standard and lets the call continue', () => {
    const text = 'use sk-abcdefghijklmnopqrstuvwx please';
    const decision = call({ dlp: inspect(text, 'standard') });
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe('redact');
    expect(decision.text).toBe('use [redacted:api-key] please');
    expect(decision.rules).toEqual(['api-key']);
  });

  it('refuses a call the hook blocked', () => {
    const decision = call({ settings: settings({ preset: 'customer-facing' }), dlp: inspect('card 4111111111111111', 'customer-facing') });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('dlp');
    expect(decision.outcome).toBe('block');
    expect(decision.message).toContain('card-number');
  });

  it('refuses a budget once the window is spent, naming the scope', () => {
    const decision = call({
      limits: [snapshot({ scope: 'bot', botId: 'bot-1', window: 'day', limitUsd: 5 }, 5)],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('budget');
    expect(decision.message).toBe('The bot budget is spent: $5.0000 of $5.0000.');
    expect(decision.limit?.scope).toBe('bot');
    expect(decision.spentUsd).toBe(5);
  });

  it('lets a call through while the budget has room', () => {
    expect(call({ limits: [snapshot({ limitUsd: 5 }, 4.99)] }).allowed).toBe(true);
  });

  it('names the narrowest exhausted scope whichever order the rows arrive in', () => {
    const workspace = snapshot({ id: 'w', scope: 'workspace', limitUsd: 100 }, 100);
    const session = snapshot({ id: 's', scope: 'session', botId: 'bot-1', limitUsd: 1 }, 1);
    const team = snapshot({ id: 't', scope: 'team', teamId: 'team-1', limitUsd: 20 }, 20);
    const decision = call({ limits: [workspace, team, session] });
    expect(decision.limit?.id).toBe('s');
    expect(decision.message).toContain('session budget');
  });

  it('refuses a rate limit with its retry-after and lets a later call through', () => {
    const rate = vi.fn<RateHit>().mockReturnValueOnce({ allowed: false, retryAfterMs: 1_500 });
    const decision = call({ limits: [snapshot({ scope: 'team', teamId: 'team-1', requestsPerMinute: 30 })], rate });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('rate');
    expect(decision.retryAfterMs).toBe(1_500);
    expect(decision.message).toBe('The team rate limit of 30 calls a minute is reached.');
    expect(rate).toHaveBeenCalledWith('team:team-1', 30, 60_000);
  });

  it('checks the budget before the rate limit at the same scope', () => {
    const decision = call({
      limits: [snapshot({ limitUsd: 1, requestsPerMinute: 1 }, 1)],
      rate: () => ({ allowed: true, retryAfterMs: 0 }),
    });
    expect(decision.reason).toBe('budget');
  });

  it('answers a session rate bucket per session', () => {
    const limit = snapshot({ scope: 'session', botId: 'bot-1' }).limit;
    expect(rateKey({ limit, spentUsd: 0 }, 'conv-9')).toBe('session:bot-1:conv-9');
    expect(rateKey({ limit, spentUsd: 0 }, null)).toBe('session:bot-1:none');
  });

  it('air-gapped runs the local alias only', () => {
    expect(call({ settings: settings({ preset: 'air-gapped' }), alias: 'local' }).allowed).toBe(true);
    const refused = call({ settings: settings({ preset: 'air-gapped' }), alias: 'smart' });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('preset');
    expect(refused.message).toContain('local alias');
  });

  it('judges the whole fallback chain: a local first link does not excuse a hosted fallback', () => {
    const air = settings({ preset: 'air-gapped' });
    const local = { host: 'localhost', local: true };
    expect(call({ settings: air, alias: 'local', egress: local, fallbacks: [] }).allowed).toBe(true);
    const viaFallback = call({ settings: air, alias: 'local', egress: local, fallbacks: [{ alias: 'smart', egress: { host: 'api.openai.com', local: false } }] });
    expect(viaFallback.allowed).toBe(false);
    expect(viaFallback.reason).toBe('preset');
    expect(viaFallback.message).toContain('falls back to smart');

    const strict = settings({ preset: 'strict-egress', egressAllowlist: ['api.anthropic.com'] });
    const hosted = { host: 'api.anthropic.com', local: false };
    expect(call({ settings: strict, egress: hosted, fallbacks: [{ alias: 'fast', egress: hosted }] }).allowed).toBe(true);
    const leak = call({ settings: strict, egress: hosted, fallbacks: [{ alias: 'fast', egress: { host: 'api.openai.com', local: false } }] });
    expect(leak.allowed).toBe(false);
    expect(leak.message).toContain('api.openai.com');
    // a fallback whose host cannot be told is refused like a first link would be
    expect(call({ settings: strict, egress: hosted, fallbacks: [{ alias: 'code', egress: { host: null, local: false } }] }).message).toContain('code (a fallback of smart)');
  });

  it('strict-egress allows an allowlisted host, a local host, and nothing else', () => {
    const strict = settings({ preset: 'strict-egress', egressAllowlist: ['api.anthropic.com'] });
    expect(call({ settings: strict }).allowed).toBe(true);
    // A local endpoint is not egress, so no allowlist entry is needed for it.
    expect(call({ settings: strict, egress: { host: 'localhost', local: true }, alias: 'local' }).allowed).toBe(true);
    const elsewhere = call({ settings: strict, egress: { host: 'api.openai.com', local: false } });
    expect(elsewhere.allowed).toBe(false);
    expect(elsewhere.reason).toBe('preset');
    expect(elsewhere.message).toContain('api.openai.com');
    // An alias nobody bound has no host to judge: strict egress refuses rather than guesses.
    const unknown = call({ settings: strict, egress: null });
    expect(unknown.allowed).toBe(false);
    expect(unknown.message).toContain('cannot tell');
  });
});

describe('createSlidingWindow', () => {
  it('counts a window, refuses past the limit, and forgives one window after the last accepted call', () => {
    let now = 1_000;
    const window = createSlidingWindow(() => now);
    expect(window.hit('bot:b', 2, 60_000).allowed).toBe(true);
    expect(window.hit('bot:b', 2, 60_000).allowed).toBe(true);
    const refused = window.hit('bot:b', 2, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(60_000);
    // A refused call is not counted, so the first two still age out together.
    now += 60_000;
    expect(window.hit('bot:b', 2, 60_000).allowed).toBe(true);
  });

  it('keeps a bucket per key', () => {
    const window = createSlidingWindow(() => 5_000);
    expect(window.hit('bot:a', 1, 60_000).allowed).toBe(true);
    expect(window.hit('bot:b', 1, 60_000).allowed).toBe(true);
    expect(window.hit('bot:a', 1, 60_000).allowed).toBe(false);
    window.reset();
    expect(window.hit('bot:a', 1, 60_000).allowed).toBe(true);
  });
});
