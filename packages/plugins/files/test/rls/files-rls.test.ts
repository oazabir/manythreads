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
  TEAM_IDS,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, priya, lena } = personas;
const ALL = [omar, nadia, rafi, sameera, priya, lena] as const;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> =>
  as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const ch: Record<string, string> = {};
const file: Record<string, string> = {};

async function channel(name: string, team: string | null, opts: { kind?: string; private?: boolean; dmKey?: string } = {}): Promise<string> {
  return sys(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [omar.workspaceId, team, opts.kind === 'dm' ? '' : name, opts.kind ?? 'channel', opts.private ?? opts.kind === 'dm', opts.dmKey ?? null],
    );
    return r.rows[0]!.id;
  });
}
const member = (channelId: string, p: Persona): Promise<unknown> =>
  sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [channelId, p.personId]));
const grant = (channelId: string, p: Persona, permission: string): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, $4)`,
      [omar.workspaceId, channelId, p.personId, permission],
    ),
  );
const insertFile = (channelId: string | null, team: string | null, uploader: Persona, name: string): Promise<string> =>
  sys(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.files (workspace_id, channel_id, team_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
       VALUES ($1, $2, $3, 'channels/x/', $4, md5($4), 10, 'text/plain', repeat('a', 64), $5) RETURNING id`,
      [omar.workspaceId, channelId, team, name, uploader.actorId],
    );
    return r.rows[0]!.id;
  });
const seen = async (p: Persona): Promise<string[]> => (await q<{ name: string }>(p, 'SELECT name FROM app.files ORDER BY name')).map((r) => r.name);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, searchMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const eng = TEAM_IDS.Engineering;
  const sup = TEAM_IDS['Customer support'];
  ch['eng-general'] = await channel('eng-general', eng);
  ch['eng-releases'] = await channel('eng-releases', eng);
  ch['eng-leads'] = await channel('eng-leads', eng, { private: true });
  ch['sup-general'] = await channel('sup-general', sup);
  ch['dm-nr'] = await channel('', null, { kind: 'dm', dmKey: `${nadia.personId}:${rafi.personId}` });
  await member(ch['eng-leads']!, omar);
  await member(ch['eng-leads']!, rafi);
  await member(ch['dm-nr']!, nadia);
  await member(ch['dm-nr']!, rafi);
  await grant(ch['eng-releases']!, lena, 'read');
  file['general'] = await insertFile(ch['eng-general']!, null, nadia, 'general.txt');
  file['releases'] = await insertFile(ch['eng-releases']!, null, nadia, 'releases.txt');
  file['leads'] = await insertFile(ch['eng-leads']!, null, rafi, 'leads.txt');
  file['dm'] = await insertFile(ch['dm-nr']!, null, nadia, 'dm.txt');
  file['support'] = await insertFile(ch['sup-general']!, null, sameera, 'support.txt');
  file['team'] = await insertFile(null, eng, nadia, 'team-file.txt');
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the files table passes the RLS harness', () => {
  it('RLS is enabled and forced, with policies and an rls comment; no policy calls a per-row helper in the read plan', async () => {
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'files')).toEqual([]);
      const c = await admin.query<{ comment: string }>(`SELECT obj_description('app.files'::regclass, 'pg_class') AS comment`);
      expect(c.rows[0]?.comment).toMatch(/^rls: team/);
    } finally {
      await admin.end();
    }
  });

  it('the policy hoists the visible channel set: a count over the table makes no per-row call', async () => {
    const plan = await as(nadia, async (tx) => (await tx.query<{ 'QUERY PLAN': string }>('EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM app.files')).rows.map((r) => r['QUERY PLAN']).join('\n'));
    expect(plan).toContain('visible_channel_ids');
    expect(plan).not.toMatch(/channel_can|can_in_team|app\.can\(/);
  });
});

describe('who sees which file (the channel decides)', () => {
  it('a member reads the files of the public channels of their team and nothing of another team', async () => {
    expect(await seen(nadia)).toEqual(['dm.txt', 'general.txt', 'releases.txt', 'team-file.txt']);
    expect(await seen(sameera)).toEqual(['support.txt']);
  });

  it('a private channel is visible to its members only, a DM to its two people; a workspace admin is not exempt', async () => {
    expect(await seen(rafi)).toEqual(['dm.txt', 'general.txt', 'leads.txt', 'releases.txt', 'team-file.txt']);
    expect(await seen(omar)).toEqual(['general.txt', 'leads.txt', 'releases.txt', 'support.txt', 'team-file.txt']); // member of eng-leads, not of the DM
    expect(await seen(priya)).toEqual(['general.txt', 'releases.txt', 'team-file.txt']);
  });

  it('a guest sees only what a grant on a channel covers (and no team file)', async () => {
    expect(await seen(lena)).toEqual(['releases.txt']);
  });

  it('the files a person sees are exactly the files in channels of their visible_channel_ids, plus the team files of their teams', async () => {
    for (const p of ALL) {
      const visible = (await q<{ ids: string[] }>(p, "SELECT app.visible_channel_ids('read') AS ids"))[0]!.ids;
      const expected = await sys(async (tx) =>
        (await tx.query<{ name: string }>('SELECT name FROM app.files WHERE channel_id = ANY ($1::uuid[]) ORDER BY name', [visible])).rows.map((r) => r.name),
      );
      const got = (await seen(p)).filter((n) => n !== 'team-file.txt');
      expect(got, p.key).toEqual(expected);
    }
  });
});

