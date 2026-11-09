import { describe, expect, it } from 'vitest';
import { DETECTOR_NAMES, inspect, scan, type DlpPolicySnapshot } from '../src/dlp.ts';

// P19-12: the sign-in tokens of a Claude or Codex runner are named detectors, not only "something that looks like an sk- key". Every sample below is made up (the shape, a canary inside);
// no real sign-in file is read. The shapes are guesses until the real files are measured (P19-01, P19-13), which is why the field-name finding (the file's own JSON) is tested apart.

const CANARY = 'CANARY-DLP-7b1e';
const ZERO_WIDTH = String.fromCharCode(0x200b);
const b64 = (s: string): string => Buffer.from(s).toString('base64url');
/** A made-up JSON web token: it starts with `eyJ` because its header is `{"`. `pad` makes the body longer. */
const jwt = (payload: Record<string, unknown>, pad = 0): string => `${b64('{"alg":"RS256","typ":"JWT"}')}.${b64(JSON.stringify({ ...payload, pad: 'x'.repeat(pad) }))}.${b64(`signature-${CANARY}`)}`;
const idToken = (pad = 0): string => jwt({ email: 'someone@example.test', plan: CANARY }, pad);

const names = (text: string): string[] => scan(text).map((f) => f.rule);

describe('the named sign-in token shapes', () => {
  const samples: Array<[string, string]> = [
    ['an Anthropic access token', `sk-ant-oat01-${'Ab3_-'.repeat(20)}${CANARY}`],
    ['an Anthropic refresh token', `sk-ant-ort01-${'Zy9-_'.repeat(20)}${CANARY}`],
    ['a ChatGPT id_token (a JSON web token)', idToken()],
    ['a ChatGPT access_token with a long body', idToken(1500)],
    ['a ChatGPT refresh token', `rt_${'Qw8Er7'.repeat(8)}.${'Ty6Ui5'.repeat(8)}`],
  ];

  for (const [label, token] of samples) {
    it(`finds ${label} and redacts all of it under the standard preset`, () => {
      const text = `here is what I found: ${token} and that is all`;
      expect(names(text)).toContain('signin-token');
      const result = inspect(text, 'standard');
      expect(result.outcome).toBe('redact');
      expect(result.text).toBe('here is what I found: [redacted:signin-token] and that is all');
      expect(result.text).not.toContain(CANARY);
      expect(result.rules).toEqual(['signin-token']);
    });

    it(`blocks ${label} under the customer-facing preset`, () => {
      const result = inspect(`a message with ${token}`, 'customer-facing');
      expect(result.outcome).toBe('block');
      expect(result.rules).toContain('signin-token');
    });
  }

  it('redacts the whole of a long token that follows "Bearer" (the shorter Bearer finding must not leave the tail behind)', () => {
    const token = idToken(3000);
    expect(token.length).toBeGreaterThan(4000);
    const result = inspect(`Authorization: Bearer ${token}`, 'standard');
    expect(result.outcome).toBe('redact');
    expect(result.text).not.toContain(CANARY);
    // nothing of the token's tail is left: after the markers there is nothing but the label
    expect(result.text.replace(/\[redacted:[a-z-]+\]/g, '')).toBe('Authorization: ');
  });

  it("finds the sign-in file's own fields whatever the value looks like, and keeps the field name readable", () => {
    const file = JSON.stringify({ claudeAiOauth: { accessToken: `unknown-new-shape-${CANARY}`, refreshToken: `another-unknown-shape-${CANARY}`, expiresAt: 1 } }, null, 2);
    const result = inspect(file, 'standard');
    expect(result.outcome).toBe('redact');
    expect(result.text).toContain('"accessToken": "[redacted:signin-token]"');
    expect(result.text).toContain('"refreshToken": "[redacted:signin-token]"');
    expect(result.text).not.toContain(CANARY);
    const codex = `{"auth_mode":"chatgpt","tokens":{"id_token":"opaque-${CANARY}-0123456789","refresh_token":"opaque-refresh-${CANARY}-9876543210"}}`;
    const out = inspect(codex, 'standard');
    expect(out.text).not.toContain(CANARY);
    expect(out.text).toContain('"refresh_token":"[redacted:signin-token]"');
  });

  it('cannot be switched off by an admin: the settings of the other detectors do not reach it', () => {
    const allAllowed: DlpPolicySnapshot = { detectors: new Map(DETECTOR_NAMES.filter((n) => n !== 'signin-token').map((n) => [n, 'allow' as const])), rules: [] };
    const token = `sk-ant-oat01-${'Ab3_-'.repeat(20)}${CANARY}`;
    const result = inspect(`token ${token}`, 'standard', 'preset', allAllowed);
    expect(result.outcome).toBe('redact');
    expect(result.text).toBe('token [redacted:signin-token]');
  });

  it('finds a token with invisible characters pushed into it', () => {
    const token = `sk-ant-oat01-${'Ab3_-'.repeat(8)}${ZERO_WIDTH}${'Cd4_-'.repeat(8)}${CANARY}`;
    expect(inspect(`x ${token} y`, 'standard').text).toBe('x [redacted:signin-token] y');
  });

  it('leaves ordinary text that only resembles the shapes alone', () => {
    expect(names('call rt_cleanup_handler_for_old_sessions_list when idle')).toEqual([]); // a snake_case word, no digit or capital
    expect(names('the header eyJhbGciOiJIUzI1NiJ9 alone is a header, not a token')).toEqual([]);
    expect(names('sk-ant-oat01 is the name of the shape, and "refresh_token" is a field name: {"refresh_token": null}')).toEqual([]);
    expect(names('{"refresh_token": "short"}')).toEqual([]);
  });
});

describe('the shapes run in linear time on hostile input', () => {
  // The budget is generous (a slow, loaded machine); a quadratic scan of these sizes takes minutes, not a couple of seconds.
  const BUDGET_MS = 2500;
  const timed = (text: string): number => {
    const started = performance.now();
    scan(text);
    return performance.now() - started;
  };

  it('a megabyte of "eyJ-" starts', () => {
    expect(timed('eyJ-'.repeat(260_000))).toBeLessThan(BUDGET_MS);
  });
  it('a megabyte of two-part tokens with no third part', () => {
    expect(timed('eyJabcdefgh.eyJabcdefgh.'.repeat(45_000))).toBeLessThan(BUDGET_MS);
  });
  it('a megabyte of "sk-ant-oat01-" starts', () => {
    expect(timed('sk-ant-oat01-'.repeat(80_000))).toBeLessThan(BUDGET_MS);
  });
  it('a megabyte of "rt_" starts and of field names with no value', () => {
    expect(timed('rt_'.repeat(350_000))).toBeLessThan(BUDGET_MS);
    expect(timed('"refresh_token":'.repeat(65_000))).toBeLessThan(BUDGET_MS);
  });
  it('a single huge run of token characters', () => {
    expect(timed(`eyJ${'a'.repeat(1_000_000)}`)).toBeLessThan(BUDGET_MS);
  });
});
