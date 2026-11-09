import { describe, expect, it } from 'vitest';
import { CODEX_DEFAULT_PLAN_LABEL, codexPlanLabelFrom, inspectCodexCredentials, MAX_CREDENTIALS_BYTES } from '../src/index.ts';

// A made-up ChatGPT sign-in file: the key names of the real one, made-up values, canary strings in every token. No real credential exists here.
const CANARY = 'CANARY-CODEX-3b9e';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CANARY}`;
const EXP = 1_900_000_000;

const file = (over: Record<string, unknown> = {}, tokens: Record<string, unknown> = {}): string =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' }, email: `someone-${CANARY}@example.test` }),
      access_token: jwt({ exp: EXP, tag: CANARY }),
      refresh_token: `rt-${CANARY}`,
      account_id: 'acct-1',
      oauth_provenance: 'x',
      login_owner_id: 'owner-1',
      ...tokens,
    },
    last_refresh: '2026-11-01T10:00:00.000Z',
    ...over,
  });

describe('inspectCodexCredentials', () => {
  it('reads nothing from the tokens on the server side: a generic plan, no expiry, and no token in the summary', () => {
    const r = inspectCodexCredentials(file());
    expect(r).toMatchObject({ ok: true, summary: { planLabel: CODEX_DEFAULT_PLAN_LABEL, expiresAt: null, lastRefresh: Date.parse('2026-11-01T10:00:00.000Z'), otherCount: 0 } });
    expect(JSON.stringify((r as { summary: unknown }).summary)).not.toContain(CANARY);
  });

  it('in the browser mode reads the plan and the expiry from the two tokens, and still returns no token', () => {
    const r = inspectCodexCredentials(file(), { readPlan: true });
    expect(r).toMatchObject({ ok: true, summary: { planLabel: 'ChatGPT Pro plan', expiresAt: EXP * 1000 } });
    expect(JSON.stringify((r as { summary: unknown }).summary)).not.toContain(CANARY);
    expect(inspectCodexCredentials(file({}, { id_token: 'not.a.jwt', access_token: 'nor.this' }), { readPlan: true })).toMatchObject({ ok: true, summary: { planLabel: 'ChatGPT plan', expiresAt: null } });
  });

  it('refuses a file with an API key set, whatever else it holds, without repeating the key', () => {
    for (const key of ['sk-live-' + CANARY, '', 0, false, {}]) {
      const r = inspectCodexCredentials(file({ OPENAI_API_KEY: key }));
      expect(r.ok, String(key)).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain('API key');
        expect(r.message).not.toContain(CANARY);
      }
    }
    // a file that is ONLY an API key (the other kind of Codex login) is refused too
    expect(inspectCodexCredentials(JSON.stringify({ OPENAI_API_KEY: `sk-${CANARY}` })).ok).toBe(false);
    // null and absent are fine
    expect(inspectCodexCredentials(file({ OPENAI_API_KEY: null })).ok).toBe(true);
    const absent = JSON.parse(file()) as Record<string, unknown>;
    delete absent['OPENAI_API_KEY'];
    expect(inspectCodexCredentials(JSON.stringify(absent)).ok).toBe(true);
  });

  it('refuses what is not a ChatGPT login file, and a hostile key anywhere', () => {
    const bad = [
      '',
      'not json {',
      '[]',
      '{}',
      file({ auth_mode: 'apikey' }),
      file({ auth_mode: undefined }),
      file({ tokens: 'x' }),
      file({}, { refresh_token: '' }),
      file({}, { access_token: undefined }),
      file({}, { id_token: 5 }),
      `{"__proto__":{"x":1},"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"a","access_token":"b","refresh_token":"${CANARY}"}}`,
      `{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"a","access_token":"b","refresh_token":"c","nested":{"__proto__":1}}}`,
    ];
    for (const text of bad) {
      const r = inspectCodexCredentials(text);
      expect(r.ok, text.slice(0, 40)).toBe(false);
      if (!r.ok) expect(r.message).not.toMatch(new RegExp(`${CANARY}|Unexpected|JSON`));
    }
    expect(inspectCodexCredentials('x'.repeat(MAX_CREDENTIALS_BYTES + 1)).ok).toBe(false);
  });

  it('counts the entries beyond the ones Codex writes (names only) and keeps no value', () => {
    const r = inspectCodexCredentials(file({ extra_login: { token: CANARY }, 'we ird/key': 1 }));
    expect(r).toMatchObject({ ok: true, summary: { otherCount: 2, otherNames: ['extra_login', 'weirdkey'] } });
    expect(JSON.stringify(r)).not.toContain(`token":"${CANARY}`);
  });

  it('gives the same login key for the same account and a different one for another account', () => {
    const key = (text: string): string => {
      const r = inspectCodexCredentials(text);
      if (!r.ok) throw new Error('refused');
      return r.loginKey;
    };
    expect(key(file({}, { refresh_token: 'rt-A' }))).toBe(key(file({}, { refresh_token: 'rt-B' })));
    expect(key(file({}, { account_id: 'acct-2' }))).not.toBe(key(file()));
    expect(key(file({}, { login_owner_id: 'owner-2' }))).not.toBe(key(file()));
    // no account id: told apart by the refresh token instead
    expect(key(file({}, { account_id: undefined, refresh_token: 'rt-A' }))).not.toBe(key(file({}, { account_id: undefined, refresh_token: 'rt-B' })));
  });
});

describe('codexPlanLabelFrom', () => {
  it('takes a name from the fixed list and nothing else', () => {
    expect(codexPlanLabelFrom('ChatGPT Plus plan')).toBe('ChatGPT Plus plan');
    expect(codexPlanLabelFrom('<script>alert(1)</script>')).toBe(CODEX_DEFAULT_PLAN_LABEL);
    expect(codexPlanLabelFrom(undefined)).toBe(CODEX_DEFAULT_PLAN_LABEL);
  });
});
