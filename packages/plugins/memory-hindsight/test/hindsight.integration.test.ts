import { randomBytes } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHindsightClient } from '../src/hindsight.ts';
import { createMemoryProvider } from '../src/provider.ts';

// The client and the provider against the REAL Hindsight container (opt-in), run in `chunks` extraction mode: each retained item is stored as it
// is and no LLM is called, so the result is deterministic and needs no model key. The fake in tools/fake-hindsight answers like the engine
// because this file says what the engine does; if a Hindsight release changes one of these habits, this is the test that notices.
//
//   MANYTHREADS_HINDSIGHT_EXTRACTION_MODE=chunks MANYTHREADS_HINDSIGHT_SKIP_LLM_VERIFICATION=true pnpm memory:up   # http://127.0.0.1:8888
//   MANYTHREADS_TEST_HINDSIGHT_URL=http://127.0.0.1:8888 MANYTHREADS_TEST_HINDSIGHT_API_KEY=hs-manythreads-dev \
//     pnpm exec vitest run packages/plugins/memory-hindsight/test/hindsight.integration.test.ts
//   pnpm memory:down
//
// It creates banks named `team:itest-…-<random>` and deletes them afterwards, so it may run against a dev engine.

const URL_ = process.env['MANYTHREADS_TEST_HINDSIGHT_URL'] ?? '';
const KEY = process.env['MANYTHREADS_TEST_HINDSIGHT_API_KEY'] ?? 'hs-manythreads-dev';
const suite = URL_ === '' ? describe.skip : describe;
vi.setConfig({ testTimeout: 120_000 });

const run = randomBytes(4).toString('hex');
const SLUG_A = `itest-a-${run}`;
const SLUG_B = `itest-b-${run}`;
const SECRET_A = 'Project Falconwing launches on 9 March under codename Nightjar';
const SECRET_B = 'The Basilisk migration freezes writes on Friday evening';

const raw = async (method: string, path: string, body?: unknown, key: string | null = KEY): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
};
const enc = (bank: string): string => `/v1/default/banks/${encodeURIComponent(bank)}`;

suite('the memory client against the real Hindsight engine', () => {
  const client = createHindsightClient({ baseUrl: URL_ || null, apiKey: KEY });
  const A = `team:${SLUG_A}`;
  const B = `team:${SLUG_B}`;

  afterAll(async () => {
    for (const bank of [A, B]) await raw('DELETE', enc(bank));
  });

  beforeAll(async () => {
    expect((await raw('GET', '/health', undefined, null)).status).toBe(200);
  });

  it('refuses every call without the key, /health excepted', async () => {
    expect((await raw('POST', `${enc(A)}/memories/recall`, { query: 'x' }, null)).status).toBe(401);
    expect((await raw('POST', `${enc(A)}/memories/recall`, { query: 'x' }, 'wrong-key')).status).toBe(401);
  });

  it('a bank that was never created is a 404 on the wire, and the client creates it first', async () => {
    expect((await raw('POST', `${enc(A)}/memories/recall`, { query: 'x' })).status).toBe(404);
    expect(await client.recall(A, { query: 'anything' })).toEqual([]);
    expect((await raw('PUT', enc(A), {})).status).toBe(200);
  });

  it('retains with document id, tags, context and metadata, and recalls them from the bank asked', async () => {
    await client.retain(A, [{ content: SECRET_A, context: 'launch plan', tags: ['plan'], metadata: { run_id: 'r1', team: SLUG_A }, documentId: 'doc-a1' }]);
    await client.retain(B, [{ content: SECRET_B, documentId: 'doc-b1' }]);
    const hits = await client.recall(A, { query: 'When does Falconwing launch?' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ text: SECRET_A, context: 'launch plan', tags: ['plan'], documentId: 'doc-a1' });
    const tagged = await client.recall(A, { query: 'Falconwing', tags: ['plan'] });
    expect(tagged.map((f) => f.text)).toEqual([SECRET_A]);
    expect(await client.recall(A, { query: 'Falconwing', tags: ['nope'] })).toEqual([]);
  });

  it('what is retained in one bank never comes back from another — even for the other bank’s exact words', async () => {
    const stolen = await client.recall(B, { query: 'Falconwing launch codename Nightjar 9 March' });
    // The engine always ranks the bank it was asked about, so B's own fact may come back at a near-zero score; A's never does.
    expect(stolen.map((f) => f.text)).not.toContain(SECRET_A);
    expect(JSON.stringify(stolen)).not.toMatch(/Falconwing|Nightjar/);
    const reverse = await client.recall(A, { query: 'Basilisk migration freezes writes' });
    expect(JSON.stringify(reverse)).not.toMatch(/Basilisk/);
  });

  it('retaining under a document id again replaces it, and forgetting removes it; a repeat is false', async () => {
    await client.retain(A, [{ content: 'Falconwing now launches on 10 April', documentId: 'doc-a1' }]);
    const after = await client.recall(A, { query: 'Falconwing launches' });
    expect(after.map((f) => f.text)).toEqual(['Falconwing now launches on 10 April']);
    expect(await client.deleteDocument(A, 'doc-a1')).toBe(true);
    expect(await client.deleteDocument(A, 'doc-a1')).toBe(false);
    expect(await client.deleteDocument(`team:itest-never-${run}`, 'x')).toBe(false);
    expect(JSON.stringify(await client.recall(A, { query: 'Falconwing' }))).not.toMatch(/Falconwing/);
  });

  it('async retain answers at once with an operation', async () => {
    const out = await client.retain(A, [{ content: 'an async note about onboarding', documentId: 'as1' }], { async: true });
    expect(out).toMatchObject({ async: true });
  });

  it('a bank the engine lost while the client remembered it is created again, once', async () => {
    const remembered = createHindsightClient({ baseUrl: URL_, apiKey: KEY });
    await remembered.retain(B, [{ content: SECRET_B, documentId: 'doc-b1' }]);
    expect((await raw('DELETE', enc(B))).status).toBe(200);
    expect(await remembered.recall(B, { query: 'Basilisk' })).toEqual([]);
  });

  it('a bank id with a slash is not a route at all', async () => {
    expect((await raw('PUT', '/v1/default/banks/team%2Fx', {})).status).toBe(404);
  });

  it('the provider end to end: a run in team A and a run in team B each see only their own bank', async () => {
    const txFor = (slug: string): PluginTx => ({
      actor: { kind: 'bot', id: 'actor', workspaceId: 'ws' },
      async query() {
        return { rows: [{ run_id: `run-${slug}`, team_id: `id-${slug}`, team_slug: slug, bot_id: 'bot', person_scoped: false }] } as never;
      },
    });
    const provider = createMemoryProvider({ client: () => client });
    const bankA = await provider.forRun(txFor(SLUG_A));
    const bankB = await provider.forRun(txFor(SLUG_B));
    await bankA.retain([{ content: 'Okapi rollout is scheduled for the second sprint' }]);
    await bankB.retain([{ content: 'Quokka budget review happens in November' }]);
    const fromA = await bankA.recall({ query: 'Okapi rollout Quokka budget' });
    const fromB = await bankB.recall({ query: 'Okapi rollout Quokka budget' });
    expect(fromA.bank).toBe(A);
    expect(fromB.bank).toBe(B);
    expect(JSON.stringify(fromA.hits)).not.toMatch(/Quokka/);
    expect(JSON.stringify(fromB.hits)).not.toMatch(/Okapi/);
    expect(fromA.hits[0]!.text).toMatch(/Okapi/);
  });
});
