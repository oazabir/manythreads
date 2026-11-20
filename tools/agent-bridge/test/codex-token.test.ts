import { describe, expect, it } from 'vitest';
import { acceptRenewed, accountOf, CODEX_AUTH_MAX_BYTES, codexTokenFacts, mainIsNewer, rebuildRenewed, refusalLine, type CodexTokenFacts } from '../src/codex-token.ts';

// P31-01: which Codex sign-in files a team's run may copy back to the machine's main copy. Every refusal reason, and a real renewal accepted. The tokens are made up.

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>): string => `${b64({ alg: 'none' })}.${b64(claims)}.c2ln`;
const REFRESH_CANARY = 'rt-canary-never-in-output';

function file(o: { account?: string; idAccount?: string; refresh?: string; when?: string; mode?: string; apiKey?: string | null; exp?: number; drop?: 'id_token' | 'access_token' | 'refresh_token' } = {}): string {
  const tokens: Record<string, unknown> = {
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: o.idAccount ?? o.account ?? 'acct-1' } }),
    access_token: jwt({ exp: o.exp ?? 4102444800 }),
    refresh_token: o.refresh ?? 'rt-1',
    account_id: o.account ?? 'acct-1',
  };
  if (o.drop !== undefined) delete tokens[o.drop];
  return JSON.stringify({ auth_mode: o.mode ?? 'chatgpt', OPENAI_API_KEY: o.apiKey ?? null, tokens, last_refresh: o.when ?? '2026-11-10T00:00:00Z' });
}
const NOW = Date.parse('2026-11-20T12:00:00Z');
const facts = (text: string): CodexTokenFacts => {
  const f = codexTokenFacts(text);
  if (f === null) throw new Error('not facts');
  return f;
};

describe('what a Codex sign-in file says', () => {
  it('a ChatGPT login: its account in both places, its dates, hashes and never a token', () => {
    const f = facts(file({ refresh: REFRESH_CANARY, exp: 1900000000 }));
    expect(f).toMatchObject({ chatgpt: true, accountId: 'acct-1', idTokenAccountId: 'acct-1', lastRefresh: Date.parse('2026-11-10T00:00:00Z'), accessExpiresAt: 1900000000 * 1000 });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f)).not.toContain(REFRESH_CANARY);
    expect(accountOf(f)).toBe('acct-1');
  });
  it('an API key, another login kind or a missing token is not a ChatGPT login; the two account names must agree', () => {
    expect(facts(file({ apiKey: 'sk-made-up' })).chatgpt).toBe(false);
    expect(facts(file({ mode: 'apikey' })).chatgpt).toBe(false);
    for (const drop of ['id_token', 'access_token', 'refresh_token'] as const) expect(facts(file({ drop })).chatgpt).toBe(false);
    expect(accountOf(facts(file({ idAccount: 'acct-2' })))).toBeNull();
    expect(accountOf(null)).toBeNull();
  });
  it('text that is not a JSON object, an empty file or one over 64 KiB is no file at all', () => {
    for (const t of ['', 'not json', '[1]', 'null', '"x"']) expect(codexTokenFacts(t)).toBeNull();
    expect(codexTokenFacts(`{"pad":"${'x'.repeat(CODEX_AUTH_MAX_BYTES)}"}`)).toBeNull();
  });
});

