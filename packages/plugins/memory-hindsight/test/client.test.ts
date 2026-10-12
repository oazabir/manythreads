import { describe, expect, it } from 'vitest';
import { createHindsightClient, HindsightError, scrub, type HindsightTransport } from '../src/hindsight.ts';

// The client against a recording transport: what it sends (paths, encoding, bodies), what it makes of the answers, and what it does with the
// failures. The real engine's habits are in hindsight.integration.test.ts.

interface Sent {
  method: string;
  path: string;
  body: unknown;
  timeoutMs: number | undefined;
}

function transportOf(answer: (sent: Sent) => { status: number; body: unknown } | Error): { transport: HindsightTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    transport: {
      async request(method, path, body, options) {
        const entry: Sent = { method, path, body, timeoutMs: options?.timeoutMs };
        sent.push(entry);
        const out = answer(entry);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

describe('the Hindsight client', () => {
  it('creates a bank once, percent-encodes its id, and retains with the engine’s field names', async () => {
    const { transport, sent } = transportOf(() => ({ status: 200, body: { success: true, items_count: 1, async: false } }));
    const client = createHindsightClient({ baseUrl: null, apiKey: null, transport });
    const out = await client.retain('team:engineering', [{ content: 'We chose Postgres.', documentId: 'd1', tags: ['decision'], metadata: { run_id: 'r' } }]);
    await client.retain('team:engineering', [{ content: 'Second.' }]);
    expect(out).toEqual({ items: 1, async: false });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'PUT /v1/default/banks/team%3Aengineering',
      'POST /v1/default/banks/team%3Aengineering/memories',
      'POST /v1/default/banks/team%3Aengineering/memories',
    ]);
    expect(sent[1]!.body).toEqual({
      items: [{ content: 'We chose Postgres.', tags: ['decision'], metadata: { run_id: 'r' }, document_id: 'd1' }],
      async: false,
    });
  });

  it('retain takes the long budget, recall the short one', async () => {
    const { transport, sent } = transportOf((s) => ({ status: 200, body: s.path.endsWith('/recall') ? { results: [] } : {} }));
    const client = createHindsightClient({ baseUrl: null, apiKey: null, transport, retainTimeoutMs: 77_000 });
    await client.retain('team:a', [{ content: 'x' }]);
    await client.recall('team:a', { query: 'x' });
    expect(sent.find((s) => s.path.endsWith('/memories'))!.timeoutMs).toBe(77_000);
    expect(sent.find((s) => s.path.endsWith('/recall'))!.timeoutMs).toBeUndefined();
  });

  it('maps recall results and drops malformed entries', async () => {
    const { transport } = transportOf((s) =>
      s.method === 'PUT'
        ? { status: 200, body: {} }
        : {
            status: 200,
            body: {
              results: [
                { id: 'a', text: 'Alice works at Google', type: 'world', context: 'career', tags: ['hr', 3], document_id: 'doc-1' },
                { id: 'b' },
                null,
                { id: 'c', text: 'no extras' },
              ],
            },
          },
    );
    const facts = await createHindsightClient({ baseUrl: null, apiKey: null, transport }).recall('team:a', { query: 'alice', tags: ['hr'] });
    expect(facts).toEqual([
      { id: 'a', text: 'Alice works at Google', type: 'world', context: 'career', tags: ['hr'], documentId: 'doc-1' },
      { id: 'c', text: 'no extras', type: null, context: null, tags: [], documentId: null },
    ]);
  });

  it('treats a server with no create-bank call as fine, but any other refusal as an error', async () => {
    const missing = transportOf((s) => (s.method === 'PUT' ? { status: 405, body: {} } : { status: 200, body: { results: [] } }));
    await expect(createHindsightClient({ baseUrl: null, apiKey: null, transport: missing.transport }).recall('team:a', { query: 'x' })).resolves.toEqual([]);
    const denied = transportOf(() => ({ status: 401, body: { detail: 'Unauthorized' } }));
    await expect(createHindsightClient({ baseUrl: null, apiKey: null, transport: denied.transport }).recall('team:a', { query: 'x' })).rejects.toMatchObject({ status: 401 });
  });

  it('a transport failure is a HindsightError with status 0, and a missing URL says so', async () => {
    const broken = transportOf(() => new Error('connect ECONNREFUSED'));
    await expect(createHindsightClient({ baseUrl: null, apiKey: null, transport: broken.transport }).recall('team:a', { query: 'x' })).rejects.toMatchObject({
      name: 'HindsightError',
      status: 0,
    });
    const none = createHindsightClient({ baseUrl: null, apiKey: null });
    expect(none.enabled).toBe(false);
    await expect(none.recall('team:a', { query: 'x' })).rejects.toThrow(/no Hindsight URL/);
  });

  it('re-creates a bank the engine lost, once, and then gives up', async () => {
    let lost = true;
    const { transport, sent } = transportOf((s) => {
      if (s.method === 'PUT') return { status: 200, body: {} };
      if (lost) {
        lost = false;
        return { status: 404, body: { detail: "Bank 'team:a' not found" } };
      }
      return { status: 200, body: { results: [{ id: 'x', text: 'back' }] } };
    });
    const client = createHindsightClient({ baseUrl: null, apiKey: null, transport });
    expect((await client.recall('team:a', { query: 'x' })).map((f) => f.text)).toEqual(['back']);
    expect(sent.map((s) => s.method)).toEqual(['PUT', 'POST', 'PUT', 'POST']);
    const gone = transportOf((s) => (s.method === 'PUT' ? { status: 200, body: {} } : { status: 404, body: { detail: "Bank 'team:a' not found" } }));
    await expect(createHindsightClient({ baseUrl: null, apiKey: null, transport: gone.transport }).recall('team:a', { query: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(gone.sent.filter((s) => s.method === 'POST')).toHaveLength(2);
  });

  it('deleting a document that is not there is false, not an error', async () => {
    const { transport, sent } = transportOf((s) => ({ status: s.path.includes('gone') ? 404 : 200, body: {} }));
    const client = createHindsightClient({ baseUrl: null, apiKey: null, transport });
    expect(await client.deleteDocument('team:a', 'run:1/x')).toBe(true);
    expect(await client.deleteDocument('team:a', 'gone')).toBe(false);
    expect(sent[0]!.path).toBe('/v1/default/banks/team%3Aa/documents/run%3A1%2Fx');
  });

  it('scrubs credentials out of an error message', () => {
    const err = new HindsightError('/x', { status: 500, body: 'failed with Bearer abcdefghijklmnop and key sk-live1234567890 and ' + 'z'.repeat(60) });
    expect(err.message).not.toMatch(/abcdefghijklmnop|sk-live1234567890|zzzzzzzzzz/);
    expect(scrub('Bearer short')).toBe('Bearer short');
  });

  it('scrubs the literal API key it was configured with, whatever shape it has', async () => {
    const { transport } = transportOf(() => ({ status: 500, body: { detail: 'bad credential hs-dev-key echoed' } }));
    const client = createHindsightClient({ baseUrl: null, apiKey: 'hs-dev-key', transport });
    const err = (await client.recall('team:a', { query: 'x' }).then(() => null, (e: unknown) => e as Error))!;
    expect(err.message).not.toContain('hs-dev-key');
    expect(err.message).toContain('[redacted]');
  });
});
