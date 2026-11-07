import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  knowledgeMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-07: who may read a team's knowledge bases (the people of the team, not a guest), who may write them (team leads and workspace admins), and the
// rules the database keeps whatever the code does: the caps, the shape of a chunk, and a child row that cannot name another team's parent.

import { backfillEmbeddings, EMBEDDING_DIMENSIONS } from '../../src/embed.ts';
import { searchKnowledge } from '../../src/search.ts';

const { omar, nadia, priya, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = (p: Persona, table: string): Promise<number> =>
  as(p, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table}`)).rows[0]?.n ?? 0));

/** A base with a source, a document and two chunks, written by the system role (the rows a lead's upload would make). */
async function seedBase(team: string, slug: string): Promise<{ base: string; doc: string; chunk: string }> {
  return sys(async (tx) => {
    const base = (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, team, slug])).rows[0]!.id;
    const source = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload') RETURNING id`, [base, team])).rows[0]!.id;
    const doc = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status, chunk_count, indexed_at)
         VALUES ($1, $2, $3, 'Refund policy.md', 'refund-policy', 'markdown', 120, repeat('a', 64), 'indexed', 2, now()) RETURNING id`,
        [base, team, source],
      )
    ).rows[0]!.id;
    const chunk = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, 0, 1, 'Refunds are paid within 14 days.', 0, 32), ($1, $2, $3, 1, 1, 'Shipping takes two days.', 34, 58) RETURNING id`,
        [doc, base, team],
      )
    ).rows[0]!.id;
    return { base, doc, chunk };
  });
}

let eng: { base: string; doc: string; chunk: string };
let mkt: { base: string; doc: string; chunk: string };

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, knowledgeMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  eng = await seedBase(ENG, 'handbook');
  mkt = await seedBase(MKT, 'brand');
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const TABLES = ['knowledge_bases', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks'];

describe('knowledge tables follow the RLS rules', () => {
  it('pass the harness and read without a per-row policy helper', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of TABLES) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('the people of a team read its bases, documents and passages, and only theirs', async () => {
    for (const table of TABLES) {
      expect(await count(nadia, table), `nadia ${table}`).toBe(table === 'knowledge_chunks' ? 2 : 1);
      expect(await count(tariq, table), `tariq ${table}`).toBe(table === 'knowledge_chunks' ? 2 : 1);
    }
    // priya is on both teams
    expect(await count(priya, 'knowledge_bases')).toBe(2);
    // sameera is on neither
    for (const table of TABLES) expect(await count(sameera, table), `sameera ${table}`).toBe(0);
    const nadiaSees = await as(nadia, async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.knowledge_bases')).rows.map((r) => r.slug));
    expect(nadiaSees).toEqual(['handbook']);
  });

  it('a workspace admin reads every team’s, and a guest reads nothing', async () => {
    expect(await count(omar, 'knowledge_bases')).toBe(2);
    for (const table of TABLES) expect(await count(lena, table), `lena ${table}`).toBe(0);
  });

  it('a team lead or a workspace admin writes; a member and an outsider cannot', async () => {
    // omar leads Engineering and is a workspace admin; tariq leads Marketing
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, 'runbooks', 'Runbooks')`, [omar.workspaceId, ENG])))).toBeUndefined();
    expect(await code(as(tariq, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, 'press', 'Press')`, [omar.workspaceId, MKT])))).toBeUndefined();
    // a lead of Marketing does not write to Engineering
    expect(await code(as(tariq, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, 'sneak', 'Sneak')`, [omar.workspaceId, ENG])))).toBe('42501');
    // a member of the team and a guest cannot
    for (const person of [nadia, lena, sameera]) {
      expect(await code(as(person, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, 'mine', 'Mine')`, [omar.workspaceId, ENG]))), person.name).toBe('42501');
    }
    // an update or delete a member tries changes nothing (the row is visible but the write policy filters it)
    await as(nadia, (tx) => tx.query(`UPDATE app.knowledge_documents SET name = 'Hijacked.md' WHERE id = $1`, [eng.doc]));
    await as(nadia, (tx) => tx.query(`DELETE FROM app.knowledge_chunks WHERE id = $1`, [eng.chunk]));
    const doc = await sys(async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.knowledge_documents WHERE id = $1', [eng.doc])).rows[0]);
    expect(doc?.name).toBe('Refund policy.md');
    expect(await count(omar, 'knowledge_chunks')).toBe(4);
  });
});

