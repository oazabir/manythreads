import { describe, expect, it } from 'vitest';
import { createWsHub, type WsPeer } from '../../src/index.ts';

function peer(): WsPeer & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (d) => void sent.push(JSON.parse(d)) };
}

describe('ws hub', () => {
  const hub = createWsHub();
  hub.on('echo', (m) => ({ type: 'echoed', id: m.id, payload: m.payload }));
  hub.on('boom', () => {
    throw new Error('secret detail');
  });
  hub.on('bad-reply', () => ({ type: '', id: 'x', payload: {} }));

  it('dispatches a valid envelope and validates the reply', async () => {
    const p = peer();
    await hub.receive(p, JSON.stringify({ type: 'echo', id: '1', payload: { a: 1 } }));
    expect(p.sent).toEqual([{ type: 'echoed', id: '1', payload: { a: 1 } }]);
  });

  it('rejects non-JSON, missing fields and extra keys with an error envelope', async () => {
    const p = peer();
    await hub.receive(p, 'not json');
    await hub.receive(p, JSON.stringify({ type: 'echo', payload: {} }));
    await hub.receive(p, JSON.stringify({ type: 'echo', id: '7', payload: {}, extra: true }));
    expect(p.sent).toHaveLength(3);
    for (const m of p.sent as { type: string; payload: { code: string } }[]) {
      expect(m.type).toBe('error');
      expect(m.payload.code).toBe('validation_failed');
    }
    expect((p.sent[1] as { payload: { path: string[] } }).payload.path).toEqual(['id']);
    expect((p.sent[2] as { id: string }).id).toBe('7');
  });

  it('answers unknown types with not_found and hides handler failures', async () => {
    const p = peer();
    await hub.receive(p, JSON.stringify({ type: 'nope', id: '2', payload: {} }));
    await hub.receive(p, JSON.stringify({ type: 'boom', id: '3', payload: {} }));
    await hub.receive(p, JSON.stringify({ type: 'bad-reply', id: '4', payload: {} }));
    expect(p.sent.map((m) => (m as { payload: { code: string } }).payload.code)).toEqual(['not_found', 'internal', 'internal']);
    expect(JSON.stringify(p.sent)).not.toContain('secret detail');
  });

  it('send validates outbound envelopes', () => {
    expect(() => hub.send(peer(), { type: 'x', id: '', payload: {} })).toThrow();
  });
});
