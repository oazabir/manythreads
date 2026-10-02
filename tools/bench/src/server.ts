/**
 * P1-11 server benchmark: 1M messages under FORCE RLS (newest-50, trigram search) and outbox throughput.
 * Run: pnpm --filter @manythreads/tools-bench bench:server   (needs the dev Postgres: pnpm db:up)
 * Env: BENCH_ROWS (default 1000000), BENCH_EVENTS (default 20000).
 */
import { randomUUID } from 'node:crypto';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import {
  createAppPool,
  createSystemPool,
  emit,
  ensureActor,
  startConsumer,
  subscribe,
  withActor,
  withSystem,
  type Actor,
} from '@manythreads/kernel';
import { createTestDatabase, dropTestDatabase } from '@manythreads/test-utils';
import pg from 'pg';

const ROWS = Number(process.env['BENCH_ROWS'] ?? 1_000_000);
const EVENTS = Number(process.env['BENCH_EVENTS'] ?? 20_000);
const CHANNELS = 200;
const MEMBERS = 50;
const CHANNELS_PER_MEMBER = 20;
const CONSUMERS = 4;

const t0 = Date.now();
const secs = (since: number): string => ((Date.now() - since) / 1000).toFixed(1);
const log = (m: string): void => console.log(`[${secs(t0)}s] ${m}`);

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
}
const fmt = (n: number): string => n.toFixed(2);

// Vocabulary: 150 common English-ish words (uniform), plus tiers of search terms with known rarity.
const COMMON =
  'the a to of and in it is that for on with as was we are be this have from or by not but they you at will can one all there when what our out up about if so do just more some time new work team project deploy release build test review merge branch commit issue ticket bug fix update meeting today tomorrow friday notes doc draft plan design api server client database query index cache latency error log alert incident customer feedback roadmap priority sprint demo ship launch rollback config secret token access permission channel thread message reply thanks please looks good great agree maybe later soon done blocked waiting approve decline schedule invite budget report metrics dashboard weekly daily summary question answer idea proposal risk owner deadline status progress example link file folder upload download share comment mention bot brain memory'.split(
    ' ',
  );
const WORDS = [...COMMON, ...Array.from({ length: 150 }, (_, i) => `tok${(i * 7919) % 1000}x`)];
// search terms: ~common (in most rows), medium (~1-3%), rare (~0.05%)
const SEARCH = [
  { label: 'common', term: 'deploy' },
  { label: 'medium', term: 'tok0x' },
  { label: 'rare', term: 'zebrafish' },
];

