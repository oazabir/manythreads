import { describe, expect, it } from 'vitest';
import { inspect, scan } from '../src/dlp.ts';

// P5-07, the pre-call hook: what the gateway finds in the text that would leave, and what the preset does about it.

const rules = (text: string): string[] => scan(text).map((f) => f.rule);

describe('scan', () => {
  it('finds the shapes a call must not carry', () => {
    expect(rules('here is my key sk-abcdefghijklmnopqrstuvwx')).toEqual(['api-key']);
    expect(rules('use AKIAIOSFODNN7EXAMPLE then ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['api-key', 'api-key']);
    expect(rules('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload')).toEqual(['bearer-token']);
    expect(rules('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['private-key']);
    expect(rules('postgres://app:hunter2@db.internal/manythreads')).toEqual(['credential-url']);
    expect(rules('my card is 4111 1111 1111 1111')).toEqual(['card-number']);
  });

  it('leaves ordinary text and a non-Luhn number alone', () => {
    expect(rules('the deploy window opens at 09:30 and the incident id is 1234567890123456')).toEqual([]);
    expect(rules('a 4111 1111 1111 1112 is not a card')).toEqual([]);
  });

  it('answers findings in text order with no overlap', () => {
    const found = scan('sk-abcdefghijklmnopqrstuvwx then 4111-1111-1111-1111');
    expect(found.map((f) => f.rule)).toEqual(['api-key', 'card-number']);
    expect(found[0]!.start).toBeLessThan(found[1]!.start);
  });
});

describe('whole secrets, not their labels', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n'.repeat(26);
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----`;

  it('redacts a private-key block from header to footer, not just the header line', () => {
    const result = inspect(`here:\n${pem}\nthanks`, 'standard');
    expect(result.outcome).toBe('redact');
    expect(result.rules).toEqual(['private-key']);
    expect(result.text).toBe('here:\n[redacted:private-key]\nthanks');
    expect(result.text).not.toContain('MIIEvQ');
  });

  it('redacts two blocks separately, and a block whose footer is missing up to a bound', () => {
    const two = inspect(`${pem}\nand\n${pem.replace('PRIVATE KEY', 'RSA PRIVATE KEY')}`, 'standard');
    expect(two.text).toBe('[redacted:private-key]\nand\n[redacted:private-key]');
    const truncated = inspect(`-----BEGIN PRIVATE KEY-----\n${body}`, 'standard');
    expect(truncated.text).toBe('[redacted:private-key]');
    const huge = inspect(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(40_000)}\nafter`, 'standard');
    expect(huge.text.startsWith('[redacted:private-key]')).toBe(true);
    expect(huge.text.length).toBeLessThan(40_000 - 10_000); // bounded: the rest of a giant paste is not swallowed
  });

  it('redacts a long project key (sk-proj-, 160+ characters) in full', () => {
    const key = `sk-proj-${'Ab3dEf6hIj_k-'.repeat(14)}`; // 8 + 182 characters
    const result = inspect(`use ${key} and ship it`, 'standard');
    expect(result.rules).toEqual(['api-key']);
    expect(result.text).toBe('use [redacted:api-key] and ship it');
    expect(inspect('the task-runner-configuration-is-here is fine', 'standard').outcome).toBe('allow');
  });

  it('does not mistake a hyphenated word starting sk- for a key, and still catches keys with digits or one long run', () => {
    expect(rules('use the sk-learn-pipeline-classifier-wrapper here')).toEqual([]);
    expect(rules('the sk-something-else-entirely-different-name is a slug')).toEqual([]);
    expect(rules('key sk-proj-abc_DEF-ghi-jkl-mno-pqr')).toEqual([]); // 16+ but no digit and not one run: indistinguishable from a slug, left alone
    expect(rules('key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt')).toEqual(['api-key']); // a digit
    expect(rules('key sk-abcdefghijklmnopqrstuvwx')).toEqual(['api-key']); // an unbroken run of 20+ letters
    expect(rules('hyphenated sk-aaa-bbb-ccc-ddd-eee-fff then sk-0123456789abcdef')).toEqual(['api-key']); // each match judged on its own
    const key = `sk-proj-${'Ab3dEf6hIj_k-'.repeat(14)}`;
    expect(inspect(`${key} and sk-learn-pipeline-classifier`, 'standard').text).toBe('[redacted:api-key] and sk-learn-pipeline-classifier');
  });

  it('stays linear on a text full of private-key headers with no footer', () => {
    const hostile = '-----BEGIN PRIVATE KEY-----'.repeat(12_000) + 'x'.repeat(50_000);
    const started = performance.now();
    inspect(hostile, 'standard');
    inspect(('-----BEGIN PRIVATE KEY-----\n' + 'a'.repeat(60) + '\n').repeat(8_000), 'standard');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('inspect', () => {
  it('allows text with nothing to find, unchanged', () => {
    const result = inspect('how do I rotate the deploy key?', 'standard');
    expect(result).toEqual({ outcome: 'allow', text: 'how do I rotate the deploy key?', findings: [], rules: [] });
  });

  it('redacts under standard and answers the text the caller may send', () => {
    const result = inspect('key sk-abcdefghijklmnopqrstuvwx and card 4111111111111111', 'standard');
    expect(result.outcome).toBe('redact');
    expect(result.rules).toEqual(['api-key', 'card-number']);
    expect(result.text).toBe('key [redacted:api-key] and card [redacted:card-number]');
    // The redacted text carries nothing left to find: a second pass is a no-op.
    expect(inspect(result.text, 'standard').outcome).toBe('allow');
  });

  it('refuses rather than redacts under customer-facing', () => {
    const text = 'the token is sk-abcdefghijklmnopqrstuvwx';
    const result = inspect(text, 'customer-facing');
    expect(result.outcome).toBe('block');
    expect(result.text).toBe(text);
    expect(result.rules).toEqual(['api-key']);
  });

  it('holds a finding for a person when the bot asked for it: require_approval, with the redacted text to show', () => {
    const text = 'the token is sk-abcdefghijklmnopqrstuvwx';
    const held = inspect(text, 'standard', 'hold');
    expect(held.outcome).toBe('require_approval');
    expect(held.rules).toEqual(['api-key']);
    expect(held.text).toBe('the token is [redacted:api-key]'); // what an approver may be shown, never the secret
    // nothing found, nothing to hold
    expect(inspect('how do I rotate the deploy key?', 'standard', 'hold').outcome).toBe('allow');
  });

  it('lets a finding through as written once a person approved exactly that call, but never past a preset that refuses', () => {
    const text = 'the token is sk-abcdefghijklmnopqrstuvwx';
    const approved = inspect(text, 'standard', 'approved');
    expect(approved).toMatchObject({ outcome: 'allow', text, rules: ['api-key'] });
    expect(inspect(text, 'customer-facing', 'approved').outcome).toBe('block');
    expect(inspect(text, 'customer-facing', 'hold').outcome).toBe('block'); // a preset that refuses outright refuses first
  });

  it('is linear on hostile input', () => {
    const hostile = [
      '-'.repeat(100_000),
      '['.repeat(50_000) + ']'.repeat(50_000),
      '1'.repeat(100_000),
      'sk-' + 'a'.repeat(100_000),
      'Bearer ' + 'a'.repeat(100_000),
      ('4111 ' + '1'.repeat(40) + ' ').repeat(2_000),
    ];
    const started = performance.now();
    for (const text of hostile) inspect(text, 'standard');
    const elapsed = performance.now() - started;
    // Six scans of 100,000 characters. The bound is generous (a slow CI box) but catches a quantifier that went
    // quadratic: 600,000 characters of this shape is milliseconds when every inner quantifier is bounded.
    expect(elapsed).toBeLessThan(1_500);
  });
});
