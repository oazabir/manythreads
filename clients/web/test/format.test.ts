import { describe, expect, it } from 'vitest';
import { fullStamp, lastReplyText, toneOf } from '../src/channels/format';

describe('fullStamp (P21-01)', () => {
  const now = new Date(2026, 9, 28, 12, 0);
  it('is "Mon 26 Oct, 20:39" in the reader\'s zone, without the year this year', () => {
    expect(fullStamp(new Date(2026, 9, 26, 20, 39).toISOString(), now)).toBe('Mon 26 Oct, 20:39');
    expect(fullStamp(new Date(2026, 0, 3, 8, 5).toISOString(), now)).toBe('Sat 3 Jan, 08:05');
  });
  it('adds the year when it is not this one', () => {
    expect(fullStamp(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('Wed 31 Dec 2025, 23:59');
  });
});

describe('toneOf (P21-01)', () => {
  it('is stable and always 0 to 9', () => {
    expect(toneOf('Nadia')).toBe(toneOf('Nadia'));
    for (let i = 0; i < 500; i++) {
      const t = toneOf(`person-${i}-${'x'.repeat(i % 7)}`);
      expect(Number.isInteger(t) && t >= 0 && t <= 9).toBe(true);
    }
    expect(toneOf('')).toBeGreaterThanOrEqual(0);
  });
  it('spreads over most tones', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => toneOf(`id-${i}`)));
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});

describe('lastReplyText (P21-03)', () => {
  const now = new Date(2026, 9, 28, 12, 0);
  it('reads "Last reply 2h ago", "just now", and a day name past a day', () => {
    expect(lastReplyText(new Date(2026, 9, 28, 10, 0).toISOString(), now)).toBe('Last reply 2h ago');
    expect(lastReplyText(new Date(2026, 9, 28, 11, 55).toISOString(), now)).toBe('Last reply 5m ago');
    expect(lastReplyText(new Date(2026, 9, 28, 11, 59, 59).toISOString(), now)).toBe('Last reply just now');
    expect(lastReplyText(new Date(2026, 8, 3, 9, 0).toISOString(), now)).toMatch(/^Last reply 3 Sep/);
  });
});
