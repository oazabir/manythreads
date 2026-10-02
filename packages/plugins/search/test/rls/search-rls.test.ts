import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personaActor,
  personas,
  searchMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  TEAM_IDS,
  type Persona,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;
const ALL = [omar, nadia, rafi, sameera, tariq, priya, lena] as const;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const ch: Record<string, string> = {};

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
const message = (channelId: string, author: Persona, body: string): Promise<unknown> =>
  sys((tx) => tx.query(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4)`, [omar.workspaceId, channelId, author.actorId, body]));
const hits = async (p: Persona, q: string, team: string | null = null): Promise<{ channel_id: string; snippet: string }[]> =>
  as(p, async (tx) => (await tx.query<{ channel_id: string; snippet: string }>('SELECT channel_id, snippet FROM app.search_messages($1, $2, 20)', [q, team])).rows);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, searchMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const eng = TEAM_IDS.Engineering;
  ch['eng-general'] = await channel('eng-general', eng);
  ch['eng-leads'] = await channel('eng-leads', eng, { private: true });
  ch['eng-releases'] = await channel('eng-releases', eng);
  ch['sup-general'] = await channel('sup-general', TEAM_IDS['Customer support']);
  ch['mkt-secret'] = await channel('mkt-secret', TEAM_IDS.Marketing, { private: true });
  ch['dm-nr'] = await channel('', null, { kind: 'dm', dmKey: `${nadia.personId}:${rafi.personId}` });
  await member(ch['eng-leads']!, omar);
  await member(ch['eng-leads']!, rafi);
  await member(ch['mkt-secret']!, tariq);
  await member(ch['dm-nr']!, nadia);
  await member(ch['dm-nr']!, rafi);
  await sys((tx) =>
    tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')`,
      [omar.workspaceId, ch['eng-releases'], lena.personId],
    ),
  );
  for (const [key, who] of [['eng-general', nadia], ['eng-leads', rafi], ['eng-releases', nadia], ['sup-general', sameera], ['mkt-secret', tariq], ['dm-nr', nadia]] as const) {
    await message(ch[key]!, who, `quarterly rollback plan in ${key}`);
  }
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('search runs as the caller', () => {
  it('every hit sits in a channel the caller can read, for every persona; the typo finds the same hits', async () => {
    for (const p of ALL) {
      const visible = await as(p, async (tx) => (await tx.query<{ ids: string[] }>("SELECT app.visible_channel_ids('read') AS ids")).rows[0]!.ids);
      for (const q of ['rollback', 'rolback', 'quarterly rollback plan']) {
        const got = (await hits(p, q)).map((h) => h.channel_id).sort();
        expect(got.every((id) => visible.includes(id)), `${p.key} ${q}`).toBe(true);
      }
      const withTypo = (await hits(p, 'rolback')).map((h) => h.channel_id).sort();
      const exact = (await hits(p, 'rollback')).map((h) => h.channel_id).sort();
      expect(withTypo, p.key).toEqual(exact);
    }
  });

  it('finds exactly the readable channels with text: the member sees the public ones, the private one only as a member, the DM only as a participant', async () => {
    const names = async (p: Persona): Promise<string[]> => {
      const ids = (await hits(p, 'rolback')).map((h) => h.channel_id);
      return Object.entries(ch).filter(([, id]) => ids.includes(id)).map(([k]) => k).sort();
    };
    expect(await names(nadia)).toEqual(['dm-nr', 'eng-general', 'eng-releases']);
    expect(await names(rafi)).toEqual(['dm-nr', 'eng-general', 'eng-leads', 'eng-releases']);
    expect(await names(priya)).toEqual(['eng-general', 'eng-releases']);
    expect(await names(omar)).toEqual(['eng-general', 'eng-leads', 'eng-releases', 'sup-general']);
    expect(await names(sameera)).toEqual(['sup-general']);
    expect(await names(tariq)).toEqual(['mkt-secret']);
    expect(await names(lena)).toEqual(['eng-releases']);
  });

  it('the team filter only narrows', async () => {
    const eng = (await hits(omar, 'rolback', TEAM_IDS.Engineering)).map((h) => h.channel_id).sort();
    expect(eng).toEqual([ch['eng-general'], ch['eng-leads'], ch['eng-releases']].sort());
    expect(await hits(sameera, 'rolback', TEAM_IDS.Engineering)).toEqual([]);
    expect(await hits(lena, 'rolback', TEAM_IDS.Marketing)).toEqual([]);
  });

  it('no actor and the system role find nothing (search is a question a person asks)', async () => {
    const none = await withActor({ kind: 'person', id: '00000000-0000-0000-0000-000000000000' as never, workspaceId: '00000000-0000-0000-0000-000000000000' as never }, async (tx) => (await tx.query('SELECT * FROM app.search_messages($1, NULL, 20)', ['rollback'])).rows, { pool: appPool });
    expect(none).toEqual([]);
    expect(await sys(async (tx) => (await tx.query('SELECT * FROM app.search_messages($1, NULL, 20)', ['rollback'])).rows)).toEqual([]);
  });

  it('the functions are security invoker: the same rows come from a plain SELECT under the policies', async () => {
    const info = await sys(async (tx) =>
      (await tx.query<{ proname: string; prosecdef: boolean }>(
        `SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname IN ('search_messages', 'search_threads', 'search_files')`,
      )).rows,
    );
    expect(info.map((r) => r.proname).sort()).toEqual(['search_files', 'search_messages', 'search_threads']);
    expect(info.every((r) => r.prosecdef === false)).toBe(true);
  });
});

