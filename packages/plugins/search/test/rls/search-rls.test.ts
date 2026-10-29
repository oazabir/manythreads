import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
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
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, repoGitMigrationSource, searchMigrationSource] });
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
        `SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname IN ('search_messages', 'search_threads', 'search_files', 'search_pages')`,
      )).rows,
    );
    expect(info.map((r) => r.proname).sort()).toEqual(['search_files', 'search_messages', 'search_pages', 'search_threads']);
    expect(info.every((r) => r.prosecdef === false)).toBe(true);
  });
});

describe('filters only narrow (P14-11)', () => {
  const everyChannel = (): string[] => Object.values(ch);
  const filtered = (p: Persona, q: string, from: string[] | null, inn: string[] | null): Promise<{ channel_id: string; author_id: string }[]> =>
    as(p, async (tx) => (await tx.query<{ channel_id: string; author_id: string }>('SELECT channel_id, author_id FROM app.search_messages($1, NULL, 20, $2, $3)', [q, from, inn])).rows);

  it('naming every channel, hidden ones included, still finds only the readable ones, with and without text', async () => {
    for (const p of ALL) {
      const visible = await as(p, async (tx) => (await tx.query<{ ids: string[] }>("SELECT app.visible_channel_ids('read') AS ids")).rows[0]!.ids);
      for (const q of ['rollback', '']) {
        const got = await filtered(p, q, null, everyChannel());
        expect(got.every((h) => visible.includes(h.channel_id)), `${p.key} "${q}"`).toBe(true);
        const same = (await hits(p, q === '' ? 'rollback' : q)).map((h) => h.channel_id).sort();
        if (q !== '') expect(got.map((h) => h.channel_id).sort(), p.key).toEqual(same);
      }
    }
  });

  it('naming only a hidden channel finds nothing (not an error, not a different answer from a made-up id)', async () => {
    for (const p of [nadia, priya, sameera, lena]) {
      expect(await filtered(p, 'rolback', null, [ch['eng-leads']!]), p.key).toEqual([]);
      expect(await filtered(p, '', null, [ch['eng-leads']!]), p.key).toEqual([]);
      expect(await filtered(p, 'rolback', null, ['00000000-0000-0000-0000-000000000000']), p.key).toEqual([]);
    }
    expect((await filtered(rafi, 'rolback', null, [ch['eng-leads']!])).map((h) => h.channel_id)).toEqual([ch['eng-leads']]);
  });

  it('from: narrows by author and an empty list means nobody', async () => {
    expect((await filtered(omar, 'rolback', [rafi.actorId], null)).map((h) => h.channel_id)).toEqual([ch['eng-leads']]);
    expect(await filtered(omar, 'rolback', [], null)).toEqual([]);
    expect(await filtered(omar, '', [], null)).toEqual([]);
  });

  it('the pages, files and threads functions keep the same rule', async () => {
    const pages = (p: Persona, team: string | null): Promise<{ team_id: string; path: string }[]> =>
      as(p, async (tx) => (await tx.query<{ team_id: string; path: string }>('SELECT team_id, path FROM app.search_pages($1, $2, 20)', ['zephyr runbook', team])).rows);
    for (const [team, path] of [[TEAM_IDS.Engineering, 'pages/zephyr-runbook.md'], [TEAM_IDS.Marketing, 'pages/zephyr-runbook.md'], [TEAM_IDS.Engineering, 'memory/zephyr-runbook.md']] as const) {
      const sha = `${Math.random().toString(16).slice(2)}${'0'.repeat(40)}`.slice(0, 40);
      await sys(async (tx) => {
        await tx.query("INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, $2, $3, 'write', now(), ARRAY[$4]::text[])", [team, sha, nadia.actorId, path]);
        await tx.query('INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain) VALUES ($1, $2, $3, 10, $4, $5)', [team, path, sha, sha, 'the zephyr runbook']);
      });
    }
    expect((await pages(nadia, null)).map((r) => `${r.team_id}:${r.path}`)).toEqual([`${TEAM_IDS.Engineering}:pages/zephyr-runbook.md`]);
    expect((await pages(tariq, null)).map((r) => r.team_id)).toEqual([TEAM_IDS.Marketing]);
    expect((await pages(priya, null)).map((r) => r.team_id).sort()).toEqual([TEAM_IDS.Engineering, TEAM_IDS.Marketing].sort());
    expect(await pages(sameera, null)).toEqual([]);
    expect(await pages(lena, null)).toEqual([]);
    expect(await pages(nadia, TEAM_IDS.Marketing)).toEqual([]);
    expect(await pages(omar, null)).toHaveLength(2);
  });
});

