import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { KAHF_WORKSPACE_ID, PERSONA_EMAILS, TEST_AUTH_TOKEN } from '../support/api.ts';

/**
 * No endpoint returns a secret: every GET route the server documents is called as an owner, a member, a support
 * agent, a guest and an anonymous caller, and no JSON key anywhere in any answer may look like a hash, secret,
 * ciphertext, key material or password (PLAN criterion 6; SPEC section 4). Session tokens never appear in a body either.
 */

const FORBIDDEN_KEY = /hash|secret|ciphertext|wrapped.?key|password|passwd|private.?key|api.?key|token/i;
/** Keys that match by name but are not secrets. Keep this empty unless a reviewed route needs an entry. */
const ALLOWED_KEYS = new Set<string>([
  'hasSecret', // OIDC provider admin API: a boolean that says a client secret is stored; the secret itself is never returned
]);

const PARAM_VALUES: Record<string, string> = {
  teamId: '00000000-0000-7000-8000-0000000b0001',
  personId: '00000000-0000-7000-8000-0000000c0001',
  workspaceId: KAHF_WORKSPACE_ID,
  slug: 'engineering',
  provider: 'google',
  token: 'not-a-real-token-0123456789abcdef',
};
const fillPath = (template: string): string =>
  template.replace(/\{([^}]+)\}/g, (_m, name: string) => PARAM_VALUES[name] ?? '00000000-0000-7000-8000-000000000001');

function offendingKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => offendingKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEY.test(k) && !ALLOWED_KEYS.has(k) ? [`${path}.${k}`] : []),
      ...offendingKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

async function signedIn(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, email: string): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': TEST_AUTH_TOKEN } });
  expect(res.status(), `test sign-in as ${email}`).toBe(200);
  return ctx;
}

test('no GET route returns a secret, hash or token field, for any persona or anonymously', async ({ playwright, baseURL }) => {
  const base = baseURL as string;
  const anon = await playwright.request.newContext({ baseURL: base });
  const doc = (await (await anon.get('/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> };
  const routes = Object.entries(doc.paths)
    .filter(([path, ops]) => 'get' in ops && path !== '/ws' && path !== '/openapi.json')
    .map(([path]) => path);
  expect(routes.length, `GET routes found: ${routes.join(', ')}`).toBeGreaterThan(5);
  expect(routes).toContain('/api/session');
  expect(routes).toContain('/api/auth/sessions');

  const callers: [string, APIRequestContext][] = [
    ['anonymous', anon],
    ['owner', await signedIn(playwright, base, PERSONA_EMAILS.omar)],
    ['member', await signedIn(playwright, base, PERSONA_EMAILS.nadia)],
    ['support agent', await signedIn(playwright, base, PERSONA_EMAILS.sameera)],
    ['guest', await signedIn(playwright, base, PERSONA_EMAILS.lena)],
  ];
  const sessionTokens = new Map<string, string>();
  for (const [name, ctx] of callers) {
    const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_session');
    if (cookie) sessionTokens.set(name, cookie.value);
  }

  const findings: string[] = [];
  let answered = 0;
  for (const [name, ctx] of callers) {
    for (const template of routes) {
      const res = await ctx.get(fillPath(template));
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        continue; // not JSON (a file, empty): nothing to scan for keys
      }
      answered += 1;
      findings.push(...offendingKeys(body).map((k) => `${name} GET ${template} (${res.status()}): ${k}`));
      for (const [who, token] of sessionTokens) {
        if (text.includes(token)) findings.push(`${name} GET ${template}: contains ${who}'s session token`);
      }
    }
  }
  expect(answered).toBeGreaterThan(routes.length);
  expect(findings).toEqual([]);

  // The sign-in answers themselves: the session payload and the cookie-bearing responses carry no hash or token keys either.
  const signIn = await playwright.request.newContext({ baseURL: base });
  const res = await signIn.post('/api/auth/password/sign-in', { data: { email: PERSONA_EMAILS.omar, password: 'correct-horse-battery' } });
  expect(res.status()).toBe(200);
  expect(offendingKeys(await res.json())).toEqual([]);
});

test('the scanner itself flags hash, secret, ciphertext, password and token keys at any depth', () => {
  expect(offendingKeys({ ok: 1, nested: [{ passwordHash: 'x' }, { clientSecret: 'y' }], deep: { a: { ciphertext: 'z' } }, t: { csrfToken: 'q' } })).toEqual([
    '$.nested[0].passwordHash',
    '$.nested[1].clientSecret',
    '$.deep.a.ciphertext',
    '$.t.csrfToken',
  ]);
  expect(offendingKeys({ person: { id: 1, email: 'a@b' }, methods: [{ kind: 'password', label: 'Email' }] })).toEqual([]);
});
