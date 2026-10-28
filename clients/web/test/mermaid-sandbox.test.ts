import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MERMAID_CHANNEL, SANDBOX_CSP, SANDBOX_PAGE, parseSandboxMessage, reduceMermaid, sandboxUrl, type MermaidState } from '../src/viewers/mermaid/sandbox';

const msg = (m: Record<string, unknown>) => parseSandboxMessage({ channel: MERMAID_CHANNEL, ...m });

describe('mermaid sandbox protocol', () => {
  it('accepts only well-formed messages on our channel', () => {
    expect(msg({ type: 'ready' })).toEqual({ channel: MERMAID_CHANNEL, type: 'ready' });
    expect(msg({ type: 'rendered', id: 3, height: 120 })).not.toBeNull();
    expect(msg({ type: 'error', id: 3, message: 'Parse error on line 2' })).not.toBeNull();
    expect(parseSandboxMessage({ type: 'ready' })).toBeNull();
    expect(parseSandboxMessage({ channel: 'something.else', type: 'ready' })).toBeNull();
    expect(parseSandboxMessage('ready')).toBeNull();
    expect(parseSandboxMessage(null)).toBeNull();
    expect(msg({ type: 'rendered', id: 3, height: -1 })).toBeNull();
    expect(msg({ type: 'rendered', id: 'x', height: 10 })).toBeNull();
    expect(msg({ type: 'error', id: 1, message: 'x'.repeat(20_000) })).toBeNull();
    expect(msg({ type: 'ready', extra: true })).toBeNull();
  });
});

describe('mermaid error path (PLAN criterion 8)', () => {
  const loading: MermaidState = { status: 'loading' };

  it('a syntax error becomes an error state carrying the message, and nothing throws', () => {
    const m = msg({ type: 'error', id: 2, message: 'Parse error on line 3:\n...B -- yes -->> C\nExpecting ...' });
    expect(m).not.toBeNull();
    if (!m) return;
    const next = reduceMermaid(loading, m, 2);
    expect(next).toEqual({ status: 'error', message: 'Parse error on line 3:\n...B -- yes -->> C\nExpecting ...' });
  });

  it('an empty message still says something', () => {
    const m = msg({ type: 'error', id: 1, message: '  ' });
    if (!m) throw new Error('message rejected');
    expect(reduceMermaid(loading, m, 1)).toEqual({ status: 'error', message: 'The diagram has a syntax error.' });
  });

  it('a reply to an older request is ignored, so a late error cannot hide a newer diagram', () => {
    const ready: MermaidState = { status: 'ready', height: 200 };
    const stale = msg({ type: 'error', id: 1, message: 'old' });
    if (!stale) throw new Error('message rejected');
    expect(reduceMermaid(ready, stale, 2)).toBe(ready);
  });

  it('a rendered diagram fits its frame (at least 40 px)', () => {
    const m = msg({ type: 'rendered', id: 4, height: 12.2 });
    if (!m) throw new Error('message rejected');
    expect(reduceMermaid(loading, m, 4)).toEqual({ status: 'ready', height: 40 });
    const tall = msg({ type: 'rendered', id: 4, height: 310.4 });
    if (!tall) throw new Error('message rejected');
    expect(reduceMermaid(loading, tall, 4)).toEqual({ status: 'ready', height: 311 });
  });

  it('ready does not change the state', () => {
    const m = msg({ type: 'ready' });
    if (!m) throw new Error('message rejected');
    expect(reduceMermaid(loading, m, 1)).toBe(loading);
  });
});

describe('mermaid sandbox page', () => {
  const nginx = readFileSync(new URL('../../../deploy/docker/nginx.conf', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/mermaid-sandbox.html', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../public/mermaid-sandbox.js', import.meta.url), 'utf8');

  it('forbids every network request, inline script and framing by another site', () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("script-src 'self'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|https?:|\*|unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it('the web server sends exactly that policy with the page, and the page has no inline script', () => {
    expect(nginx).toContain(`location = ${SANDBOX_PAGE}`);
    expect(nginx).toContain(`add_header Content-Security-Policy "${SANDBOX_CSP}" always;`);
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toContain('allow-same-origin');
  });

  it('the frame only takes the address of a script of this site', () => {
    expect(sandboxUrl('/assets/mermaid.min-AbC123.js')).toBe('/sandbox'.replace('/sandbox', SANDBOX_PAGE) + '?bundle=%2Fassets%2Fmermaid.min-AbC123.js');
    for (const bad of ['https://evil.example/x.js', '//evil.example/x.js', '/a/../b.js', '/x.js?y=1', 'javascript:alert(1)', '/x.html', '']) expect(() => sandboxUrl(bad), bad).toThrow();
    // the page's own script checks the same shape before it adds the bundle
    expect(runtime).toContain("[A-Za-z0-9_.@\\/-]+\\.js$");
    expect(runtime).toContain("indexOf('//')");
  });
});
