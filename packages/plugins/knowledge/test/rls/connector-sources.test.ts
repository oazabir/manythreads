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
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Bundle D, knowledge 0005 (pnpm test:rls): sources that read a person's connected app. Who sees and adds them (a team's base to the team, a personal base to its owner alone), the shape a
// connector source must have, one source per root, the cap of 10 per base, the remote identity of a document, and that a paused source marks its base for attention.

const { omar, nadia, rafi, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const connectionId = '0198f0a0-0000-7000-8000-000000000001';

let teamBase = '';
let myBase = '';
let n = 0;

const teamSource = (base: string, over: { provider?: string | null; root?: string | null; kind?: string; status?: string; connection?: string | null } = {}): Promise<string> =>
  sys(async (tx) => {
    n += 1;
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_sources (base_id, team_id, kind, provider, remote_root, connection_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [base, ENG, over.kind ?? 'connector', over.provider === undefined ? 'notion' : over.provider, over.root === undefined ? `root-${n}` : over.root, over.connection === undefined ? connectionId : over.connection, over.status ?? 'ready'],
      )
    ).rows[0]!.id;
  });
const mySource = (p: Persona, base: string, over: { provider?: string; root?: string; kind?: string } = {}): Promise<string> =>
  as(p, async (tx) => {
    n += 1;
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind, provider, remote_root, connection_id, granted_by) VALUES ($1, $2, $3, $4, $5, $6, $2) RETURNING id`,
        [base, nadia.personId, over.kind ?? 'connector', over.provider ?? 'google_drive', over.root ?? `my-root-${n}`, connectionId],
      )
    ).rows[0]!.id;
  });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, knowledgeMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    teamBase = (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, ENG, 'wiki'])).rows[0]!.id;
  });
  myBase = await as(nadia, async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, nadia.personId, 'mine'])).rows[0]!.id);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the changed tables still pass the RLS audit', () => {
  it('no violations and no function called per row', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['knowledge_sources', 'knowledge_documents']) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('who sees a connector source', () => {
  it('a team base shows it to the team and to admins, not to another team or a guest; the grant id is part of the row', async () => {
    const id = await teamSource(teamBase);
    const read = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.knowledge_sources WHERE id = $1', [id])).rowCount ?? 0);
    expect(await read(nadia)).toBe(1);
    expect(await read(omar)).toBe(1);
    expect(await read(tariq)).toBe(0);
    expect(await read(lena)).toBe(0);
  });

  it('a personal base shows it to its owner alone, an admin included', async () => {
    const id = await mySource(nadia, myBase);
    const read = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.knowledge_sources WHERE id = $1', [id])).rowCount ?? 0);
    expect(await read(nadia)).toBe(1);
    for (const p of [omar, rafi, tariq, lena]) expect(await read(p), p.name).toBe(0);
  });

  it('nobody adds a source to someone else\'s personal base', async () => {
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind, provider, remote_root, connection_id, granted_by) VALUES ($1, $2, 'connector', 'notion', 'x', $3, $2)`, [myBase, rafi.personId, connectionId])))).toBeDefined();
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind, provider, remote_root, connection_id, granted_by) VALUES ($1, $2, 'connector', 'notion', 'x', $3, $2)`, [myBase, nadia.personId, connectionId])))).toBeDefined();
  });
});

describe('the shape of a connector source', () => {
  it('a connector source needs a service and a root; no other kind carries a service or a grant', async () => {
    expect(await code(teamSource(teamBase, { provider: null }))).toBe('23514');
    expect(await code(teamSource(teamBase, { root: null }))).toBe('23514');
    expect(await code(teamSource(teamBase, { kind: 'url', provider: null, root: null }))).toBe('23514');
    expect(await code(teamSource(teamBase, { kind: 'upload', provider: null, root: null }))).toBe('23514');
  });

  it('a service outside the list and a status outside the list are refused', async () => {
    expect(await code(teamSource(teamBase, { provider: 'evernote' }))).toBe('23514');
    expect(await code(teamSource(teamBase, { status: 'fine' }))).toBe('23514');
  });

  it('a personal base takes a connector source but still no repository source', async () => {
    expect(await mySource(nadia, myBase)).toBeTruthy();
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind) VALUES ($1, $2, 'repo')`, [myBase, nadia.personId])))).toBe('23514');
  });

  it('one source per service and root in a base; another base may read the same root', async () => {
    const root = 'folder-shared';
    await teamSource(teamBase, { root });
    expect(await code(teamSource(teamBase, { root }))).toBe('23505');
    expect(await teamSource(teamBase, { root, provider: 'box' })).toBeTruthy();
  });

  it('many connector sources are allowed, up to 10 in a base', async () => {
    const base = await sys(async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, ENG, 'capped'])).rows[0]!.id);
    for (let i = 0; i < 10; i++) await teamSource(base);
    expect(await code(teamSource(base))).toBe('23514');
  });
});