describe('the trigram indexes are usable under row level security', () => {
  it('the pg_trgm operators are LEAKPROOF (what lets the planner hand them to the GIN index behind a policy)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const r = await admin.query<{ proname: string; proleakproof: boolean }>(
        `SELECT proname, proleakproof FROM pg_proc WHERE proname IN ('word_similarity_op', 'word_similarity_commutator_op', 'similarity_op') ORDER BY proname`,
      );
      expect(r.rows).toEqual([
        { proname: 'similarity_op', proleakproof: true },
        { proname: 'word_similarity_commutator_op', proleakproof: true },
        { proname: 'word_similarity_op', proleakproof: true },
      ]);
    } finally {
      await admin.end();
    }
  });

  it.each([
    ['messages', 'body_plain', 'messages_body_plain_trgm'],
    ['threads', 'title', 'threads_title_trgm'],
    ['files', 'name', 'files_name_trgm'],
  ])('as a member, a `%s` search by trigram can use the GIN index (a sequential scan is only a planner choice, not forced by the policy)', async (table, column, index) => {
    const plan = await as(nadia, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      await tx.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.5');
      return (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT 1 FROM app.${table} t WHERE t.${column} %> 'rolback'`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain(index);
  });
});

describe('LEAKPROOF is only safe on bounded text, and a deleted root leaves thread search', () => {
  it('the three searched columns are bounded by constraints (pg_trgm fails on absurdly long text, which a leakproof function must never do)', async () => {
    // The reason for search 0002 (measured, not repeated here: it takes 250 MB): pg_trgm raises out_of_memory on a text of that size, so a
    // LEAKPROOF qual is only honest while no row can hold one.
    const long = (n: number): Promise<unknown> => sys((tx) => tx.query(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'x', repeat('a', $4::int))`,
      [omar.workspaceId, ch['eng-general'], nadia.actorId, n]));
    await expect(long(100_001)).rejects.toMatchObject({ code: '23514' });
    await expect(long(100_000)).resolves.toBeDefined();
    await expect(sys((tx) => tx.query("INSERT INTO app.threads (root_message_id, channel_id, title) SELECT id, channel_id, repeat('a', 201) FROM app.messages LIMIT 1"))).rejects.toMatchObject({ code: '23514' });
    await expect(sys((tx) => tx.query("INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id) SELECT workspace_id, $1, 'channels/x/', repeat('a', 256), 'k', 1, 'text/plain', repeat('0', 64), $2 FROM app.channels WHERE id = $1", [ch['eng-general'], nadia.actorId]))).rejects.toMatchObject({ code: '23514' });
  });

  it('a thread whose root was deleted is not found by the text it had', async () => {
    const root = await sys(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'zanzibar migration schedule', 'zanzibar migration schedule') RETURNING id`,
      [omar.workspaceId, ch['eng-general'], nadia.actorId])).rows[0]!.id);
    await as(rafi, (tx) => tx.query(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'noted', 'noted', $4)`,
      [rafi.workspaceId, ch['eng-general'], rafi.actorId, root]));
    const found = (): Promise<number> => as(rafi, async (tx) => (await tx.query('SELECT 1 FROM app.search_threads($1, NULL, 10)', ['zanzibar'])).rows.length);
    expect(await found()).toBe(1);
    await as(nadia, (tx) => tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [root]));
    expect(await found()).toBe(0);
  });
});
