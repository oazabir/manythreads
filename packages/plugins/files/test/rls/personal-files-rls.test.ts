import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  searchMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-02: the access rules of a Personal space's files, versions and folders. Owner reads and writes; everyone else sees nothing; an admin reads
// only while a live, recorded open exists, and then cannot write; a guest has no Personal space at all.

const { omar, nadia, sameera, lena, priya } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const rows = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const names = async (p: Persona): Promise<string[]> => (await rows<{ name: string }>(p, 'SELECT name FROM app.files WHERE owner_person_id IS NOT NULL ORDER BY name')).map((r) => r.name);

const insertSql = `INSERT INTO app.files (workspace_id, owner_person_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
                   VALUES ($1, $2, 'Notes/', $3, md5($3), 10, 'text/plain', repeat('a', 64), $4) RETURNING id`;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, searchMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  for (const p of [nadia, sameera, omar]) {
    ids[p.key] = await as(p, async (tx) => (await tx.query<{ id: string }>(insertSql, [p.workspaceId, p.personId, `${p.key}.md`, p.actorId])).rows[0]!.id);
  }
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the RLS harness', () => {
  it('passes, and no policy of the three tables calls a per-row helper in its read plan', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const t of ['files', 'file_versions', 'personal_folders']) expect(await findPerRowPolicyCalls(admin, t), t).toEqual([]);
      const c = await admin.query<{ comment: string }>(`SELECT obj_description('app.file_versions'::regclass, 'pg_class') AS comment`);
      expect(c.rows[0]?.comment).toMatch(/^rls: person/);
    } finally {
      await admin.end();
    }
  });
});

describe('who sees a Personal file', () => {
  it('its owner only; an admin without an open sees none of the members\' files, only their own', async () => {
    expect(await names(nadia)).toEqual(['nadia.md']);
    expect(await names(sameera)).toEqual(['sameera.md']);
    expect(await names(omar)).toEqual(['omar.md']);
    expect(await names(priya)).toEqual([]);
    expect(await names(lena)).toEqual([]);
  });

  it('a guest cannot make a Personal file, and nobody can make one for someone else', async () => {
    expect(await code(as(lena, (tx) => tx.query(insertSql, [lena.workspaceId, lena.personId, 'lena.md', lena.actorId])))).toBe('42501');
    expect(await code(as(sameera, (tx) => tx.query(insertSql, [sameera.workspaceId, nadia.personId, 'forged.md', sameera.actorId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(insertSql, [omar.workspaceId, nadia.personId, 'forged2.md', omar.actorId])))).toBe('42501');
  });

  it('a file cannot be both a team file and a Personal one', async () => {
    const team = (await sys(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id));
    expect(await code(sys((tx) => tx.query(`UPDATE app.files SET team_id = $1 WHERE id = $2`, [team, ids['nadia']])))).toBeDefined();
  });
});

describe('who changes a Personal file', () => {
  it('the owner renames and moves it; the trigger refuses every other column', async () => {
    await as(nadia, (tx) => tx.query(`UPDATE app.files SET name = 'renamed.md', folder_path = 'Meetings/', updated_at = now(), updated_by = $2 WHERE id = $1`, [ids['nadia'], nadia.actorId]));
    expect(await names(nadia)).toEqual(['renamed.md']);
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.files SET owner_person_id = $2 WHERE id = $1`, [ids['nadia'], sameera.personId])))).toBeDefined();
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.files SET uploader_id = $2 WHERE id = $1`, [ids['nadia'], sameera.actorId])))).toBeDefined();
  });

  it('another member and an admin change and delete nothing (the rows are invisible, so zero rows)', async () => {
    for (const p of [sameera, omar, priya]) {
      const upd = await as(p, (tx) => tx.query(`UPDATE app.files SET name = 'hijacked.md' WHERE id = $1`, [ids['nadia']]));
      expect(upd.rowCount, p.key).toBe(0);
      const del = await as(p, (tx) => tx.query(`DELETE FROM app.files WHERE id = $1`, [ids['nadia']]));
      expect(del.rowCount, p.key).toBe(0);
    }
    expect(await names(nadia)).toEqual(['renamed.md']);
  });
});

