import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';
import { minimalPdf } from './extract.test.ts';

// P8-07, P8-08 through the real server: a lead makes a base and uploads, the file is read off the request path, its passages are searchable with a
// citation (document, version, section, place), the same content again changes nothing, changed content is version 2 and the old passage still resolves
// and says the source changed since; a file that cannot be read says why; a member reads, a guest and an outsider see nothing.

const { omar, nadia, sameera, lena, tariq } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Doc { id: string; name: string; kind: string; version: number; status: string; reason: string | null; chunkCount: number; repoPath: string | null; shortHash: string; size: number }
interface Upload { outcome: string; document: Doc }
interface Hit { chunkId: string; documentName: string; version: number; currentVersion: number; sourceChanged: boolean; section: string | null; offsetStart: number; offsetEnd: number; text: string; score: number; repoPath: string | null }

const upload = async (who: typeof omar, name: string, body: Uint8Array | string, base = 'handbook', team = 'engineering'): Promise<{ status: number; body: Upload & { error?: { message: string } } }> => {
  const res = await fetch(`${world.server.url}/api/teams/${team}/knowledge/${base}/documents?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), 'content-type': 'application/octet-stream' },
    body: (typeof body === 'string' ? Buffer.from(body) : body) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const search = (who: typeof omar, q: string, base = 'handbook') => world.call<{ mode: string; hits: Hit[] }>(who, 'GET', `/api/teams/engineering/knowledge/${base}/search?q=${encodeURIComponent(q)}`);
const detail = (who: typeof omar, base = 'handbook') => world.call<{ base: { state: string; documentCount: number; failedCount: number; chunkCount: number; repoFolder: string }; documents: Doc[]; canWrite: boolean }>(who, 'GET', `/api/teams/engineering/knowledge/${base}`);
let since = new Date(0);
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND occurred_at >= $2 ORDER BY id`, [type, since]))).rows.map((r) => r.payload);

const REFUNDS_V1 = '# Refund policy\n\nRefunds are paid within 14 days of the request. Send the order number to billing.\n\n## Exceptions\n\nGift cards cannot be refunded.\n';
const REFUNDS_V2 = '# Refund policy\n\nRefunds are paid within 30 days of the request. Send the order number to billing.\n\n## Exceptions\n\nGift cards cannot be refunded.\n';

beforeAll(async () => {
  world = await createWorld();
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
}, 180_000);

afterAll(async () => {
  await world?.close();
});

describe('bases', () => {
  it('a lead creates a base; a member, an outsider and a guest cannot, and a repeat is refused', async () => {
    const made = await world.call<{ base: { slug: string; state: string; repoFolder: string } }>(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'handbook', name: 'Handbook' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.base).toMatchObject({ slug: 'handbook', state: 'empty', repoFolder: 'knowledge/handbook' });
    expect((await world.call(nadia, 'POST', '/api/teams/engineering/knowledge', { slug: 'mine' })).status).toBe(403);
    expect((await world.call(sameera, 'POST', '/api/teams/engineering/knowledge', { slug: 'mine' })).status).toBe(403);
    expect((await world.call(lena, 'POST', '/api/teams/engineering/knowledge', { slug: 'mine' })).status).toBe(403);
    expect((await world.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'handbook' })).status).toBe(409);
    expect((await world.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'Not A Slug' })).status).toBe(400);
    expect((await events('knowledge.base.created')).map((e) => e['slug'])).toEqual(['handbook']);
  });

  it('a member reads the list and the base, and is told they cannot write; an outsider and a guest read nothing', async () => {
    const list = await world.call<{ bases: Array<{ slug: string }>; canWrite: boolean; searchMode: string }>(nadia, 'GET', '/api/teams/engineering/knowledge');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ canWrite: false, searchMode: 'lexical' });
    expect(list.body.bases.map((b) => b.slug)).toEqual(['handbook']);
    expect((await world.call<{ canWrite: boolean }>(omar, 'GET', '/api/teams/engineering/knowledge')).body.canWrite).toBe(true);
    expect((await world.call(sameera, 'GET', '/api/teams/engineering/knowledge')).status).toBe(403);
    expect((await world.call(lena, 'GET', '/api/teams/engineering/knowledge')).status).toBe(403);
    expect((await world.call(nadia, 'GET', '/api/teams/engineering/knowledge/nothing')).status).toBe(404);
    expect((await world.call(null, 'GET', '/api/teams/engineering/knowledge')).status).toBe(401);
  });
});

