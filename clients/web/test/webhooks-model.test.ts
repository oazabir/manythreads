import { describe, expect, it } from 'vitest';
import { METHOD_LABELS, VERIFY_EXAMPLE, ago, curlExample, deliveryLine, errorWords, parseTriggerWords, tokenCurlExample, tokenUseLine, useLine } from '../src/webhooks/model';

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

describe('API token and outgoing webhook text (P14-14)', () => {
  it('describes the last use of a token', () => {
    expect(tokenUseLine({ lastUsedAt: null, lastStatus: null, callCount: 0 }, NOW)).toBe('Never used yet');
    expect(tokenUseLine({ lastUsedAt: at(120), lastStatus: 'posted', callCount: 1 }, NOW)).toBe('Last used 2 minutes ago · 1 call so far');
    expect(tokenUseLine({ lastUsedAt: at(120), lastStatus: 'failed', callCount: 7 }, NOW)).toBe('Last call 2 minutes ago was refused · 7 calls so far');
  });

  it('gives a copy-and-paste example that names the method, the token and the channel', () => {
    const c = tokenCurlExample('https://x.example/api/slack/', 'mtat_abc', 'chan-1');
    expect(c).toContain("curl -X POST 'https://x.example/api/slack/chat.postMessage'");
    expect(c).toContain('Authorization: Bearer mtat_abc');
    expect(c).toContain('"channel": "chan-1"');
  });

  it('reads trigger words typed with commas or new lines: trimmed, no empties, no repeats, at most ten', () => {
    expect(parseTriggerWords(' deploy , !ship,\nDeploy,, ')).toEqual(['deploy', '!ship']);
    expect(parseTriggerWords('')).toEqual([]);
    expect(parseTriggerWords(Array.from({ length: 30 }, (_, i) => `w${i}`).join(','))).toHaveLength(10);
    expect(parseTriggerWords('ship it, run tests')).toEqual(['ship it', 'run tests']);
  });

  it('turns a failure reason into words', () => {
    expect(errorWords('status_503')).toBe('the receiver answered 503');
    expect(errorWords('timeout')).toBe('no answer within 5 seconds');
    expect(errorWords('blocked_address')).toContain('private network');
    expect(errorWords('some_new_reason')).toBe('some new reason');
    expect(errorWords(null)).toBe('unknown reason');
  });

  it('describes the last delivery of an outgoing webhook', () => {
    const base = { deliveredCount: 3, failedCount: 1 };
    expect(deliveryLine({ ...base, lastDeliveryAt: null, lastDeliveryStatus: null, lastError: null }, NOW)).toBe('Nothing sent yet');
    expect(deliveryLine({ ...base, lastDeliveryAt: at(300), lastDeliveryStatus: 'delivered', lastError: null }, NOW)).toBe('Last message sent 5 minutes ago · 3 sent · 1 given up on');
    expect(deliveryLine({ ...base, lastDeliveryAt: at(300), lastDeliveryStatus: 'retrying', lastError: 'status_503' }, NOW)).toContain('trying again');
    expect(deliveryLine({ ...base, lastDeliveryAt: at(300), lastDeliveryStatus: 'dead', lastError: 'status_404' }, NOW)).toContain('failed for good (the receiver answered 404)');
  });

  it('names every method a token may be allowed in plain words', () => {
    for (const m of ['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove']) expect(METHOD_LABELS[m]).toBeTruthy();
  });

  it('the signature example checks the same string the server signs', () => {
    expect(VERIFY_EXAMPLE).toContain("'v0:' + stamp + ':' + rawBody");
    expect(VERIFY_EXAMPLE).toContain('x-manythreads-signature');
  });
});
