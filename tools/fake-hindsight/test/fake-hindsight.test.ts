import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeHindsight, type FakeHindsight } from '../src/server.ts';

// The fake keeps one store per bank and records which bank each request named: the memory cross-team suite stands on both.

let fake: FakeHindsight;
const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${fake.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

beforeAll(async () => {
  fake = await startFakeHindsight({ apiKey: 'k' });
});
afterAll(async () => {
  await fake.close();
});

const auth = { authorization: 'Bearer k' };
const retain = (bank: string, content: string, documentId?: string) =>
  send('POST', `/v1/default/banks/${encodeURIComponent(bank)}/memories`, { items: [{ content, ...(documentId ? { document_id: documentId } : {}) }] }, auth);
const recall = (bank: string, query: string) => send('POST', `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, { query }, auth);

describe('fake-hindsight', () => {
  it('refuses a call without the api key and records the refusal', async () => {
    expect((await send('GET', '/health')).status).toBe(401);
    expect(fake.state.calls.at(-1)).toMatchObject({ authorized: false });
    expect((await send('GET', '/health', undefined, auth)).status).toBe(200);
  });

  it('recall searches the bank in the path and no other', async () => {
    await retain('team:a', 'Falcon launches in March');
    await retain('team:b', 'Nightjar ships in June');
    expect(((await recall('team:a', 'when does Falcon launch')).body['results'] as unknown[]).length).toBe(1);
    expect((await recall('team:a', 'Nightjar')).body['results']).toEqual([]);
    expect(fake.banksTouched()).toEqual(expect.arrayContaining(['team:a', 'team:b']));
  });

  it('state shows each bank and the recent calls, and needs the key like any other route', async () => {
    expect((await send('GET', '/state')).status).toBe(401);
    await retain('team:state', 'the launch codename is Nightjar');
    const state = (await send('GET', '/state', undefined, auth)).body;
    const banks = state['banks'] as Record<string, Array<Record<string, unknown>>>;
    expect(banks['team:state']!.map((f) => f['text'])).toEqual(['the launch codename is Nightjar']);
    expect(fake.state.calls.at(-1)).toMatchObject({ method: 'GET', path: '/state', authorized: true });
  });

  it('retaining under a document id again replaces it; deleting an unknown document is a 404', async () => {
    await retain('team:c', 'first version of the plan', 'plan');
    await retain('team:c', 'second version of the plan', 'plan');
    expect(fake.state.banks.get('team:c')!.map((f) => f.text)).toEqual(['second version of the plan']);
    expect((await send('DELETE', `/v1/default/banks/team%3Ac/documents/plan`, undefined, auth)).status).toBe(200);
    expect((await send('DELETE', `/v1/default/banks/team%3Ac/documents/plan`, undefined, auth)).status).toBe(404);
  });
});
