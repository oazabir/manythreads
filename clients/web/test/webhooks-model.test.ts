import { describe, expect, it } from 'vitest';
import { ago, curlExample, useLine } from '../src/webhooks/model';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();

describe('webhooks dialog text', () => {
  it('says when in plain words', () => {
    expect(ago(at(10), NOW)).toBe('just now');
    expect(ago(at(60), NOW)).toBe('1 minute ago');
    expect(ago(at(5 * 60), NOW)).toBe('5 minutes ago');
    expect(ago(at(3 * 3600), NOW)).toBe('3 hours ago');
    expect(ago(at(5 * 86_400), NOW)).toBe('5 days ago');
  });

  it('describes the last call, including a failed or skipped one', () => {
    expect(useLine({ lastUsedAt: null, lastStatus: null, postedCount: 0 }, NOW)).toBe('Never used yet');
    expect(useLine({ lastUsedAt: at(300), lastStatus: 'posted', postedCount: 1 }, NOW)).toBe('Last used 5 minutes ago · 1 message posted');
    expect(useLine({ lastUsedAt: at(300), lastStatus: 'failed', postedCount: 4 }, NOW)).toContain('could not be posted');
    expect(useLine({ lastUsedAt: at(300), lastStatus: 'ignored', postedCount: 4 }, NOW)).toContain('skipped');
  });

  it('gives a copy-and-paste example with the address in it', () => {
    const c = curlExample('https://x.example/hooks/a/b');
    expect(c).toContain("curl -X POST 'https://x.example/hooks/a/b'");
    expect(c).toContain('Content-Type: application/json');
  });
});