describe('versions and folders', () => {
  const addVersion = (p: Persona, fileId: string, key: string) =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.file_versions (workspace_id, file_id, owner_person_id, blob_key, size, mime, sha256, author_actor_id, stored_at)
         VALUES ($1, $2, $3, $4, 3, 'text/plain', repeat('b', 64), $5, now())`,
        [p.workspaceId, fileId, sameera.personId, key, p.actorId],
      ),
    );

  it('the owner adds a version (the owner column is filled from the file, whatever is sent); another person cannot', async () => {
    await addVersion(nadia, ids['nadia']!, 'k-nadia-1');
    const mine = await rows<{ owner_person_id: string }>(nadia, 'SELECT owner_person_id FROM app.file_versions');
    expect(mine).toEqual([{ owner_person_id: nadia.personId }]);
    expect(await code(addVersion(sameera, ids['nadia']!, 'k-forged'))).toBeDefined();
    expect(await rows(sameera, 'SELECT 1 FROM app.file_versions')).toEqual([]);
    expect(await rows(omar, 'SELECT 1 FROM app.file_versions')).toEqual([]);
  });

  it('a version does not change and the owner cannot delete one (only the system role prunes)', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.file_versions SET size = 99`)))).toBeDefined();
    expect(await code(as(nadia, (tx) => tx.query(`DELETE FROM app.file_versions`)))).toBe('42501');
  });

  it('a version of a team file is refused', async () => {
    const teamFile = await sys(async (tx) => {
      const team = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id;
      return (await tx.query<{ id: string }>(
        `INSERT INTO app.files (workspace_id, team_id, folder_path, name, blob_key, size, mime, sha256, uploader_id) VALUES ($1, $2, 'channels/x/', 'team.txt', md5('team'), 1, 'text/plain', repeat('a', 64), $3) RETURNING id`,
        [omar.workspaceId, team, nadia.actorId],
      )).rows[0]!.id;
    });
    expect(await code(addVersion(nadia, teamFile, 'k-team'))).toBeDefined();
  });

  it('folders: the owner makes and removes their own; others see none; a guest cannot make one', async () => {
    const mk = (p: Persona, path: string, owner: Persona = p) =>
      as(p, (tx) => tx.query('INSERT INTO app.personal_folders (workspace_id, owner_person_id, path) VALUES ($1, $2, $3)', [p.workspaceId, owner.personId, path]));
    await mk(nadia, 'Notes');
    expect(await code(mk(nadia, 'Notes'))).toBe('23505');
    expect(await code(mk(sameera, 'Forged', nadia))).toBe('42501');
    expect(await code(mk(lena, 'Mine'))).toBe('42501');
    expect(await code(mk(nadia, '../x'))).toBe('23514');
    expect(await code(mk(nadia, 'a//b'))).toBe('23514');
    expect(await rows(sameera, 'SELECT 1 FROM app.personal_folders')).toEqual([]);
    expect((await as(sameera, (tx) => tx.query('DELETE FROM app.personal_folders'))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.personal_folders'))).rowCount).toBe(1);
  });
});

describe('an admin open', () => {
  const open = (p: Persona, target: Persona) => as(p, (tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [target.personId, 'recovering a note']));

  it('reads files, versions and folders of that one person for the open, and writes nothing', async () => {
    await as(nadia, (tx) => tx.query('INSERT INTO app.personal_folders (workspace_id, owner_person_id, path) VALUES ($1, $2, $3)', [nadia.workspaceId, nadia.personId, 'Notes']));
    await open(omar, nadia);
    expect(await names(omar)).toEqual(['omar.md', 'renamed.md']);
    expect((await rows(omar, 'SELECT 1 FROM app.file_versions')).length).toBe(1);
    expect((await rows(omar, 'SELECT 1 FROM app.personal_folders')).length).toBe(1);
    expect(await names(priya)).toEqual([]); // the open is the admin's, not the workspace's
    expect((await as(omar, (tx) => tx.query(`UPDATE app.files SET name = 'by-admin.md' WHERE id = $1`, [ids['nadia']]))).rowCount).toBe(0);
    expect((await as(omar, (tx) => tx.query(`DELETE FROM app.files WHERE id = $1`, [ids['nadia']]))).rowCount).toBe(0);
    expect(await code(as(omar, (tx) => tx.query(insertSql, [omar.workspaceId, nadia.personId, 'planted.md', omar.actorId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.file_versions')))).toBe('42501');
  });

  it('after the open ends the admin reads nothing again', async () => {
    await sys((tx) => tx.query("UPDATE app.personal_space_access SET opened_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'"));
    expect(await names(omar)).toEqual(['omar.md']);
    expect(await rows(omar, 'SELECT 1 FROM app.file_versions')).toEqual([]);
  });

  it('the system role still reads every Personal file (the retention sweep and the blob collector need it)', async () => {
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.files WHERE owner_person_id IS NOT NULL'))).rowCount).toBe(3);
  });
});
