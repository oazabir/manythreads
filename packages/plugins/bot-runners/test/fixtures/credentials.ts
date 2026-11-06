// A made-up Claude sign-in file for tests: the shape of the real one, three other sign-ins, an unknown key, odd whitespace, a trailing newline and canary strings that must
// never appear in a log, an event, an audit row or an answer. No real credential exists here.
export const CANARY = 'CANARY-SECRET-7f3a';

export function fakeCredentials(tag: string, over: { scopes?: string[]; expiresAt?: number; withOauth?: boolean } = {}): string {
  const body = {
    claudeAiOauth: {
      accessToken: `fake-access-${tag}-${CANARY}`,
      refreshToken: `fake-refresh-${tag}-${CANARY}`,
      expiresAt: over.expiresAt ?? Date.now() + 8 * 3600_000,
      scopes: over.scopes ?? ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
    mcpOAuth: {
      'notion|aaa': { accessToken: `n-${CANARY}` },
      'slack|bbb': { accessToken: `s-${CANARY}` },
      'linear|ccc': { accessToken: `l-${CANARY}` },
    },
    unknownFutureKey: { keep: true },
  };
  if (over.withOauth === false) delete (body as Record<string, unknown>)['claudeAiOauth'];
  // odd whitespace and a trailing newline on purpose: the stored bytes must equal the uploaded ones
  return `${JSON.stringify(body, null, 3).replace('"mcpOAuth":', '"mcpOAuth" :')}\n\n`;
}