async function main(): Promise<void> {
  const db = await createTestDatabase();
  log(`fresh database ${db.name} (kernel migrations applied: ${db.applied})`);
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  const version = (await owner.query<{ v: string }>('SELECT version() v')).rows[0]?.v;
  const settings = (
    await owner.query<{ name: string; setting: string; unit: string | null }>(
      `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','max_parallel_workers_per_gather','effective_cache_size')`,
    )
  ).rows
    .map((r) => `${r.name}=${r.setting}${r.unit ?? ''}`)
    .join(', ');
  console.log(`PG version ${version}; ${settings}`);

  const workspaceId = WorkspaceId.parse(randomUUID());
  const appPool = createAppPool(db.appUrl, 12);
  const sysPool = createSystemPool(db.systemUrl, 12);
  try {
    // ---------- schema ----------
    await owner.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE SCHEMA bench;
      CREATE TABLE bench.bench_members (channel_id uuid NOT NULL, person_id uuid NOT NULL, PRIMARY KEY (channel_id, person_id));
      CREATE INDEX bench_members_person ON bench.bench_members (person_id);
      CREATE TABLE bench.bench_messages (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        workspace_id uuid NOT NULL, team_id uuid NOT NULL, channel_id uuid NOT NULL, author_id uuid NOT NULL,
        body text NOT NULL, body_plain text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE bench.bench_messages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE bench.bench_messages FORCE ROW LEVEL SECURITY;
      ALTER TABLE bench.bench_members ENABLE ROW LEVEL SECURITY;
      ALTER TABLE bench.bench_members FORCE ROW LEVEL SECURITY;
      CREATE POLICY m_read ON bench.bench_members FOR SELECT USING (person_id = app.person_id());
      CREATE POLICY msg_read ON bench.bench_messages FOR SELECT USING (
        channel_id IN (SELECT bm.channel_id FROM bench.bench_members bm WHERE bm.person_id = app.person_id()));
      GRANT USAGE ON SCHEMA bench TO manythreads_app;
      GRANT SELECT ON bench.bench_messages, bench.bench_members TO manythreads_app;
      CREATE TABLE bench.channels AS SELECT uuidv7() AS id, g AS n FROM generate_series(1, ${CHANNELS}) g;
      CREATE TABLE bench.people AS SELECT uuidv7() AS id, g AS n FROM generate_series(1, ${MEMBERS}) g;`);

    // Membership: person p is in CHANNELS_PER_MEMBER channels (a sliding window over the 200 channels).
    await owner.query(
      `INSERT INTO bench.bench_members
       SELECT c.id, p.id FROM bench.people p JOIN bench.channels c
         ON ((c.n - 1 - (p.n - 1) * 4) % ${CHANNELS} + ${CHANNELS}) % ${CHANNELS} < ${CHANNELS_PER_MEMBER}`,
    );

    // ---------- load ----------
    const tl = Date.now();
    const words = WORDS.map((w) => `'${w}'`).join(',');
    const batch = 100_000;
    for (let off = 0; off < ROWS; off += batch) {
      const n = Math.min(batch, ROWS - off);
      await owner.query(
        `WITH ch AS (SELECT array_agg(id ORDER BY n) a FROM bench.channels),
              pe AS (SELECT array_agg(id ORDER BY n) a FROM bench.people)
         INSERT INTO bench.bench_messages (workspace_id, team_id, channel_id, author_id, body, body_plain, created_at)
         SELECT $1::uuid, $1::uuid, ch.a[1 + (g % ${CHANNELS})], pe.a[1 + (g % ${MEMBERS})], t.txt, t.txt,
                now() - ((${ROWS} - g) * interval '30 seconds')
         FROM ch, pe, generate_series($3::int + 1, $3::int + $2::int) AS g,
              LATERAL (SELECT string_agg((ARRAY[${words}])[1 + floor(random() * ${WORDS.length})::int + 0 * k], ' ') AS txt
                       FROM generate_series(1, 6 + (g % 14)) k(k)) t`,
        [workspaceId, n, off],
      );
      process.stdout.write(`\r  loaded ${off + n}/${ROWS}`);
    }
    process.stdout.write('\n');
    // Seed the rare term into ~0.05% of rows so the rare search has a known selectivity.
    await owner.query(
      `UPDATE bench.bench_messages SET body = body || ' zebrafish', body_plain = body_plain || ' zebrafish'
       WHERE (hashtext(id::text) & 2047) = 0`,
    );
    log(`loaded ${ROWS} rows in ${secs(tl)}s`);

    const ti = Date.now();
    await owner.query('CREATE INDEX bench_messages_channel_id ON bench.bench_messages (channel_id, id DESC)');
    log(`btree (channel_id, id DESC) built in ${secs(ti)}s`);
    const tg = Date.now();
    await owner.query('CREATE INDEX bench_messages_trgm ON bench.bench_messages USING gin (body_plain gin_trgm_ops)');
    log(`GIN trigram built in ${secs(tg)}s`);
    await owner.query('VACUUM (ANALYZE) bench.bench_messages');
    await owner.query('ANALYZE bench.bench_members');
    const size = (
      await owner.query<{ t: string; i: string }>(
        `SELECT pg_size_pretty(pg_table_size('bench.bench_messages')) t, pg_size_pretty(pg_indexes_size('bench.bench_messages')) i`,
      )
    ).rows[0];
    console.log(`table ${size?.t}, indexes ${size?.i}`);

    // ---------- actor ----------
    const personRef = (await owner.query<{ id: string }>(`SELECT id FROM bench.people WHERE n = 1`)).rows[0]
      ?.id as string;
    const actor: Actor = await withSystem(
      (tx) => ensureActor(tx, { kind: 'person', workspaceId, refId: personRef as never }),
      { pool: sysPool },
    );
    const chans = (
      await owner.query<{ id: string }>(
        `SELECT channel_id AS id FROM bench.bench_members WHERE person_id = $1 ORDER BY channel_id`,
        [personRef],
      )
    ).rows.map((r) => r.id);
    const rls = (await owner.query<{ n: string }>(`SELECT count(*) n FROM bench.bench_members`)).rows[0]?.n;
    console.log(`actor is member of ${chans.length} of ${CHANNELS} channels (${rls} membership rows)`);

    const asActor = <T>(fn: (q: (sql: string, v?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> =>
      withActor(actor, (tx) => fn((s, v) => tx.query(s, v)), { pool: appPool });

    // ---------- newest-50 ----------
    const NEWEST = `SELECT id, author_id, body, created_at FROM bench.bench_messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 50`;
    for (let i = 0; i < 20; i++) await asActor((q) => q(NEWEST, [chans[i % chans.length]]));
    const lat: number[] = [];
    for (let i = 0; i < 200; i++) {
      const ch = chans[i % chans.length];
      const s = performance.now();
      const r = await asActor((q) => q(NEWEST, [ch]));
      lat.push(performance.now() - s);
      if (r.rowCount !== 50) throw new Error(`newest-50 returned ${r.rowCount} rows`);
    }
    console.log(`newest-50 (member channel, FORCE RLS, 200 runs incl. txn+set_config): p50 ${fmt(pct(lat, 50))} ms  p95 ${fmt(pct(lat, 95))} ms`);
    const plan = await asActor((q) =>
      q(`EXPLAIN (ANALYZE, BUFFERS) ${NEWEST}`, [chans[0]]).catch(() => q(`EXPLAIN (ANALYZE, BUFFERS) ${NEWEST.replace('$1', `'${chans[0]}'`)}`)),
    );
    const lines = plan.rows.map((r) => String(r['QUERY PLAN']));
    const scan = lines
      .filter((l) => /(Index|Seq|Bitmap|Sort|Limit|Nested|Hash)\w*( Scan| Join)?\s+(on|using)?/.test(l) && l.includes('('))
      .map((l) => l.replace(/\(cost=[^)]*\)/, '').replace(/\s+/g, ' ').trim().replace(/\(actual time=.*$/, '').trim())
      .join(' ; ');
    const exec = lines.find((l) => l.startsWith('Execution Time')) ?? '';
    const buf = lines.find((l) => l.includes('Buffers:')) ?? '';
    console.log(`EXPLAIN newest-50: ${scan} | ${buf.trim()} | ${exec}`);
    console.log(`  uses channel index: ${lines.some((l) => l.includes('bench_messages_channel_id'))}`);

    // ---------- trigram search ----------
    for (const [variant, order] of [['ORDER BY id DESC (planner may walk the pkey)', 'id'], ['ORDER BY created_at DESC (top-N over the trigram bitmap)', 'created_at']] as const)
    for (const { label, term } of SEARCH) {
      const SQL = `SELECT id, channel_id, body FROM bench.bench_messages WHERE body_plain ILIKE $1 ORDER BY ${order} DESC LIMIT 20`;
      const hits = (
        await owner.query<{ n: string }>(`SELECT count(*) n FROM bench.bench_messages WHERE body_plain ILIKE $1`, [`%${term}%`])
      ).rows[0]?.n;
      await asActor((q) => q(SQL, [`%${term}%`]));
      const sl: number[] = [];
      let got = 0;
      for (let i = 0; i < 50; i++) {
        const s = performance.now();
        const r = await asActor((q) => q(SQL, [`%${term}%`]));
        sl.push(performance.now() - s);
        got = r.rowCount ?? 0;
      }
      const ex = await asActor((q) => q(`EXPLAIN (ANALYZE) ${SQL.replace('$1', `'%${term}%'`)}`));
      const first = ex.rows.map((r) => String(r['QUERY PLAN'])).find((l) => /Scan/.test(l))?.trim();
      console.log(`search[${variant}] ILIKE '%${term}%' [${label}, ${hits} matching rows total, ${got} returned], 50 runs: p50 ${fmt(pct(sl, 50))} ms  p95 ${fmt(pct(sl, 95))} ms  | ${first}`);
    }

    // ---------- outbox throughput ----------
    await withSystem(
      async (tx) => {
        for (let i = 0; i < CONSUMERS; i++) await subscribe(tx, `bench-${i}`, 'kernel.test.pinged');
      },
      { pool: sysPool },
    );
    const emitters = Array.from({ length: 8 }, () => personActorFor(workspaceId));
    const consumers = Array.from({ length: CONSUMERS }, (_, i) =>
      startConsumer({ subscriber: `bench-${i}`, handler: () => undefined, batch: 200, pollMs: 200, pool: sysPool }),
    );
    const to = Date.now();
    let next = 0;
    let emitDone = 0;
    await Promise.all(
      emitters.map(async (a) => {
        while (next < EVENTS) {
          next++;
          await withActor(a, (tx) => emit(tx, { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId, note: 'bench' }), {
            pool: appPool,
          });
          emitDone++;
        }
      }),
    );
    const emitSecs = (Date.now() - to) / 1000;
    const total = (): number => consumers.reduce((s, c) => s + c.delivered(), 0);
    const deadline = Date.now() + 180_000;
    while (total() < EVENTS * CONSUMERS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const e2eSecs = (Date.now() - to) / 1000;
    await Promise.all(consumers.map((c) => c.stop()));
    console.log(
      `outbox: ${emitDone} events x ${CONSUMERS} consumers: emit-only ${(emitDone / emitSecs).toFixed(0)} ev/s; end-to-end (all ${total()} deliveries) ${(EVENTS / e2eSecs).toFixed(0)} events/s (${(total() / e2eSecs).toFixed(0)} deliveries/s) in ${e2eSecs.toFixed(1)}s`,
    );
  } finally {
    await appPool.end();
    await sysPool.end();
    await owner.end();
    await dropTestDatabase(db);
  }
  log('done');
}

function personActorFor(workspaceId: WorkspaceId): Actor {
  return { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
