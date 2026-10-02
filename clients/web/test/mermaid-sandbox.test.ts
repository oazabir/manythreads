import { describe, expect, it } from 'vitest';
import { MERMAID_CHANNEL, SANDBOX_CSP, buildSandboxDoc, parseSandboxMessage, reduceMermaid, type MermaidState } from '../src/viewers/mermaid/sandbox';

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
  it('forbids every network request and loads nothing', () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|https?:|\*/);
    const doc = buildSandboxDoc('window.mermaid = {};');
    expect(doc).toContain(`content="${SANDBOX_CSP}"`);
    expect(doc).not.toMatch(/<script[^>]+src=/);
    expect(doc).not.toContain('allow-same-origin');
  });

  it('the bundle cannot close its own script element', () => {
    const bundle = 'var a = "</script><img src=x onerror=alert(1)>"; var b = "<!-- x";';
    const doc = buildSandboxDoc(bundle);
    expect(doc.match(/<\/script>/g)).toHaveLength(2);
    expect(doc).not.toContain('<!--');
  });

  it('closing tags in any case are neutralised', () => {
    const doc = buildSandboxDoc('x = "</ScRiPt>";');
    expect(doc.match(/<\/script>/gi)).toHaveLength(2);
  });
});