describe('writing', () => {
  const insert = (p: Persona, channelId: string | null, team: string | null, uploader: Persona = p): Promise<unknown> =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.files (workspace_id, channel_id, team_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         VALUES ($1, $2, $3, 'channels/x/', 'w.txt', md5(random()::text), 1, 'text/plain', repeat('b', 64), $4)`,
        [p.workspaceId, channelId, team, uploader.actorId],
      ),
    );

  it('needs the post permission: a member posts, the guest with a read grant does not, a non-member does not', async () => {
    expect(await code(insert(nadia, ch['eng-general']!, null))).toBeUndefined();
    expect(await code(insert(lena, ch['eng-releases']!, null))).toBe('42501');
    expect(await code(insert(sameera, ch['eng-general']!, null))).toBe('42501');
    expect(await code(insert(priya, ch['eng-leads']!, null))).toBe('42501');
    await grant(ch['eng-releases']!, lena, 'post');
    await sys((tx) => tx.query('DELETE FROM app.acl_entries WHERE resource_type = $1 AND subject_id = $2 AND permission = $3', ['channel', lena.personId, 'read']));
    expect(await code(insert(lena, ch['eng-releases']!, null))).toBeUndefined();
  });

  it('is as oneself and in the channel\'s workspace: another uploader is refused by the policy, another workspace by the trigger', async () => {
    expect(await code(insert(nadia, ch['eng-general']!, null, rafi))).toBe('42501');
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
             VALUES (gen_random_uuid(), $1, 'channels/x/', 'ws.txt', 'k', 1, 'text/plain', repeat('b', 64), $2)`,
            [ch['eng-general'], nadia.actorId],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('the team of a channel file is taken from the channel, whatever the caller writes', async () => {
    const id = await as(nadia, async (tx) => (
      await tx.query<{ id: string }>(
        `INSERT INTO app.files (workspace_id, channel_id, team_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         VALUES ($1, $2, $3, 'channels/x/', 'forged.txt', 'kf', 1, 'text/plain', repeat('b', 64), $4) RETURNING id`,
        [nadia.workspaceId, ch['eng-general'], TEAM_IDS.Marketing, nadia.actorId],
      )
    ).rows[0]!.id);
    const row = (await q<{ team_id: string }>(nadia, 'SELECT team_id FROM app.files WHERE id = $1', [id]))[0]!;
    expect(row.team_id).toBe(TEAM_IDS.Engineering);
  });

  it('names and folders are checked by the table: no separators, no traversal, no control characters', async () => {
    const bad = (name: string, folder = 'channels/x/'): Promise<string | undefined> =>
      code(
        sys((tx) =>
          tx.query(
            `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
             VALUES ($1, $2, $3, $4, 'k', 1, 'text/plain', repeat('c', 64), $5)`,
            [omar.workspaceId, ch['eng-general'], folder, name, nadia.actorId],
          ),
        ),
      );
    for (const name of ['a/b', 'a\\b', '..', '.', '', 'x\ny']) expect(await bad(name), JSON.stringify(name)).toBe('23514');
    expect(await bad('x\u0000y')).toBe('22021'); // PostgreSQL refuses a NUL byte in text before any check
    expect(await bad('ok.txt', 'channels/../x/')).toBe('23514');
    expect(await bad('ok.txt', 'no-trailing-slash')).toBe('23514');
  });

  it('a stored file does not change for a caller (no UPDATE), and one name is held once per folder', async () => {
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.files SET name = 'renamed' WHERE id = $1", [file['general']])))).toBe('42501');
    expect(await code(sys((tx) => tx.query('SELECT 1')))).toBeUndefined();
    expect(await code(insertFile(ch['eng-general']!, null, nadia, 'general.txt'))).toBe('23505');
  });

  it('delete: the uploader or a lead of the team; another member, and a person who cannot see the file, delete nothing', async () => {
    const mk = (name: string): Promise<string> => insertFile(ch['eng-general']!, null, nadia, name);
    const del = async (p: Persona, id: string): Promise<number> => as(p, async (tx) => (await tx.query('DELETE FROM app.files WHERE id = $1', [id])).rowCount ?? 0);
    const a = await mk('del-a.txt');
    expect(await del(rafi, a)).toBe(0);
    expect(await del(sameera, a)).toBe(0);
    expect(await del(nadia, a)).toBe(1);
    const b = await mk('del-b.txt');
    expect(await del(omar, b)).toBe(1); // lead of Engineering
  });
});

describe('files of deleted messages (files 0002)', () => {
  const message = (channelId: string, author: Persona, files: string[]): Promise<string> =>
    sys(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, 'x', 'x', $4::jsonb) RETURNING id`,
        [omar.workspaceId, channelId, author.actorId, JSON.stringify({ attachments: files })],
      );
      return r.rows[0]!.id;
    });
  const remove = (author: Persona, id: string): Promise<unknown> =>
    as(author, (tx) => tx.query(`UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1`, [id]));
  const stamped = async (id: string): Promise<boolean> =>
    (await sys((tx) => tx.query('SELECT orphaned_at FROM app.files WHERE id = $1', [id]))).rows[0]?.['orphaned_at'] != null;

  it('stamps the file when its only message is deleted: every persona stops seeing it, the system role still does', async () => {
    const f = await insertFile(ch['eng-general']!, null, nadia, 'hidden-after-delete.txt');
    const m = await message(ch['eng-general']!, nadia, [f]);
    for (const p of [omar, nadia, rafi, priya]) expect(await seen(p), p.key).toContain('hidden-after-delete.txt');
    await remove(nadia, m);
    expect(await stamped(f)).toBe(true);
    for (const p of ALL) expect(await seen(p), p.key).not.toContain('hidden-after-delete.txt');
    expect(await sys(async (tx) => (await tx.query("SELECT 1 FROM app.files WHERE name = 'hidden-after-delete.txt'")).rows.length)).toBe(1);
    // Hidden also for the uploader's own delete and for a team lead's: the row cannot be reached to delete it.
    expect(await as(nadia, async (tx) => (await tx.query('DELETE FROM app.files WHERE id = $1', [f])).rowCount)).toBe(0);
    expect(await as(omar, async (tx) => (await tx.query('DELETE FROM app.files WHERE id = $1', [f])).rowCount)).toBe(0);
  });

  it('keeps the file while a live message lists it, a file nobody attached, and files of other messages', async () => {
    const shared = await insertFile(ch['eng-general']!, null, nadia, 'two-messages.txt');
    const loose = await insertFile(ch['eng-general']!, null, nadia, 'never-attached.txt');
    const m1 = await message(ch['eng-general']!, nadia, [shared]);
    const m2 = await message(ch['eng-general']!, nadia, [shared]);
    await remove(nadia, m1);
    expect(await stamped(shared)).toBe(false);
    expect(await seen(rafi)).toContain('two-messages.txt');
    await remove(nadia, m2);
    expect(await stamped(shared)).toBe(true);
    expect(await stamped(loose)).toBe(false);
    expect(await seen(rafi)).toContain('never-attached.txt');
  });

  it('survives malformed attachment lists (no array, not uuids) without failing the delete', async () => {
    const f = await insertFile(ch['eng-general']!, null, nadia, 'malformed-neighbour.txt');
    const odd = await sys(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, 'x', 'x', '{"attachments": ["nope", 7, null]}'::jsonb) RETURNING id`,
        [omar.workspaceId, ch['eng-general'], nadia.actorId],
      );
      return r.rows[0]!.id;
    });
    const scalar = await sys(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, 'x', 'x', '{"attachments": "oops"}'::jsonb) RETURNING id`,
        [omar.workspaceId, ch['eng-general'], nadia.actorId],
      );
      return r.rows[0]!.id;
    });
    await remove(nadia, odd);
    await remove(nadia, scalar);
    expect(await stamped(f)).toBe(false);
  });

  it('no caller stamps, clears or calls the marker: no UPDATE privilege, the function is not executable by the app role', async () => {
    const f = await insertFile(ch['eng-general']!, null, nadia, 'stamp-me-not.txt');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.files SET orphaned_at = now() WHERE id = $1', [f])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.files_mark_orphaned(ARRAY[$1::uuid])', [f])))).toBe('42501');
    expect(await stamped(f)).toBe(false);
    // The system role can clear the mark (an operator undoing a mistaken delete within the grace period), and nothing else about the row.
    const m = await message(ch['eng-general']!, nadia, [f]);
    await remove(nadia, m);
    expect(await stamped(f)).toBe(true);
    await sys((tx) => tx.query('UPDATE app.files SET orphaned_at = NULL WHERE id = $1', [f]));
    expect(await seen(rafi)).toContain('stamp-me-not.txt');
  });
});

describe('cascade', () => {
  it('deleting a channel (nothing in the product does; the owner role in maintenance) removes its files rows', async () => {
    const c = await channel('doomed', TEAM_IDS.Engineering);
    await insertFile(c, null, nadia, 'doomed.txt');
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      await admin.query('DELETE FROM app.channels WHERE id = $1', [c]);
    } finally {
      await admin.end();
    }
    expect(await sys(async (tx) => (await tx.query("SELECT 1 FROM app.files WHERE name = 'doomed.txt'")).rows.length)).toBe(0);
  });
});
