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

// A made-up Codex sign-in file (`auth.json`): the key names of the real one, JWT-shaped tokens with made-up claims, an extra key Codex may add one day, odd whitespace and a
// trailing newline. The canary is in every token. No real credential exists here.
export const CODEX_CANARY = 'CANARY-CODEX-5d21';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CODEX_CANARY}`;

export function fakeCodexCredentials(tag: string, over: { apiKey?: unknown; authMode?: string; account?: string | null; extra?: Record<string, unknown>; tokens?: Record<string, unknown> } = {}): string {
  const body: Record<string, unknown> = {
    auth_mode: over.authMode ?? 'chatgpt',
    OPENAI_API_KEY: over.apiKey ?? null,
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' }, tag, canary: CODEX_CANARY }),
      access_token: jwt({ exp: 1_900_000_000, tag, canary: CODEX_CANARY }),
      refresh_token: `rt-${tag}-${CODEX_CANARY}`,
      ...(over.account === null ? {} : { account_id: over.account ?? `acct-${tag}` }),
      ...(over.tokens ?? {}),
    },
    last_refresh: '2026-11-01T10:00:00.000Z',
    ...(over.extra ?? {}),
  };
  return `${JSON.stringify(body, null, 3).replace('"last_refresh":', '"last_refresh" :')}\n\n`;
}
