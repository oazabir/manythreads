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