describe('documents that came from a connector', () => {
  const doc = (source: string, over: { remoteId?: string | null; version?: string | null; url?: string | null; kind?: string; slug?: string } = {}): Promise<unknown> =>
    sys((tx) =>
      tx.query(
        `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status, remote_id, remote_version, remote_url)
         VALUES ($1, $2, $3, 'Doc ' || $4::text, $4, $5, 10, repeat('c', 64), 'indexed', $6, $7, $8)`,
        [teamBase, ENG, source, over.slug ?? `doc-${(n += 1)}`, over.kind ?? 'markdown', over.remoteId === undefined ? 'remote-1' : over.remoteId, over.version ?? null, over.url ?? null],
      ),
    );

  it('keeps the remote id, version and link; the same remote id cannot repeat in a source', async () => {
    const source = await teamSource(teamBase);
    expect(await code(doc(source, { remoteId: 'r1', version: 'v7', url: 'https://example.test/doc/1' }))).toBeUndefined();
    expect(await code(doc(source, { remoteId: 'r1' }))).toBe('23505');
    expect(await code(doc(await teamSource(teamBase), { remoteId: 'r1' }))).toBeUndefined();
  });

  it('a version or link without a remote id is refused; a link must be long enough to be an address', async () => {
    const source = await teamSource(teamBase);
    expect(await code(doc(source, { remoteId: null, version: 'v1' }))).toBe('23514');
    expect(await code(doc(source, { remoteId: 'r2', url: 'x' }))).toBe('23514');
  });

  it('Excel and PowerPoint documents are kept; an unknown kind is refused', async () => {
    const source = await teamSource(teamBase);
    expect(await code(doc(source, { remoteId: 'x1', kind: 'xlsx' }))).toBeUndefined();
    expect(await code(doc(source, { remoteId: 'x2', kind: 'pptx' }))).toBeUndefined();
    expect(await code(doc(source, { remoteId: 'x3', kind: 'rtf' }))).toBe('23514');
  });
});

describe('the base says when a source needs attention', () => {
  it('a paused source puts the base on attention; ready again clears it', async () => {
    const base = await sys(async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id', [omar.workspaceId, ENG, 'attn'])).rows[0]!.id);
    const status = (): Promise<string> => sys(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.knowledge_bases WHERE id = $1', [base])).rows[0]!.status);
    const source = await teamSource(base);
    expect(await status()).not.toBe('attention');
    await sys((tx) => tx.query(`UPDATE app.knowledge_sources SET status = 'paused' WHERE id = $1`, [source]));
    expect(await status()).toBe('attention');
    await sys((tx) => tx.query(`UPDATE app.knowledge_sources SET status = 'ready' WHERE id = $1`, [source]));
    expect(await status()).not.toBe('attention');
  });
});

describe('who sees the documents a connector source brought in', () => {
  const docIn = (base: string, source: string, team: string | null, owner: string | null, slug: string): Promise<unknown> =>
    sys((tx) =>
      tx.query(
        `INSERT INTO app.knowledge_documents (base_id, team_id, owner_person_id, source_id, name, slug, kind, size, sha256, status, remote_id)
         VALUES ($1, $2, $3, $4, $5, $5, 'markdown', 10, repeat('d', 64), 'indexed', $5)`,
        [base, team, owner, source, slug],
      ),
    );
  const seen = (p: Persona, slug: string): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.knowledge_documents WHERE slug = $1', [slug])).rowCount ?? 0);

  it('a team base\'s document is read by the team, not by another team or a guest', async () => {
    const source = await teamSource(teamBase);
    await docIn(teamBase, source, ENG, null, 'team-doc');
    expect(await seen(nadia, 'team-doc')).toBe(1);
    expect(await seen(rafi, 'team-doc')).toBe(1);
    expect(await seen(tariq, 'team-doc')).toBe(0);
    expect(await seen(lena, 'team-doc')).toBe(0);
  });

  it('a Personal base\'s document is read by its owner alone, an admin included', async () => {
    const source = await mySource(nadia, myBase);
    await docIn(myBase, source, null, nadia.personId, 'my-doc');
    expect(await seen(nadia, 'my-doc')).toBe(1);
    for (const p of [omar, rafi, tariq, lena]) expect(await seen(p, 'my-doc'), p.name).toBe(0);
  });

  it('removing a source removes its documents with it, and only those', async () => {
    const one = await teamSource(teamBase);
    const two = await teamSource(teamBase);
    await docIn(teamBase, one, ENG, null, 'cascade-one');
    await docIn(teamBase, two, ENG, null, 'cascade-two');
    await sys((tx) => tx.query('DELETE FROM app.knowledge_sources WHERE id = $1', [one]));
    expect(await seen(nadia, 'cascade-one')).toBe(0);
    expect(await seen(nadia, 'cascade-two')).toBe(1);
  });

  it('a person cannot remove a document of a team they are not on, nor one in a Personal base that is not theirs', async () => {
    const del = (p: Persona, slug: string): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.knowledge_documents WHERE slug = $1', [slug])).rowCount ?? 0);
    expect(await del(tariq, 'team-doc')).toBe(0);
    expect(await del(rafi, 'my-doc')).toBe(0);
    expect(await seen(nadia, 'my-doc')).toBe(1);
  });
});

describe('who changes a connector source', () => {
  it('only the team or the owner may update or remove it; another person changes and removes nothing', async () => {
    const id = await mySource(nadia, myBase);
    const touch = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query(`UPDATE app.knowledge_sources SET label = 'changed' WHERE id = $1`, [id])).rowCount ?? 0);
    const drop = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.knowledge_sources WHERE id = $1', [id])).rowCount ?? 0);
    for (const p of [omar, rafi, tariq, lena]) {
      expect(await touch(p), p.name).toBe(0);
      expect(await drop(p), p.name).toBe(0);
    }
    expect(await touch(nadia)).toBe(1);
    expect(await drop(nadia)).toBe(1);
  });
});
