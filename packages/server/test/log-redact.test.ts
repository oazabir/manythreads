import { expectLinear } from '@manythreads/test-utils';
import { describe, expect, it } from 'vitest';
import { redactUrl, withRedactedLogs } from '../src/log-redact.ts';

describe('log redaction (L4)', () => {
  it('replaces the app token segment wherever it is, and nothing else', () => {
    expect(redactUrl('/api/teams/eng/repo/app/~mta.v1.AAA_-.BBB/apps/x/index.html?x=1')).toBe('/api/teams/eng/repo/app/~mta.[redacted]/apps/x/index.html?x=1');
    expect(redactUrl('/api/x?next=/a/~mta.secret%2Fy#frag')).toBe('/api/x?next=/a/~mta.[redacted]#frag');
    expect(redactUrl('/a/~mta.one/b/~mta.two')).toBe('/a/~mta.[redacted]/b/~mta.[redacted]');
    expect(redactUrl('/api/teams/eng/repo/blob?path=pages/mta.md')).toBe('/api/teams/eng/repo/blob?path=pages/mta.md');
  });

  it('keeps a run id in an MCP path and redacts anything else there (a token must never sit in a logged path)', () => {
    const runId = '01968f3a-7d52-7a11-9c3e-4f1a2b3c4d5e';
    expect(redactUrl(`/api/mcp/runs/${runId}`)).toBe(`/api/mcp/runs/${runId}`);
    expect(redactUrl(`/api/mcp/runs/${runId}/close`)).toBe(`/api/mcp/runs/${runId}/close`);
    expect(redactUrl('/api/mcp/runs/8Zq1_oldStyleTokenInThePath0123456789abcdef')).toBe('/api/mcp/runs/[redacted]');
    expect(redactUrl('/api/mcp/runs/8Zq1_oldStyleTokenInThePath0123456789abcdef/close?x=1')).toBe('/api/mcp/runs/[redacted]/close?x=1');
    expect(redactUrl('/api/mcp/runs')).toBe('/api/mcp/runs');
  });

  it('is linear on hostile input', () => {
    expectLinear(
      (n) => [`/${'~mta.'.repeat(n)}`, `/~mta.${'a'.repeat(5 * n)}`, `/api/mcp/runs/${'/api/mcp/runs/'.repeat(n / 2)}`, `/api/mcp/runs/${'a'.repeat(5 * n)}`],
      (urls) => urls.forEach((url) => redactUrl(url)),
      { n: 60_000, label: 'a hostile URL' },
    );
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
