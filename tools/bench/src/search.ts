/**
 * P3-10 search benchmark: 1M messages (plus 50,000 threads and 20,000 files) under FORCE RLS, searched through the real
 * `search` service of the search plugin as the real personas Nadia (Engineering member, sees about half the messages through
 * 110 channels), Sameera (Customer support, a third of them) and Lena (guest with one channel grant). Typo and exact queries of
 * common, medium and rare terms; the gate is p95 under 300 ms per persona across all queries (PLAN criterion 6).
 *
 * Run: pnpm --filter @manythreads/tools-bench bench:search   (needs the dev Postgres: pnpm db:up)
 * Env: BENCH_ROWS (default 1000000), BENCH_RUNS (measured runs per query, default 20), BENCH_BUDGET_MS (default 300),
 *      BENCH_EXPLAIN=1 prints the plan of the message query for each persona; BENCH_SETUP_ONLY=1 loads the data, keeps the database and stops.
 * Exits 1 when a persona's p95 is over the budget.
 */
import { createHash } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';
import { DEFAULT_APP_PASSWORD, createAppPool, withActor, type Actor } from '@manythreads/kernel';
import { search } from '@manythreads/plugin-search';
import {
  KAHF_WORKSPACE_ID,
  LENA,
  NADIA,
  SAMEERA,
  TEAM_IDS,
  channelsMigrationSource,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personaActor,
  searchMigrationSource,
  seedWorld,
  teamsMigrationSource,
  testAdminUrl,
  testKernelMigrationSource,
  withDatabase,
  type Persona,
} from '@manythreads/test-utils';
import pg from 'pg';

const ROWS = Number(process.env['BENCH_ROWS'] ?? 1_000_000);
const RUNS = Number(process.env['BENCH_RUNS'] ?? 20);
const BUDGET_MS = Number(process.env['BENCH_BUDGET_MS'] ?? 300);
const EXPLAIN = process.env['BENCH_EXPLAIN'] === '1';

const t0 = Date.now();
const log = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN;

// 150 everyday words (uniform) plus 150 distinct pseudo-words (a letter and seven hex digits of an md5: they share no trigrams worth mentioning, so a
// typo of one finds only that word, as it would for real names and product terms): an everyday word is in about 4% of the messages, a pseudo-word in 0.3%.
const COMMON =
  'the a to of and in it is that for on with as was we are be this have from or by not but they you at will can one all there when what our out up about if so do just more some time new work team project deploy release build test review merge branch commit issue ticket bug fix update meeting today tomorrow friday notes doc draft plan design api server client database query index cache latency error log alert incident customer feedback roadmap priority sprint demo ship launch rollback config secret token access permission channel thread message reply thanks please looks good great agree maybe later soon done blocked waiting approve decline schedule invite budget report metrics dashboard weekly daily summary question answer idea proposal risk owner deadline status progress example link file folder upload download share comment mention bot brain memory'.split(
    ' ',
  );
const TOKENS = Array.from({ length: 150 }, (_, i) => `q${createHash('md5').update(String(i)).digest('hex').slice(0, 7)}`);
const WORDS = [...COMMON, ...TOKENS];
const TOKEN = TOKENS[0] as string;

interface Case {
  label: string;
  q: string;
}
const CASES: Case[] = [
  { label: 'typo of a common word (rolback)', q: 'rolback' },
  { label: 'exact common word (deploy)', q: 'deploy' },
  { label: 'typo of a common word (deploymnt)', q: 'deploymnt' },
  { label: 'two common words (release rolback)', q: 'release rolback' },
  { label: `medium word (${TOKEN}, 0.3% of messages)`, q: TOKEN },
  { label: 'typo of a medium word', q: `${TOKEN.slice(0, 4)}${TOKEN.slice(5)}` },
  { label: 'rare word (zebrafish)', q: 'zebrafish' },
  { label: 'typo of a rare word (zebrafsh)', q: 'zebrafsh' },
  { label: 'a phrase from the text', q: 'looks good to merge' },
];
const PEOPLE: { who: Persona; label: string }[] = [
  { who: NADIA, label: 'Nadia (Engineering member)' },
  { who: SAMEERA, label: 'Sameera (Customer support member)' },
  { who: LENA, label: 'Lena (guest, one channel)' },
];

const REUSE = process.env['BENCH_REUSE'];