describe('knowledge tables keep their own rules', () => {
  it('a document, a source and a passage cannot name another team’s base', async () => {
    // a document of the Engineering base filed under the Marketing team id
    expect(
      await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status) SELECT $1, $2, id, 'x.md', 'x', 'markdown', 1, repeat('b', 64), 'failed' FROM app.knowledge_sources WHERE base_id = $1`, [eng.base, MKT]))),
    ).toBe('23503');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, 5, 1, 'x', 0, 1)`, [eng.doc, eng.base, MKT])))).toBe('23503');
  });

  it('a passage is 1 to 2000 characters, with its place inside the text, and one per document, version and position', async () => {
    const chunk = (text: string, start: number, end: number, ordinal: number, version = 1): Promise<string | undefined> =>
      code(sys((tx) => tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [eng.doc, eng.base, ENG, ordinal, version, text, start, end])));
    expect(await chunk('', 0, 0, 10)).toBe('23514');
    expect(await chunk('x'.repeat(2001), 0, 2001, 11)).toBe('23514');
    expect(await chunk('ok', 5, 2, 12)).toBe('23514');
    expect(await chunk('x'.repeat(2000), 0, 2000, 13)).toBeUndefined();
    expect(await chunk('again', 0, 5, 13)).toBe('23505');
    expect(await chunk('next version', 0, 12, 13, 2)).toBeUndefined();
  });

  it('a document’s name is unique in its base whatever the case, and its hash is a real hash', async () => {
    const doc = (name: string, slug: string, sha = 'c'.repeat(64)): Promise<string | undefined> =>
      code(sys((tx) => tx.query(`INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status) SELECT $1, $2, id, $3, $4, 'pdf', 1, $5, 'failed' FROM app.knowledge_sources WHERE base_id = $1 AND kind = 'upload'`, [eng.base, ENG, name, slug, sha])));
    expect(await doc('REFUND POLICY.MD', 'other-slug')).toBe('23505');
    expect(await doc('Other.pdf', 'refund-policy')).toBe('23505');
    expect(await doc('Other.pdf', 'other', 'nothex')).toBe('23514');
    expect(await doc('Other.pdf', 'other')).toBeUndefined();
  });

  it('a kind and a status outside the lists are refused', async () => {
    expect(await code(sys((tx) => tx.query(`UPDATE app.knowledge_documents SET kind = 'docx' WHERE id = $1`, [eng.doc])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.knowledge_documents SET status = 'pending' WHERE id = $1`, [eng.doc])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'drive')`, [eng.base, ENG])))).toBe('23514');
  });

  it('a team has at most 20 bases and a base at most 200 documents', async () => {
    const have = Number((await sys((tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.knowledge_bases WHERE team_id = $1', [ENG]))).rows[0]!.n);
    for (let i = have; i < 20; i++) {
      await sys((tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, 'b')`, [omar.workspaceId, ENG, `fill-${i}`]));
    }
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, 'one-too-many', 'b')`, [omar.workspaceId, ENG])))).toBe('23514');

    const base = (await sys((tx) => tx.query<{ id: string }>('SELECT id FROM app.knowledge_bases WHERE slug = $1', [`fill-${have}`]))).rows[0]!.id;
    await sys((tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload')`, [base, ENG]));
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status)
         SELECT $1, $2, (SELECT id FROM app.knowledge_sources WHERE base_id = $1), 'd' || g, 'd-' || g, 'text', 1, repeat('d', 64), 'failed' FROM generate_series(1, 200) g`,
        [base, ENG],
      ),
    );
    expect(
      await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status) VALUES ($1, $2, (SELECT id FROM app.knowledge_sources WHERE base_id = $1), 'last', 'last', 'text', 1, repeat('d', 64), 'failed')`, [base, ENG]))),
    ).toBe('23514');
  });

  it('deleting a base removes its sources, documents and passages', async () => {
    await as(tariq, (tx) => tx.query('DELETE FROM app.knowledge_bases WHERE id = $1', [mkt.base]));
    for (const table of TABLES.slice(1)) {
      const left = await sys(async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table} WHERE team_id = $1`, [MKT])).rows[0]!.n));
      expect(left, table).toBe(0);
    }
  });

  it('the run-grant function is a system-owned definer with a pinned search path, callable by the app role and not by everyone', async () => {
    const info = (await sys((tx) =>
      tx.query<{ prosecdef: boolean; owner: string; config: string[] | null; public_can: boolean; app_can: boolean }>(
        `SELECT prosecdef, pg_get_userbyid(proowner) AS owner, proconfig AS config,
                has_function_privilege('public', oid, 'EXECUTE') AS public_can, has_function_privilege('manythreads_app', oid, 'EXECUTE') AS app_can
           FROM pg_proc WHERE proname = 'knowledge_run_grant' AND pronamespace = 'app'::regnamespace`,
      ),
    )).rows[0];
    expect(info).toMatchObject({ prosecdef: true, owner: 'manythreads_system', public_can: false, app_can: true });
    expect(info?.config?.join(' ')).toContain('search_path=pg_catalog, app, pg_temp');
  });

  it('the word index is filled by the database from the text', async () => {
    const hits = await as(nadia, async (tx) => (await tx.query<{ text: string }>(`SELECT text FROM app.knowledge_chunks WHERE tsv @@ to_tsquery('simple', 'refunds')`)).rows);
    expect(hits.map((h) => h.text)).toEqual(['Refunds are paid within 14 days.']);
  });

  it('has a partial vector index for embedded passages, the word index and the trigram index', async () => {
    const defs = (await sys((tx) => tx.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = 'knowledge_chunks'`))).rows.map((r) => r.indexdef);
    expect(defs.some((d) => d.includes('USING hnsw (embedding vector_cosine_ops)') && d.includes('WHERE (embedding IS NOT NULL)'))).toBe(true);
    expect(defs.some((d) => d.includes('USING gin (tsv)'))).toBe(true);
    expect(defs.some((d) => d.includes('gin_trgm_ops'))).toBe(true);
    // a vector can be stored and found by distance, and a reader of the team sees only its own team's
    const vec = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await sys((tx) => tx.query('UPDATE app.knowledge_chunks SET embedding = $2::vector WHERE id = $1', [eng.chunk, vec]));
    const near = await as(nadia, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 5', [vec])).rows);
    expect(near.map((r) => r.id)).toEqual([eng.chunk]);
  });

  describe('the embedding door (nothing in the gateway offers one yet; a fake stands in)', () => {
    const unit = (axis: number): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));
    const literal = (axis: number): string => `[${unit(axis).join(',')}]`;
    const ctxWith = (embed?: (tx: PluginTx, req: { workspaceId: string; texts: string[]; purpose: string }) => Promise<unknown>): PluginContext =>
      ({ providers: { get: () => (embed ? { id: 'llm', embed } : { id: 'llm' }) } }) as unknown as PluginContext;

    it('does nothing without an embedding model, and fills only the current passages of the workspace with one', async () => {
      await sys((tx) => tx.query('UPDATE app.knowledge_chunks SET embedding = NULL'));
      const none = await sys((tx) => backfillEmbeddings(ctxWith(), tx as unknown as PluginTx, omar.workspaceId));
      expect(none).toEqual({ filled: 0, stoppedBecause: 'no embedding model' });
      const calls: Array<{ texts: string[]; purpose: string }> = [];
      const fake = async (_tx: PluginTx, req: { workspaceId: string; texts: string[]; purpose: string }) => {
        calls.push({ texts: req.texts, purpose: req.purpose });
        return { ok: true, vectors: req.texts.map((t) => unit(/refund/i.test(t) ? 0 : 1)) };
      };
      const done = await sys((tx) => backfillEmbeddings(ctxWith(fake), tx as unknown as PluginTx, omar.workspaceId));
      expect(done.stoppedBecause).toBeNull();
      expect(done.filled).toBeGreaterThan(0);
      expect(calls.every((c) => c.purpose === 'passage')).toBe(true);
      expect(await sys((tx) => tx.query("SELECT 1 FROM app.knowledge_chunks c JOIN app.knowledge_documents d ON d.id = c.document_id WHERE c.embedding IS NULL AND c.version = d.version AND d.status = 'indexed'"))).toMatchObject({ rows: [] });
      // a second pass has nothing left to do and does not call the model
      calls.length = 0;
      expect((await sys((tx) => backfillEmbeddings(ctxWith(fake), tx as unknown as PluginTx, omar.workspaceId))).filled).toBe(0);
      expect(calls).toEqual([]);
    });

    it('stops without writing when the model refuses, answers the wrong count, or answers vectors of the wrong length', async () => {
      const bad: Array<[string, (tx: PluginTx, req: { texts: string[] }) => Promise<unknown>, string]> = [
        ['refused', async () => ({ ok: false, reason: 'refused', detail: 'budget' }), 'refused'],
        ['count', async () => ({ ok: true, vectors: [unit(0)] }), 'the model answered with the wrong number of vectors'],
        ['length', async (_tx, req) => ({ ok: true, vectors: req.texts.map(() => [1, 2, 3]) }), `the model's vectors are not ${String(EMBEDDING_DIMENSIONS)} numbers long`],
        ['nan', async (_tx, req) => ({ ok: true, vectors: req.texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number.NaN)) }), `the model's vectors are not ${String(EMBEDDING_DIMENSIONS)} numbers long`],
      ];
      for (const [name, embed, because] of bad) {
        await sys((tx) => tx.query('UPDATE app.knowledge_chunks SET embedding = NULL'));
        const out = await sys((tx) => backfillEmbeddings(ctxWith(embed as never), tx as unknown as PluginTx, omar.workspaceId));
        expect(out, name).toMatchObject({ filled: 0, stoppedBecause: because });
        expect((await sys((tx) => tx.query("SELECT 1 FROM app.knowledge_chunks WHERE embedding IS NOT NULL"))).rows, name).toEqual([]);
      }
    });

    it('finds a passage by meaning when the words do not match, only in the asker\'s team, and merges with the word search', async () => {
      await sys((tx) => tx.query("UPDATE app.knowledge_chunks SET embedding = CASE WHEN text LIKE 'Refunds%' THEN $1::vector ELSE $2::vector END", [literal(0), literal(1)]));
      const opts = { teamIds: [ENG], baseSlugs: null, query: 'zzzz qqqq', limit: 3 } as const;
      const byWords = await as(nadia, (tx) => searchKnowledge(tx as unknown as PluginTx, opts));
      expect(byWords).toEqual([]);
      const byMeaning = await as(nadia, (tx) => searchKnowledge(tx as unknown as PluginTx, opts, literal(0)));
      expect(byMeaning.map((h) => h.text)).toEqual(['Refunds are paid within 14 days.']);
      // a passage that points the other way is not an answer
      const orthogonal = await as(nadia, (tx) => searchKnowledge(tx as unknown as PluginTx, opts, literal(5)));
      expect(orthogonal).toEqual([]);
      // the other team's passages never appear for this reader, whatever the vector
      expect((await as(nadia, (tx) => searchKnowledge(tx as unknown as PluginTx, { ...opts, teamIds: [MKT] }, literal(0)))).length).toBe(0);
      // words and meaning together: the passage both lists hold comes first
      const both = await as(nadia, (tx) => searchKnowledge(tx as unknown as PluginTx, { ...opts, query: 'shipping days' }, literal(0)));
      expect(both.map((h) => h.text)).toEqual(expect.arrayContaining(['Shipping takes two days.', 'Refunds are paid within 14 days.']));
    });
  });
});