describe('acceptRenewed: may a team\'s renewed copy replace the main copy', () => {
  const main = file({ refresh: 'rt-1', when: '2026-11-10T00:00:00Z' });
  const renewed = file({ refresh: 'rt-2', when: '2026-11-18T00:00:00Z' });
  it('a real renewal (same account, later, another refresh token, main copy untouched) is accepted', () => {
    expect(acceptRenewed(facts(main), facts(main), facts(renewed))).toEqual({ ok: true });
  });
  it.each([
    ['unchanged', main, main, main],
    ['not_a_login', main, main, 'not json'],
    ['not_a_login', main, main, file({ refresh: 'rt-2', when: '2026-11-18T00:00:00Z', apiKey: 'sk-made-up' })],
    ['not_a_login', main, main, file({ refresh: 'rt-2', when: '2026-11-18T00:00:00Z', drop: 'refresh_token' })],
    ['no_main_copy', 'gone', main, renewed],
    ['no_main_copy', file({ mode: 'apikey' }), main, renewed],
    ['other_account', main, main, file({ account: 'acct-2', idAccount: 'acct-2', refresh: 'rt-2', when: '2026-11-18T00:00:00Z' })],
    ['other_account', main, main, file({ idAccount: 'acct-2', refresh: 'rt-2', when: '2026-11-18T00:00:00Z' })],
    ['not_newer', main, main, file({ refresh: 'rt-2', when: '2026-11-10T00:00:00Z' })],
    ['not_newer', main, main, file({ refresh: 'rt-2', when: '2026-11-01T00:00:00Z' })],
    ['not_newer', main, main, file({ refresh: 'rt-2', when: 'not a date' })],
    ['same_refresh_token', main, main, file({ refresh: 'rt-1', when: '2026-11-18T00:00:00Z' })],
    ['main_changed', file({ refresh: 'rt-3', when: '2026-11-17T00:00:00Z' }), main, renewed],
    ['future_date', main, main, file({ refresh: 'rt-2', when: '9999-12-31T00:00:00Z' })],
    ['future_date', main, main, file({ refresh: 'rt-2', when: '2026-11-20T12:06:00Z' })],
  ])('refuses: %s', (reason, mainText, copiedText, candidateText) => {
    const m = mainText === 'gone' ? null : codexTokenFacts(mainText);
    expect(acceptRenewed(m, facts(copiedText), codexTokenFacts(candidateText), NOW)).toEqual({ ok: false, reason });
  });
  it('a date a little ahead (clocks differ) is fine; a main copy dated in the future is repaired by a real renewal', () => {
    expect(acceptRenewed(facts(main), facts(main), facts(file({ refresh: 'rt-2', when: '2026-11-20T12:04:00Z' })), NOW)).toEqual({ ok: true });
    const broken = file({ refresh: 'rt-1', when: '9999-12-31T00:00:00Z' });
    expect(acceptRenewed(facts(broken), facts(broken), facts(renewed), NOW)).toEqual({ ok: true });
  });
  it('a refusal is one plain line with no token in it', () => {
    for (const r of ['unchanged', 'not_a_login', 'no_main_copy', 'other_account', 'not_newer', 'same_refresh_token', 'main_changed'] as const) {
      expect(refusalLine(r)).toMatch(/^[a-z]/);
      expect(refusalLine(r)).not.toContain('rt-');
    }
    expect(refusalLine('main_changed')).toBe('two runs renewed the Codex sign-in at once; the main copy keeps the one written first');
  });
});

describe('mainIsNewer: is a running team given the main copy another run renewed', () => {
  const old = facts(file({ refresh: 'rt-1', when: '2026-11-10T00:00:00Z' }));
  const newer = facts(file({ refresh: 'rt-2', when: '2026-11-18T00:00:00Z' }));
  it('yes for a later sign-in of the same account; no for the same file, an older one, another account or none', () => {
    expect(mainIsNewer(newer, old)).toBe(true);
    expect(mainIsNewer(old, old)).toBe(false);
    expect(mainIsNewer(old, newer)).toBe(false);
    expect(mainIsNewer(facts(file({ account: 'acct-2', idAccount: 'acct-2', refresh: 'rt-9', when: '2026-11-19T00:00:00Z' })), old)).toBe(false);
    expect(mainIsNewer(null, old)).toBe(false);
    expect(mainIsNewer(facts(file({ refresh: 'rt-9', when: '9999-01-01T00:00:00Z' })), old, NOW)).toBe(false);
    expect(mainIsNewer(newer, facts(file({ refresh: 'rt-9', when: '9999-01-01T00:00:00Z' })), NOW)).toBe(true);
    expect(mainIsNewer(newer, null)).toBe(false);
  });
});

describe('rebuildRenewed: what is written to the main copy', () => {
  const mainDoc = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({}), access_token: jwt({}), refresh_token: 'rt-1', account_id: 'acct-1', login_owner_id: 'owner-1', oauth_provenance: { issuer: 'https://auth.example', client_id: 'app_x', extra: 'no' } }, last_refresh: '2026-11-10T00:00:00Z' };
  it('the four tokens and the date from the team\'s copy, the owner and the sign-in server from the main copy, nothing else', () => {
    const cand = { ...mainDoc, planted: 'x', OPENAI_API_KEY: null, tokens: { ...mainDoc.tokens, refresh_token: 'rt-2', login_owner_id: 'owner-evil', oauth_provenance: { issuer: 'https://evil.example', client_id: 'app_evil' }, more: 'y' }, last_refresh: '2026-11-18T00:00:00Z' };
    const out = JSON.parse(rebuildRenewed(JSON.stringify(cand), JSON.stringify(mainDoc))!) as Record<string, unknown>;
    expect(out).toEqual({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: mainDoc.tokens.id_token, access_token: mainDoc.tokens.access_token, refresh_token: 'rt-2', account_id: 'acct-1', login_owner_id: 'owner-1', oauth_provenance: { issuer: 'https://auth.example', client_id: 'app_x' } }, last_refresh: '2026-11-18T00:00:00Z' });
  });
  it('is null for a candidate that is not a sign-in, or text that is not JSON', () => {
    expect(rebuildRenewed('nope', JSON.stringify(mainDoc))).toBeNull();
    expect(rebuildRenewed(JSON.stringify({ ...mainDoc, OPENAI_API_KEY: 'sk-made-up' }), JSON.stringify(mainDoc))).toBeNull();
    expect(rebuildRenewed(JSON.stringify(mainDoc), 'nope')).toBeNull();
  });
});