describe('upload, version and search', () => {
  it('a Markdown file is read, indexed and keeps a readable copy in the team repo', async () => {
    const up = await upload(omar, 'Refund policy.md', REFUNDS_V1);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.outcome).toBe('added');
    expect(up.body.document).toMatchObject({ name: 'Refund policy.md', kind: 'markdown', version: 1, status: 'indexed', reason: null, repoPath: 'knowledge/handbook/refund-policy.md' });
    expect(up.body.document.chunkCount).toBeGreaterThan(0);
    expect(up.body.document.shortHash).toMatch(/^[0-9a-f]{12}$/);
    const blob = await world.call<{ content: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=knowledge%2Fhandbook%2Frefund-policy.md');
    expect(blob.status, JSON.stringify(blob.body)).toBe(200);
    expect(blob.body.content).toContain('Refunds are paid within 14 days');
    expect(blob.body.content).toContain('version: 1');
    const sources = await world.call<{ content: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=knowledge%2Fhandbook%2Fsources.yaml');
    expect(sources.body.content).toContain('Refund policy.md');
  });

  it('a search finds the passage with its citation: document, version, section and place in the converted text', async () => {
    const res = await search(nadia, 'how long do refunds take');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const hit = res.body.hits[0]!;
    expect(hit).toMatchObject({ documentName: 'Refund policy.md', version: 1, currentVersion: 1, sourceChanged: false });
    expect(hit.text).toContain('14 days');
    expect(hit.section).toBe('Refund policy');
    expect(hit.offsetEnd).toBeGreaterThan(hit.offsetStart);
    expect(hit.score).toBeGreaterThan(0.2);
    expect((await search(nadia, 'refund policy paid days')).body.hits[0]!.score).toBeGreaterThan(0.6);
    expect(hit.repoPath).toBe('knowledge/handbook/refund-policy.md');
  });

  it('ranks the passage that holds more of the question’s words first, and finds nothing for a question the base does not answer', async () => {
    const gift = (await search(nadia, 'can gift cards be refunded')).body.hits;
    expect(gift[0]?.text).toContain('Gift cards');
    expect(gift[0]?.section).toBe('Refund policy > Exceptions');
    const none = await search(nadia, 'what is the weather in Lisbon');
    expect(none.body.hits).toEqual([]);
  });

  it('the same content again changes nothing: no new version, no new passages, no event', async () => {
    const before = (await detail(omar)).body;
    const again = await upload(omar, 'Refund policy.md', REFUNDS_V1);
    expect(again.body.outcome).toBe('unchanged');
    expect(again.body.document.version).toBe(1);
    const after = (await detail(omar)).body;
    expect(after.base.chunkCount).toBe(before.base.chunkCount);
    expect((await events('knowledge.document.added')).length).toBe(1);
    // the name matches whatever the case
    expect((await upload(omar, 'REFUND POLICY.MD', REFUNDS_V1)).body.outcome).toBe('unchanged');
  });

  it('changed content is version 2: only the new text is searched, and the old passage still resolves and says the source changed since', async () => {
    const old = (await search(nadia, 'refunds paid days')).body.hits[0]!;
    const up = await upload(omar, 'Refund policy.md', REFUNDS_V2);
    expect(up.body.outcome).toBe('updated');
    expect(up.body.document.version).toBe(2);
    const now = (await search(nadia, 'refunds paid days')).body.hits;
    expect(now[0]).toMatchObject({ version: 2, currentVersion: 2, sourceChanged: false });
    expect(now[0]?.text).toContain('30 days');
    expect(now.every((h) => !h.text.includes('14 days'))).toBe(true);
    const cited = await world.call<{ hit: Hit }>(nadia, 'GET', `/api/teams/engineering/knowledge-chunks/${old.chunkId}`);
    expect(cited.status, JSON.stringify(cited.body)).toBe(200);
    expect(cited.body.hit).toMatchObject({ version: 1, currentVersion: 2, sourceChanged: true });
    expect(cited.body.hit.text).toContain('14 days');
    const added = await events('knowledge.document.added');
    expect(added.map((e) => [e['version'], e['replaced']])).toEqual([[1, false], [2, true]]);
    // a person outside the team cannot resolve it
    expect((await world.call(sameera, 'GET', `/api/teams/engineering/knowledge-chunks/${old.chunkId}`)).status).toBe(403);
  });

  it('reads a CSV and a PDF', async () => {
    const csv = await upload(omar, 'plans.csv', 'plan,price,seats\nStarter,9 dollars,3\nBusiness,49 dollars,25\n');
    expect(csv.body).toMatchObject({ outcome: 'added', document: { kind: 'csv', status: 'indexed' } });
    const row = (await search(nadia, 'Business plan price')).body.hits[0]!;
    expect(row.text).toContain('plan: Business; price: 49 dollars; seats: 25');
    expect(row.section).toBe('Rows 1 to 2');

    const pdf = await upload(omar, 'Onboarding guide.pdf', minimalPdf('New staff receive a laptop on the first morning.'));
    expect(pdf.body).toMatchObject({ outcome: 'added', document: { kind: 'pdf', status: 'indexed' } });
    const page = (await search(nadia, 'laptop first morning')).body.hits[0]!;
    expect(page).toMatchObject({ documentName: 'Onboarding guide.pdf', section: 'Page 1' });
  });
});

describe('files that cannot be read, and files that are refused', () => {
  it('a broken PDF becomes a failed document with a plain reason; the base asks for attention; Re-sync tries again; removing it clears the state', async () => {
    const up = await upload(omar, 'Broken.pdf', enc('%PDF-1.4\nthis is not really a pdf'));
    expect(up.status).toBe(200);
    expect(up.body.outcome).toBe('failed');
    expect(up.body.document).toMatchObject({ status: 'failed', chunkCount: 0, version: 1 });
    expect(up.body.document.reason).toMatch(/PDF/);
    const d = (await detail(omar)).body;
    expect(d.base.state).toBe('attention');
    expect(d.base.failedCount).toBe(1);
    expect((await search(nadia, 'really a pdf')).body.hits).toEqual([]);

    const again = await world.call<{ result: { failed: number; checked: number }; documents: Doc[] }>(omar, 'POST', '/api/teams/engineering/knowledge/handbook/resync');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.result.failed).toBe(1);
    expect(again.body.documents.find((x) => x.name === 'Broken.pdf')?.status).toBe('failed');

    const gone = await world.call(omar, 'DELETE', `/api/teams/engineering/knowledge/handbook/documents/${up.body.document.id}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect((await detail(omar)).body.base.state).toBe('ready');
    expect((await events('knowledge.document.removed')).length).toBe(1);
  });

  it('a re-upload that cannot be read keeps the version that works and says so', async () => {
    const bad = await upload(omar, 'plans.csv', 'only a header line\n');
    expect(bad.body.outcome).toBe('failed');
    expect(bad.body.document).toMatchObject({ status: 'indexed', version: 1 });
    expect(bad.body.document.reason).toMatch(/version 1 is still in use/);
    expect((await search(nadia, 'Business plan price')).body.hits[0]?.text).toContain('49 dollars');
    // the good file again: still version 1, and the warning about the newer file is put away
    const again = await upload(omar, 'plans.csv', 'plan,price,seats\nStarter,9 dollars,3\nBusiness,49 dollars,25\n');
    expect(again.body.outcome).toBe('unchanged');
    expect(again.body.document).toMatchObject({ version: 1, reason: null });
  });

  it('a new document never overwrites a file of the team that sits where its copy would go', async () => {
    const taken = await world.call(omar, 'POST', '/api/teams/engineering/repo/commit', {
      changes: [{ op: 'put', path: 'knowledge/handbook/travel-rules.md', content: '# Travel\n\nBook trains first.\n' }],
      message: 'a file nobody has re-read yet',
    });
    expect(taken.status).toBe(201);
    const up = await upload(omar, 'Travel rules.md', '# Travel rules\n\nFlights over six hours may be booked in economy plus.\n');
    expect(up.body.document.repoPath).toBe('knowledge/handbook/travel-rules-2.md');
    const theirs = await world.call<{ content: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=knowledge%2Fhandbook%2Ftravel-rules.md');
    expect(theirs.body.content).toContain('Book trains first.');
    // read again, their file becomes a document of its own next to ours
    const res = await world.call<{ result: { added: number } }>(omar, 'POST', '/api/teams/engineering/knowledge/handbook/resync');
    expect(res.body.result.added).toBe(1);
  });

  it('refuses a file type nothing reads, an empty file, a file over the limit, and an upload by a member', async () => {
    expect((await upload(omar, 'slides.pptx', 'x')).status).toBe(415);
    expect((await upload(omar, 'empty.md', '')).status).toBe(400);
    expect((await upload(omar, 'big.txt', 'x'.repeat(4096))).status).toBe(200);
    process.env['MANYTHREADS_KNOWLEDGE_MAX_BYTES'] = '2048';
    try {
      const big = await upload(omar, 'bigger.txt', 'x'.repeat(4096));
      expect(big.status).toBe(413);
    } finally {
      delete process.env['MANYTHREADS_KNOWLEDGE_MAX_BYTES'];
    }
    expect((await upload(nadia, 'mine.md', '# hi')).status).toBe(403);
    expect((await upload(sameera, 'mine.md', '# hi')).status).toBe(403);
    expect((await upload(omar, 'x.md', '# hi', 'no-such-base')).status).toBe(404);
    expect((await world.call(nadia, 'POST', '/api/teams/engineering/knowledge/handbook/resync')).status).toBe(403);
  });
});

describe('re-sync reads the repo folder', () => {
  const commit = (changes: unknown[]) => world.call(omar, 'POST', '/api/teams/engineering/repo/commit', { changes, message: 'edit the handbook' });

  it('a converted file edited in the repo becomes the next version; a new Markdown file in the folder becomes a document; a repo document whose file is gone is removed', async () => {
    const blob = await world.call<{ content: string; blobSha: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=knowledge%2Fhandbook%2Frefund-policy.md');
    const edited = blob.body.content.replace('30 days', '45 days');
    expect((await commit([{ op: 'put', path: 'knowledge/handbook/refund-policy.md', content: edited, baseBlobSha: blob.body.blobSha }, { op: 'put', path: 'knowledge/handbook/shipping.md', content: '# Shipping\n\nOrders ship within two working days.\n' }])).status).toBe(201);

    const res = await world.call<{ result: { checked: number; updated: number; added: number; removed: number; failed: number }; documents: Doc[] }>(omar, 'POST', '/api/teams/engineering/knowledge/handbook/resync');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({ updated: 1, added: 1, removed: 0, failed: 0 });
    expect(res.body.documents.find((d) => d.name === 'Refund policy.md')?.version).toBe(3);
    const shipping = res.body.documents.find((d) => d.name === 'shipping.md');
    expect(shipping).toMatchObject({ kind: 'markdown', version: 1, status: 'indexed' });
    expect((await search(nadia, 'refunds paid days')).body.hits[0]?.text).toContain('45 days');
    expect((await search(nadia, 'orders ship working days')).body.hits[0]?.documentName).toBe('shipping.md');

    // nothing changed since: the second re-sync moves nothing and writes no event
    const resyncs = (await events('knowledge.base.resynced')).length;
    const quiet = await world.call<{ result: { updated: number; added: number; removed: number } }>(omar, 'POST', '/api/teams/engineering/knowledge/handbook/resync');
    expect(quiet.body.result).toMatchObject({ updated: 0, added: 0, removed: 0 });
    expect((await events('knowledge.base.resynced')).length).toBe(resyncs);

    const file = await world.call<{ blobSha: string }>(omar, 'GET', '/api/teams/engineering/repo/blob?path=knowledge%2Fhandbook%2Fshipping.md');
    expect((await commit([{ op: 'delete', path: 'knowledge/handbook/shipping.md', baseBlobSha: file.body.blobSha }])).status).toBe(201);
    const after = await world.call<{ result: { removed: number } }>(omar, 'POST', '/api/teams/engineering/knowledge/handbook/resync');
    expect(after.body.result.removed).toBe(1);
    expect((await search(nadia, 'orders ship working days')).body.hits.map((h) => h.documentName)).not.toContain('shipping.md');
  });

  it('writes content-free events: ids, kinds and counts, never a file name or its text', async () => {
    const all = [...(await events('knowledge.document.added')), ...(await events('knowledge.base.resynced')), ...(await events('knowledge.base.created')), ...(await events('knowledge.document.removed'))];
    expect(all.length).toBeGreaterThan(5);
    const text = JSON.stringify(all);
    for (const secret of ['Refund policy', 'refund-policy', 'Broken.pdf', 'plans.csv', 'Refunds are paid', 'shipping.md']) expect(text).not.toContain(secret);
  });
});

describe('removing', () => {
  it('a lead removes a base with its documents; a member cannot; the passages go with it', async () => {
    expect((await world.call(nadia, 'DELETE', '/api/teams/engineering/knowledge/handbook')).status).toBe(403);
    const gone = await world.call<{ removed: boolean; documents: number }>(omar, 'DELETE', '/api/teams/engineering/knowledge/handbook');
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body.documents).toBeGreaterThan(1);
    const left = await world.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT (SELECT count(*) FROM app.knowledge_chunks) + (SELECT count(*) FROM app.knowledge_documents) AS n')).rows[0]!.n));
    expect(left).toBe(0);
    expect((await events('knowledge.base.deleted')).map((e) => e['documents'])).toEqual([gone.body.documents]);
  });

  it('leaves a lead of another team unable to write here', async () => {
    expect((await world.call(tariq, 'POST', '/api/teams/engineering/knowledge', { slug: 'sneak' })).status).toBe(403);
  });
});