async function main(): Promise<void> {
  // BENCH_REUSE=<database name>: measure a database kept by BENCH_SETUP_ONLY=1 (no migration, seed or load; the search functions in it are used as they are).
  const db = REUSE
    ? {
        name: REUSE,
        ownerUrl: withDatabase(testAdminUrl(), REUSE),
        appUrl: withDatabase(testAdminUrl(), REUSE, { name: 'manythreads_app', password: DEFAULT_APP_PASSWORD }),
        systemUrl: '',
        applied: 0,
      }
    : await createTestDatabase({
        sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, searchMigrationSource],
      });
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  const version = (await owner.query<{ v: string }>('SELECT version() v')).rows[0]?.v;
  const settings = (
    await owner.query<{ name: string; setting: string; unit: string | null }>(
      `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_parallel_workers_per_gather','effective_cache_size')`,
    )
  ).rows.map((r) => `${r.name}=${r.setting}${r.unit ?? ''}`).join(', ');
  console.log(`PG version ${version}; ${settings}`);
  const appPool = createAppPool(db.appUrl, 4);
  let failed = false;
  let keep = false;
  try {
    if (!REUSE) {
      await seedWorld(db);
      log('seed world (workspace, personas, three teams)');

      // Channels: 100 Engineering (10 of them private with Nadia as a member, 10 private without her), 60 Customer support, 40 Marketing.
      // Nadia reads the 90 public + 10 private-with-her Engineering channels; Sameera the 60 of Customer support; Lena one granted channel.
      await owner.query(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private)
         SELECT $1, t.team, t.prefix || g, 'channel', (t.priv AND g <= 20)
           FROM (VALUES ($2::uuid, 'eng-', 100, true), ($3::uuid, 'sup-', 60, false), ($4::uuid, 'mkt-', 40, false)) AS t(team, prefix, n, priv),
                LATERAL generate_series(1, t.n) g`,
        [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, TEAM_IDS['Customer support'], TEAM_IDS.Marketing],
      );
      await owner.query(
        `INSERT INTO app.channel_members (channel_id, person_id)
         SELECT c.id, $1 FROM app.channels c WHERE c.team_id = $2 AND c.private AND c.name IN (SELECT 'eng-' || g FROM generate_series(1, 10) g)`,
        [NADIA.personId, TEAM_IDS.Engineering],
      );
      await owner.query(
        `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         SELECT $1, 'channel', c.id, 'person', $2, 'read' FROM app.channels c WHERE c.name = 'eng-100'`,
        [KAHF_WORKSPACE_ID, LENA.personId],
      );
      const channelCount = (await owner.query<{ n: number }>('SELECT count(*)::int n FROM app.channels')).rows[0]?.n;
      log(`${channelCount} channels`);

      // Messages as the owner with triggers off (session_replication_role = replica): the bench measures search, not the insert path.
      // The uuid v7 id carries the same time as created_at (one message every 30 s for the last ROWS x 30 s), as it does for real messages.
      await owner.query('SET session_replication_role = replica');
      const words = WORDS.map((w) => `'${w}'`).join(',');
      const batch = 100_000;
      for (let off = 0; off < ROWS; off += batch) {
        const n = Math.min(batch, ROWS - off);
        await owner.query(
          `WITH ch AS (SELECT array_agg(id ORDER BY name) a FROM app.channels WHERE kind = 'channel')
           INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, created_at)
           SELECT uuidv7(-((${ROWS} - g) * interval '30 seconds')), $1::uuid, ch.a[1 + (g % ${channelCount})], $4::uuid, t.txt, t.txt,
                  now() - ((${ROWS} - g) * interval '30 seconds')
             FROM ch, generate_series($3::int + 1, $3::int + $2::int) AS g,
                  LATERAL (SELECT string_agg((ARRAY[${words}])[1 + floor(random() * ${WORDS.length})::int + 0 * k], ' ') AS txt
                             FROM generate_series(1, 6 + (g % 14)) k(k)) t`,
          [KAHF_WORKSPACE_ID, n, off, NADIA.actorId],
        );
        process.stdout.write(`\r  loaded ${off + n}/${ROWS}`);
      }
      process.stdout.write('\n');
      // A rare word in about 1 message in 2,000.
      await owner.query(
        `UPDATE app.messages SET body = body || ' zebrafish', body_plain = body_plain || ' zebrafish' WHERE (hashtext(id::text) & 2047) = 0`,
      );
      // One in twenty messages is a thread root (50,000 for 1M): the thread row a reply would have made.
      await owner.query(
        `INSERT INTO app.threads (root_message_id, channel_id, title, reply_count, last_reply_at)
         SELECT m.id, m.channel_id, left(m.body_plain, 120), 1 + (hashtext(m.id::text) & 7), m.created_at
           FROM app.messages m WHERE (hashtext(m.id::text) % 20) = 0`,
      );
      await owner.query(
        `INSERT INTO app.files (workspace_id, channel_id, team_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         SELECT $1, c.id, c.team_id, 'channels/' || c.name || '/', (ARRAY[${words}])[1 + (g % ${WORDS.length})] || '-' || g || '.pdf',
                md5(g::text), 1000 + g, 'application/pdf', repeat('a', 64), $2
           FROM generate_series(1, 20000) g, LATERAL (SELECT id, team_id, name FROM app.channels WHERE kind = 'channel' ORDER BY name OFFSET (g % ${channelCount}) LIMIT 1) c`,
        [KAHF_WORKSPACE_ID, NADIA.actorId],
      );
      await owner.query('SET session_replication_role = DEFAULT');
      log(`loaded ${ROWS} messages, threads and files`);
      await owner.query('VACUUM (ANALYZE) app.messages');
      await owner.query('VACUUM (ANALYZE) app.threads');
      await owner.query('VACUUM (ANALYZE) app.files');
      await owner.query('ANALYZE app.channels');
      const size = (
        await owner.query<{ t: string; i: string }>(`SELECT pg_size_pretty(pg_table_size('app.messages')) t, pg_size_pretty(pg_indexes_size('app.messages')) i`)
      ).rows[0];
      console.log(`messages table ${size?.t}, indexes ${size?.i}`);
    }
    if (process.env['BENCH_SETUP_ONLY'] === '1') {
      keep = true;
      console.log(`database kept for manual work: ${db.name} (owner ${db.ownerUrl}, app ${db.appUrl})`);
      return;
    }
    const lines: string[] = [];
    const run = (actor: Actor, q: string, scope: 'all' | 'messages'): Promise<{ ms: number; hits: number }> => {
      const start = performance.now();
      return withActor(
        actor,
        async (tx) => {
          const res = await search(tx as unknown as PluginTx, { q, scope, limit: 20 });
          return { ms: performance.now() - start, hits: res.messages.length + res.threads.length + res.files.length };
        },
        { pool: appPool },
      );
    };
    for (const { who, label } of PEOPLE) {
      const actor = personaActor(who);
      if (EXPLAIN) {
        const plan = await withActor(
          actor,
          async (tx) =>
            (await tx.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM app.search_messages('rolback', NULL, 20)`)).rows.map((r) => r['QUERY PLAN']).join('\n'),
          { pool: appPool },
        );
        console.log(`--- plan for ${label} (function body is not expanded; see auto_explain or run the SELECT inline)\n${plan}`);
      }
      const all: number[] = [];
      const messagesOnly: number[] = [];
      lines.push(`\n${label}`);
      lines.push('| query | hits | all kinds: median | p95 | messages only: median | p95 |');
      lines.push('|---|---|---|---|---|---|');
      for (const c of CASES) {
        await run(actor, c.q, 'all');
        await run(actor, c.q, 'all');
        const ms: number[] = [];
        const msOnly: number[] = [];
        let hits = 0;
        for (let i = 0; i < RUNS; i++) {
          const r = await run(actor, c.q, 'all');
          ms.push(r.ms);
          hits = r.hits;
          msOnly.push((await run(actor, c.q, 'messages')).ms);
        }
        all.push(...ms);
        messagesOnly.push(...msOnly);
        lines.push(
          `| ${c.label} | ${hits} | ${pct(ms, 50).toFixed(0)} ms | ${pct(ms, 95).toFixed(0)} ms | ${pct(msOnly, 50).toFixed(0)} ms | ${pct(msOnly, 95).toFixed(0)} ms |`,
        );
      }
      const p95 = pct(all, 95);
      const p95m = pct(messagesOnly, 95);
      const over = p95 > BUDGET_MS || p95m > BUDGET_MS;
      if (over) failed = true;
      lines.push(
        `**${label}: p95 ${p95m.toFixed(0)} ms over ${messagesOnly.length} message searches, p95 ${p95.toFixed(0)} ms over ${all.length} searches of all three kinds${over ? ' OVER BUDGET' : ''}**`,
      );
    }
    console.log(lines.join('\n'));
    log(failed ? `FAIL: a persona's p95 is over ${BUDGET_MS} ms` : `ok: every persona's p95 under ${BUDGET_MS} ms`);
  } finally {
    await appPool.end();
    await owner.end();
    if (!keep && !REUSE) await dropTestDatabase(db);
  }
  if (failed) process.exit(1);
}

await main();
