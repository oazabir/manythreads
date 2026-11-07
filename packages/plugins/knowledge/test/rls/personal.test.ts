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
import type { PluginTx } from '@manythreads/sdk';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../../src/search.ts';

// P20-06: a person's own knowledge bases. Only the owner reads and writes them (an admin reads during a live audited open and never writes); a team's bases
// are as before; the database keeps a row in exactly one space and a child in its parent's.

const { omar, nadia, rafi, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = (p: Persona, table: string): Promise<number> =>
  as(p, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table}`)).rows[0]?.n ?? 0));
const TABLES = ['knowledge_bases', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks'];

/** Nadia's own base with a source, a document and a passage, made as Nadia (what the personal routes do). */
async function seedMine(slug: string): Promise<{ base: string; source: string; doc: string }> {
  return as(nadia, async (tx) => {
    const base = (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, nadia.personId, slug])).rows[0]!.id;
    const source = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind) VALUES ($1, $2, 'upload') RETURNING id`, [base, nadia.personId])).rows[0]!.id;
    const doc = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_documents (base_id, owner_person_id, source_id, name, slug, kind, size, sha256, status, chunk_count, indexed_at)
         VALUES ($1, $2, $3, 'Trip notes.md', 'trip-notes', 'markdown', 40, repeat('b', 64), 'indexed', 1, now()) RETURNING id`,
        [base, nadia.personId, source],
      )
    ).rows[0]!.id;
    await tx.query(
      `INSERT INTO app.knowledge_chunks (document_id, base_id, owner_person_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, 0, 1, 'My passport number is stored in the green folder.', 0, 50)`,
      [doc, base, nadia.personId],
    );
    return { base, source, doc };
  });
}

let mine: { base: string; source: string; doc: string };
let teamBase = '';

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, knowledgeMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  mine = await seedMine('trips');
  await sys(async (tx) => {
    teamBase = (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, ENG, 'handbook'])).rows[0]!.id;
    const source = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload') RETURNING id`, [teamBase, ENG])).rows[0]!.id;
    const doc = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status, chunk_count, indexed_at) VALUES ($1, $2, $3, 'Refund policy.md', 'refund-policy', 'markdown', 10, repeat('a', 64), 'indexed', 1, now()) RETURNING id`, [teamBase, ENG, source])).rows[0]!.id;
    await tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, 0, 1, 'Refunds are paid within 14 days.', 0, 32)`, [doc, teamBase, ENG]);
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('a person\'s knowledge bases (P20-06)', () => {
  it('pass the RLS audit and call no function per row', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of TABLES) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('are read by their owner alone: not by a teammate, another team\'s lead, an admin without an open, or a guest', async () => {
    for (const table of TABLES) {
      expect(await count(nadia, table), `nadia ${table}`).toBeGreaterThanOrEqual(1);
    }
    const ownRows = async (p: Persona): Promise<number> => as(p, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.knowledge_chunks WHERE owner_person_id IS NOT NULL')).rows[0]?.n ?? 0));
    expect(await ownRows(nadia)).toBe(1);
    for (const other of [rafi, omar, lena]) expect(await ownRows(other), other.key).toBe(0);
    // a team's base is still read by the team
    expect(await as(rafi, async (tx) => (await tx.query('SELECT 1 FROM app.knowledge_bases WHERE team_id IS NOT NULL')).rowCount)).toBe(1);
  });

  it('are read by an admin only during a live audited open, and never written by them', async () => {
    await as(omar, (tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [nadia.personId, 'support request']));
    const seen = await as(omar, async (tx) => (await tx.query('SELECT 1 FROM app.knowledge_chunks WHERE owner_person_id IS NOT NULL')).rowCount);
    expect(seen).toBe(1);
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, 'planted', 'planted')`, [omar.workspaceId, nadia.personId])))).toBe('42501');
    await as(omar, (tx) => tx.query(`UPDATE app.knowledge_chunks SET text = 'tampered' WHERE owner_person_id IS NOT NULL`));
    await as(omar, (tx) => tx.query(`DELETE FROM app.knowledge_bases WHERE owner_person_id IS NOT NULL`));
    expect(await count(nadia, 'knowledge_bases')).toBe(2);
    expect(await as(nadia, async (tx) => (await tx.query<{ text: string }>('SELECT text FROM app.knowledge_chunks WHERE owner_person_id IS NOT NULL')).rows[0]?.text)).toContain('passport');
  });

  it('are written by the owner only, and never into another person\'s space or a team the owner does not manage', async () => {
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, 'planted', 'planted')`, [omar.workspaceId, nadia.personId])))).toBe('42501');
    expect(await code(as(lena, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, 'guest-base', 'g')`, [omar.workspaceId, lena.personId])))).toBe('42501');
    await as(rafi, (tx) => tx.query(`UPDATE app.knowledge_bases SET name = 'renamed' WHERE owner_person_id IS NOT NULL`));
    await as(rafi, (tx) => tx.query(`DELETE FROM app.knowledge_bases WHERE owner_person_id IS NOT NULL`));
    expect(await count(nadia, 'knowledge_bases')).toBe(2);
  });

  it('keep a row in exactly one space, and a child in its parent\'s space', async () => {
    // both owners, or neither
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, team_id, owner_person_id, slug, name) VALUES ($1, $2, $3, 'both', 'both')`, [omar.workspaceId, ENG, nadia.personId])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, slug, name) VALUES ($1, 'neither', 'neither')`, [omar.workspaceId])))).toBe('23514');
    // a passage of a person's document cannot be filed under the team base, nor a team's document under a person's base
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, char_start, char_end) VALUES ($1, $2, $3, 5, 1, 'x', 0, 1)`, [mine.doc, mine.base, ENG])))).toBeDefined();
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status) VALUES ($1, $2, $3, 'x.md', 'x', 'markdown', 1, repeat('c', 64), 'failed')`, [mine.base, ENG, mine.source])))).toBeDefined();
    // a person's base has no repo source and no repo copy
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind) VALUES ($1, $2, 'repo')`, [mine.base, nadia.personId])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.knowledge_documents SET repo_path = 'knowledge/x/y.md' WHERE id = $1`, [mine.doc])))).toBe('23514');
  });

  it('allow ten bases of one\'s own, no more, and one slug once', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, 'trips', 'again')`, [omar.workspaceId, nadia.personId])))).toBe('23505');
    for (let i = 2; i <= 10; i++) await as(nadia, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, $3, $3)`, [omar.workspaceId, nadia.personId, `extra-${String(i)}`]));
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, 'one-too-many', 'x')`, [omar.workspaceId, nadia.personId])))).toBe('23514');
  });
});

describe('searching across spaces (P20-06)', () => {
  const search = (p: Persona, options: { teamIds: string[]; personId: string | null }, query: string) =>
    as(p, (tx) => searchKnowledge(tx as unknown as PluginTx, { ...options, baseSlugs: null, query, limit: 5 }));

  it('finds a person\'s passage only when the caller asks for their space, tagged with it', async () => {
    const withPersonal = await search(nadia, { teamIds: [ENG], personId: nadia.personId }, 'passport green folder');
    expect(withPersonal.map((h) => h.space)).toEqual([`person:${nadia.personId}`]);
    expect(await search(nadia, { teamIds: [ENG], personId: null }, 'passport green folder')).toEqual([]);
    // the team's passage carries its team
    expect((await search(nadia, { teamIds: [ENG], personId: nadia.personId }, 'refunds paid')).map((h) => h.space)).toEqual([`team:${ENG}`]);
  });

  it('never returns someone else\'s passage, whatever space the caller names', async () => {
    expect(await search(rafi, { teamIds: [ENG], personId: nadia.personId }, 'passport green folder')).toEqual([]);
    expect(await search(lena, { teamIds: [ENG], personId: nadia.personId }, 'passport green folder')).toEqual([]);
  });
});
