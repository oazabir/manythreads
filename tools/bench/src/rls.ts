/**
 * P3-00 RLS cost benchmark: 300,000 `stub_resources` rows across the three seed teams under FORCE RLS, read as three people.
 * An unscoped `SELECT count(*)` as Nadia (one team), Lena (guest, sees nothing) and Omar (owner, every team) must each take
 * under 2 s (docs/retro/phase-2.md section 9 measured 77 s, 74 s and 21 s with the per-row `app.can_in_team() OR app.can()`
 * policy). Exits 1 when any case is over the budget.
 *
 * Run: pnpm --filter @manythreads/tools-bench bench:rls   (needs the dev Postgres: pnpm db:up)
 * Env: BENCH_ROWS (default 300000), BENCH_BUDGET_MS (default 2000), BENCH_RUNS (default 3, the best run counts).
 * Flag --legacy: swap in the pre-0011 per-row policy first, to reproduce the "before" numbers (takes minutes).
 */
import { createAppPool, withActor, type Actor } from '@manythreads/kernel';
import {
  KAHF_WORKSPACE_ID,
  LENA,
  NADIA,
  OMAR,
  TEAM_IDS,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  findPerRowPolicyCalls,
  personaActor,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
} from '@manythreads/test-utils';
import pg from 'pg';

const ROWS = Number(process.env['BENCH_ROWS'] ?? 300_000);
const BUDGET_MS = Number(process.env['BENCH_BUDGET_MS'] ?? 2000);
const RUNS = Number(process.env['BENCH_RUNS'] ?? 3);
const LEGACY = process.argv.includes('--legacy');

const t0 = Date.now();
const log = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

interface Case {
  label: string;
  persona: Persona;
}
const CASES: Case[] = [
  { label: 'Nadia (member of Engineering)', persona: NADIA },
  { label: 'Lena (guest, denied everything)', persona: LENA },
  { label: 'Omar (owner, every team)', persona: OMAR },
];

async function timed<T>(actor: Actor, pool: pg.Pool, sql: string): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await withActor(actor, async (tx) => (await tx.query(sql)).rows[0] as T, { pool });
  return { ms: performance.now() - start, value };
}

async function best(actor: Actor, pool: pg.Pool, sql: string): Promise<{ ms: number; value: Record<string, unknown> }> {
  let winner: { ms: number; value: Record<string, unknown> } | undefined;
  for (let i = 0; i < RUNS; i++) {
    const r = await timed<Record<string, unknown>>(actor, pool, sql);
    if (!winner || r.ms < winner.ms) winner = r;
  }
  return winner as { ms: number; value: Record<string, unknown> };
}

async function main(): Promise<void> {
  const db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource] });
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  const appPool = createAppPool(db.appUrl, 4);
  let failed = false;
  try {
    await createPersonas(db);
    if (LEGACY) {
      await owner.query(`
        DROP POLICY stub_resources_select ON app.stub_resources;
        CREATE POLICY stub_resources_select ON app.stub_resources FOR SELECT
          USING (app.is_system() OR app.can_in_team(team_id, 'read') OR app.can('stub_resource', id, 'read'));`);
      log('legacy per-row policy installed');
    }
    if (process.env['BENCH_POLICY']) {
      await owner.query(`DROP POLICY stub_resources_select ON app.stub_resources;
        CREATE POLICY stub_resources_select ON app.stub_resources FOR SELECT USING (${process.env['BENCH_POLICY']})`);
      log('policy overridden by BENCH_POLICY');
    }
    const teams = Object.values(TEAM_IDS);
    await owner.query(
      `INSERT INTO app.stub_resources (workspace_id, team_id, name)
       SELECT $1, ($2::uuid[])[1 + (g % 3)], 'stub ' || g FROM generate_series(1, $3) g`,
      [KAHF_WORKSPACE_ID, teams, ROWS],
    );
    await owner.query('ANALYZE app.stub_resources');
    log(`${ROWS} stub_resources rows (${teams.length} teams), ANALYZE done`);

    const calls = await findPerRowPolicyCalls(owner, 'stub_resources');
    log(`per-row policy calls in the read plan: ${calls.length === 0 ? 'none (InitPlan)' : calls.map((c) => c.function).join(', ')}`);

    const rows: string[] = ['| case | count(*) | best of ' + RUNS + ' | newest 50 (readable team) |', '|---|---|---|---|'];
    for (const { label, persona } of CASES) {
      const actor = personaActor(persona);
      const count = await best(actor, appPool, 'SELECT count(*)::int AS n FROM app.stub_resources');
      const newest = await best(
        actor,
        appPool,
        `SELECT count(*)::int AS n FROM (SELECT id FROM app.stub_resources WHERE team_id = '${TEAM_IDS.Engineering}' ORDER BY id DESC LIMIT 50) s`,
      );
      const over = count.ms > BUDGET_MS;
      if (over) failed = true;
      rows.push(
        `| ${label} | ${String(count.value['n'])} rows in ${count.ms.toFixed(0)} ms${over ? ' OVER BUDGET' : ''} | | ${String(newest.value['n'])} rows in ${newest.ms.toFixed(0)} ms |`,
      );
    }
    console.log(rows.join('\n'));
    log(failed ? `FAIL: an unscoped count took longer than ${BUDGET_MS} ms` : `ok: every unscoped count under ${BUDGET_MS} ms`);
  } finally {
    await appPool.end();
    await owner.end();
    await dropTestDatabase(db);
  }
  if (failed) process.exit(1);
}

await main();
