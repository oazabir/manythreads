import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';

// P20-06 through the real server: a person makes a base of their own, uploads, searches, deletes; nobody else sees any of it; a guest has no space; a
// bot's knowledge.search needs the gateway (gateway-mcp/test/spaces-every-read-tool.test.ts) and the database rule is in rls/personal.test.ts.

const { omar, nadia, rafi, lena } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;
interface Doc { id: string; name: string; status: string; version: number; repoPath: string | null }
interface Hit { chunkId: string; text: string; space?: string; repoPath: string | null }

const upload = async (who: typeof omar, base: string, name: string, body: string): Promise<{ status: number; body: { outcome: string; document: Doc } }> => {
  const res = await fetch(`${world.server.url}/api/me/knowledge/${base}/documents?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), 'content-type': 'application/octet-stream' },
    body: Buffer.from(body) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 ORDER BY id`, [type]))).rows.map((r) => r.payload);

beforeAll(async () => {
  world = await createWorld();
}, 180_000);
afterAll(async () => {
  await world?.close();
});

describe('a person\'s knowledge bases', () => {
  it('makes a base, uploads a note, finds it by words, and keeps no copy in any repo', async () => {
    const made = await world.call<{ base: { slug: string; space: string; personId: string; state: string } }>(nadia, 'POST', '/api/me/knowledge', { slug: 'notes', name: 'Notes' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.base).toMatchObject({ slug: 'notes', state: 'empty', personId: nadia.personId, space: `person:${nadia.personId}` });
    expect((await world.call(nadia, 'POST', '/api/me/knowledge', { slug: 'notes' })).status).toBe(409);

    const up = await upload(nadia, 'notes', 'Tax.md', '# Tax\n\nMy tax identifier is kept in the blue binder, second shelf.\n');
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body).toMatchObject({ outcome: 'added', document: { name: 'Tax.md', status: 'indexed', version: 1 } });
    expect(up.body.document.repoPath ?? null).toBeNull();

    const found = await world.call<{ hits: Hit[] }>(nadia, 'GET', '/api/me/knowledge/notes/search?q=blue%20binder');
    expect(found.body.hits.map((h) => h.space)).toEqual([`person:${nadia.personId}`]);
    expect(found.body.hits[0]?.text).toContain('blue binder');
    const detail = await world.call<{ base: { state: string; documentCount: number }; documents: Doc[] }>(nadia, 'GET', '/api/me/knowledge/notes');
    expect(detail.body.base).toMatchObject({ state: 'ready', documentCount: 1 });
    expect((await world.call<{ bases: Array<{ slug: string }> }>(nadia, 'GET', '/api/me/knowledge')).body.bases.map((b) => b.slug)).toEqual(['notes']);
    expect((await events('knowledge.personal_base.changed')).map((e) => e['change'])).toEqual(['created', 'document_added']);
  });

  it('shows nothing to anyone else, an admin included, and gives a guest no space', async () => {
    for (const other of [rafi, omar]) {
      expect((await world.call<{ bases: unknown[] }>(other, 'GET', '/api/me/knowledge')).body.bases, other.key).toEqual([]);
      expect((await world.call(other, 'GET', '/api/me/knowledge/notes')).status, other.key).toBe(404);
      expect((await upload(other, 'notes', 'x.md', '# x\n\nplanted text here\n')).status, other.key).toBe(404);
    }
    expect((await world.call(lena, 'GET', '/api/me/knowledge')).status).toBe(403);
    expect((await world.call(lena, 'POST', '/api/me/knowledge', { slug: 'mine' })).status).toBe(403);
    expect((await world.call(null, 'GET', '/api/me/knowledge')).status).toBe(401);
  });

  it('does not show up in a team\'s knowledge, and removes a document and then the base', async () => {
    const detail = await world.call<{ documents: Doc[] }>(nadia, 'GET', '/api/me/knowledge/notes');
    const docId = detail.body.documents[0]!.id;
    expect((await world.call(rafi, 'DELETE', `/api/me/knowledge/notes/documents/${docId}`)).status).toBe(404);
    expect((await world.call(nadia, 'DELETE', `/api/me/knowledge/notes/documents/${docId}`)).status).toBe(200);
    expect((await world.call<{ hits: Hit[] }>(nadia, 'GET', '/api/me/knowledge/notes/search?q=blue%20binder')).body.hits).toEqual([]);
    expect((await world.call(nadia, 'DELETE', '/api/me/knowledge/notes')).status).toBe(200);
    expect((await world.call(nadia, 'GET', '/api/me/knowledge/notes')).status).toBe(404);
    expect((await events('knowledge.personal_base.changed')).map((e) => e['change'])).toEqual(['created', 'document_added', 'document_removed', 'deleted']);
    // the events carry ids and counts, never a name or a text
    expect(JSON.stringify(await events('knowledge.personal_base.changed'))).not.toMatch(/notes|Tax|binder/);
  });

  it('refuses the eleventh base with a plain client error, keeps the ten, and makes room when one is deleted', async () => {
    for (let n = 1; n <= 10; n += 1) {
      const made = await world.call(omar, 'POST', '/api/me/knowledge', { slug: `cap-${n}`, name: `Cap ${n}` });
      expect(made.status, `base ${n}: ${JSON.stringify(made.body)}`).toBe(201);
    }
    const eleventh = await world.call<{ error?: { message?: string } }>(omar, 'POST', '/api/me/knowledge', { slug: 'cap-11', name: 'Cap 11' });
    expect(eleventh.status).toBeGreaterThanOrEqual(400);
    expect(eleventh.status).toBeLessThan(500);
    const list = (await world.call<{ bases: Array<{ slug: string }> }>(omar, 'GET', '/api/me/knowledge')).body.bases.map((b) => b.slug);
    expect(list).toHaveLength(10);
    expect(list).not.toContain('cap-11');
    // the cap is per person: Rafi still makes his own
    expect((await world.call(rafi, 'POST', '/api/me/knowledge', { slug: 'cap-1', name: 'Rafi cap' })).status).toBe(201);
    expect((await world.call(omar, 'DELETE', '/api/me/knowledge/cap-10')).status).toBeLessThan(300);
    expect((await world.call(omar, 'POST', '/api/me/knowledge', { slug: 'cap-11', name: 'Cap 11' })).status).toBe(201);
  });
});