describe('who a name means', () => {
  const resolve = (p: Persona, names: string[]): Promise<{ name_key: string; actor_id: string }[]> =>
    as(p, async (tx) => (await tx.query<{ name_key: string; actor_id: string }>('SELECT * FROM app.search_resolve_people($1::text[])', [names])).rows);

  it('a member resolves people of the workspace by the start of any word of the name; me is the caller', async () => {
    const name = await sys(async (tx) => (await tx.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1', [rafi.personId])).rows[0]!.display_name);
    const first = name.split(' ')[0]!.toLowerCase();
    expect((await resolve(nadia, [first])).map((r) => r.actor_id)).toContain(rafi.actorId);
    expect((await resolve(nadia, [name.toUpperCase()])).map((r) => r.actor_id)).toContain(rafi.actorId);
    expect(await resolve(nadia, ['me'])).toEqual([{ name_key: 'me', actor_id: nadia.actorId }]);
    expect(await resolve(nadia, ['%'])).toEqual([]);
    expect(await resolve(nadia, ['zzzzz'])).toEqual([]);
  });

  it('a guest resolves only themself, whatever they type', async () => {
    const own = await sys(async (tx) => (await tx.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1', [lena.personId])).rows[0]!.display_name);
    const rafiName = await sys(async (tx) => (await tx.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1', [rafi.personId])).rows[0]!.display_name);
    expect(await resolve(lena, [rafiName])).toEqual([]);
    expect((await resolve(lena, [own.split(' ')[0]!])).map((r) => r.actor_id)).toEqual([lena.actorId]);
    expect(await resolve(lena, ['me'])).toEqual([{ name_key: 'me', actor_id: lena.actorId }]);
  });

  it('is a definer function owned by the system role, not callable by PUBLIC, and answers nobody for a request with no actor', async () => {
    const info = await sys(async (tx) => (await tx.query<{ prosecdef: boolean; owner: string }>("SELECT prosecdef, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'search_resolve_people'")).rows[0]!);
    expect(info).toEqual({ prosecdef: true, owner: 'manythreads_system' });
    const none = await withActor({ kind: 'person', id: '00000000-0000-0000-0000-000000000000' as never, workspaceId: omar.workspaceId }, async (tx) => (await tx.query('SELECT * FROM app.search_resolve_people($1::text[])', [['rafi']])).rows, { pool: appPool });
    expect(none).toEqual([]);
  });
});

describe('saved searches belong to their owner', () => {
  it('nobody else reads, changes or removes them, an admin included', async () => {
    const id = await as(nadia, async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.saved_searches (workspace_id, owner_id, name, query) VALUES (app.workspace_id(), app.actor(), 'mine', 'from:rafi') RETURNING id")).rows[0]!.id);
    for (const p of [rafi, omar, priya, sameera, lena]) {
      expect(await as(p, async (tx) => (await tx.query('SELECT 1 FROM app.saved_searches WHERE id = $1', [id])).rows), p.key).toEqual([]);
      expect(await as(p, async (tx) => (await tx.query('DELETE FROM app.saved_searches WHERE id = $1 RETURNING id', [id])).rows), p.key).toEqual([]);
      await expect(as(p, (tx) => tx.query("INSERT INTO app.saved_searches (workspace_id, owner_id, name, query) VALUES (app.workspace_id(), $1, 'forged', 'x y')", [nadia.actorId]))).rejects.toMatchObject({ code: '42501' });
    }
    expect(await as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.saved_searches WHERE id = $1', [id])).rows)).toHaveLength(1);
    expect(await as(nadia, async (tx) => (await tx.query('DELETE FROM app.saved_searches WHERE id = $1 RETURNING id', [id])).rows)).toHaveLength(1);
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

  it('as a member, a page search by trigram uses both GIN indexes of repo_entries on a table of 60,000 files, and the function answers it quickly', async () => {
    // MISTAKES P4-04: on a few thousand rows a primary key scan is cheaper than the index even with sequential scans off; prove it on a real size.
    await sys(async (tx) => {
      await tx.query(
        `INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain)
         SELECT $1, 'pages/bulk/p' || g || '.md', repeat('a', 40), 10, repeat('a', 40),
                md5(g::text) || ' ' || md5((g * 7)::text) || ' ' || md5((g * 13)::text) || ' notes of the week ' || g
           FROM generate_series(1, 60000) g`,
        [TEAM_IDS.Engineering],
      );
      await tx.query('ANALYZE app.repo_entries');
    });
    const plan = await as(nadia, async (tx) => {
      await tx.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.5');
      await tx.query('SET LOCAL enable_seqscan = off');
      return (await tx.query<{ 'QUERY PLAN': string }>("EXPLAIN (COSTS OFF) SELECT 1 FROM app.repo_entries e WHERE starts_with(e.path, 'pages/') AND (e.text_plain %> 'zephyrx' OR e.path %> 'zephyrx')")).rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('repo_entries_text_trgm');
    expect(plan).toContain('repo_entries_path_trgm');
    // the function itself (it switches sequential scans off, because the planner cannot estimate `%>`): a rare word among 60,000 files
    const started = performance.now();
    const found = await as(nadia, async (tx) => (await tx.query('SELECT * FROM app.search_pages($1, NULL, 20)', ['qwxjvkzh'])).rows);
    const ms = performance.now() - started;
    expect(found).toEqual([]);
    console.log(`search_pages over 60,000 files: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  }, 120_000);
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
