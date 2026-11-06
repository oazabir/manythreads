import { describe, expect, it } from 'vitest';
import { inspectClaudeCredentials, MAX_CREDENTIALS_BYTES } from '../src/index.ts';

const file = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'fake-a', refreshToken: 'fake-r', expiresAt: 1_800_000_000_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', ...over },
    mcpOAuth: { 'notion|1': {}, 'slack|2': {} },
  });

describe('inspectClaudeCredentials', () => {
  it('summarises a good file without returning more than the plan, expiry and other sign-ins', () => {
    const r = inspectClaudeCredentials(file());
    expect(r).toMatchObject({ ok: true, summary: { planLabel: 'Max plan · 20x', expiresAt: 1_800_000_000_000, otherSignins: 2, otherNames: ['notion', 'slack'] } });
    expect(JSON.stringify((r as { summary: unknown }).summary)).not.toContain('fake-');
  });
  it('refuses what is not a sign-in file, in plain words', () => {
    for (const bad of ['', 'x', '[]', '{}', file({ accessToken: '' }), file({ expiresAt: 'soon' }), file({ scopes: ['user:profile'] }), '{"__proto__":{},"claudeAiOauth":{}}']) {
      const r = inspectClaudeCredentials(bad);
      expect(r.ok, bad.slice(0, 30)).toBe(false);
      if (!r.ok) expect(r.message).not.toMatch(/fake-|Unexpected/);
    }
    expect(inspectClaudeCredentials('x'.repeat(MAX_CREDENTIALS_BYTES + 1)).ok).toBe(false);
  });
});
