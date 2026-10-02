import { describe, expect, it } from 'vitest';
import { redactUrl, withRedactedLogs } from '../src/log-redact.ts';

describe('log redaction (L4)', () => {
  it('replaces the app token segment wherever it is, and nothing else', () => {
    expect(redactUrl('/api/teams/eng/repo/app/~mta.v1.AAA_-.BBB/apps/x/index.html?x=1')).toBe('/api/teams/eng/repo/app/~mta.[redacted]/apps/x/index.html?x=1');
    expect(redactUrl('/api/x?next=/a/~mta.secret%2Fy#frag')).toBe('/api/x?next=/a/~mta.[redacted]#frag');
    expect(redactUrl('/a/~mta.one/b/~mta.two')).toBe('/a/~mta.[redacted]/b/~mta.[redacted]');
    expect(redactUrl('/api/teams/eng/repo/blob?path=pages/mta.md')).toBe('/api/teams/eng/repo/blob?path=pages/mta.md');
  });

  it('is linear on hostile input', () => {
    const hostile = `/${'~mta.'.repeat(60_000)}`;
    const t0 = performance.now();
    redactUrl(hostile);
    redactUrl(`/~mta.${'a'.repeat(300_000)}`);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('wraps `true` and option objects, and leaves a ready-made logger alone', () => {
    expect(withRedactedLogs(undefined)).toBe(false);
    expect(withRedactedLogs(false)).toBe(false);
    expect(withRedactedLogs(true)).toHaveProperty('serializers.req');
    const custom = withRedactedLogs({ level: 'warn', serializers: { res: () => 'x' } }) as { level: string; serializers: Record<string, unknown> };
    expect(custom.level).toBe('warn');
    expect(Object.keys(custom.serializers).sort()).toEqual(['req', 'res']);
    const ready = { info: () => undefined };
    expect(withRedactedLogs(ready)).toBe(ready);
  });
});
