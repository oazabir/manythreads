import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { redactUrl, serializeRequest, withRedactedLogs } from '../src/log-redact.ts';

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

  it('redacts the secret of an incoming webhook address and keeps its id', () => {
    const id = '01968f3a-7d52-7a11-9c3e-4f1a2b3c4d5e';
    expect(redactUrl(`/hooks/${id}/mtwh_AbC-_123456789012345678901234567890`)).toBe(`/hooks/${id}/[redacted]`);
    expect(redactUrl(`/hooks/${id}/mtwh_secret?x=1`)).toBe(`/hooks/${id}/[redacted]?x=1`);
    expect(redactUrl(`/hooks/${id}/mtwh_secret/extra`)).toBe(`/hooks/${id}/[redacted]/extra`);
    expect(redactUrl('/api/hooks/x/y')).toBe('/api/hooks/x/y');
    // a work app's endpoint and a chat app's account carry no secret in the address (the credential is a header): the ids stay in the log
    expect(redactUrl(`/hooks/apps/${id}`)).toBe(`/hooks/apps/${id}`);
    expect(redactUrl(`/hooks/bridges/telegram/${id}?x=1`)).toBe(`/hooks/bridges/telegram/${id}?x=1`);
    const line = JSON.stringify(serializeRequest({ method: 'POST', url: `/hooks/${id}/mtwh_topsecret`, headers: {}, host: 'h', ip: '1.2.3.4', socket: { remotePort: 1 } } as never));
    expect(line).not.toContain('mtwh_topsecret');
  });

  it('redacts a token in the query string and an integration token (mtat_) wherever it sits', () => {
    const t = `mtat_${'A'.repeat(43)}`;
    expect(redactUrl(`/api/slack/auth.test?token=${t}`)).toBe('/api/slack/auth.test?token=[redacted]');
    expect(redactUrl(`/api/slack/chat.postMessage?channel=x&token=${t}&text=hi#f`)).toBe('/api/slack/chat.postMessage?channel=x&token=[redacted]&text=hi#f');
    expect(redactUrl('/a?TOKEN=abc&x=1')).toBe('/a?TOKEN=[redacted]&x=1');
    expect(redactUrl(`/a?next=${t}`)).toBe('/a?next=[redacted]');
    expect(redactUrl('/a?mytoken=1&tokens=2')).toBe('/a?mytoken=1&tokens=2');
    // WhatsApp's check of a chat bridge address carries the admin's verify word in the query
    const id = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    expect(redactUrl(`/hooks/bridges/whatsapp/${id}?hub.mode=subscribe&hub.verify_token=verify-word-1&hub.challenge=42`)).toBe(
      `/hooks/bridges/whatsapp/${id}?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=42`,
    );
    const line = JSON.stringify(serializeRequest({ method: 'GET', url: `/api/slack/auth.test?token=${t}`, headers: {}, host: 'h', ip: '1.2.3.4', socket: { remotePort: 1 } } as never));
    expect(line).not.toContain(t);
  });

  it('is linear on hostile input', () => {
    expectLinear(
      (n) => [`/${'~mta.'.repeat(n)}`, `/~mta.${'a'.repeat(5 * n)}`, `/api/mcp/runs/${'/api/mcp/runs/'.repeat(n / 2)}`, `/api/mcp/runs/${'a'.repeat(5 * n)}`, `/hooks/${'/'.repeat(n)}`, `/hooks/${'a/'.repeat(n)}`, `/a?${'token=&'.repeat(n / 2)}`, `/a?token=${'a'.repeat(5 * n)}`, `/${'mtat_'.repeat(n)}`],
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
