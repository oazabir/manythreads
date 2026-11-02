import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  analyticsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  TEAM_IDS,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-11: who reads the usage numbers (a workspace admin all of the workspace, a team member the non-money rows of their teams, a guest nothing), that only
// the system role writes, that a row never names a person and a team together, and how the monthly partitions are made and detached.

const { omar, nadia, tariq, priya, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let otherWorkspace: string;
let otherOwner: string;

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

interface Seed {
  ws?: string;
  team?: string | null;
  actor?: string | null;
  metric: string;
  value?: number;
  at?: string;
  dims?: Record<string, unknown>;
}
const insertEvent = (tx: Tx, s: Seed): Promise<unknown> =>
  tx.query(
    `INSERT INTO app.analytics_events (id, occurred_at, workspace_id, team_id, actor_id, metric, value, dims)
     VALUES ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8::jsonb)`,
    [randomUUID(), s.at ?? null, s.ws ?? omar.workspaceId, s.team ?? null, s.actor ?? null, s.metric, s.value ?? 1, JSON.stringify(s.dims ?? {})],
  );
const metricsSeenBy = (p: Persona, table = 'analytics_events'): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ metric: string; team_id: string | null }>(`SELECT metric, team_id FROM app.${table} ORDER BY metric, team_id`)).rows.map((r) => `${r.metric}@${r.team_id ?? 'workspace'}`));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, analyticsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const ids = await withSystem(
    async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]!.id;
      const person = (await tx.query<{ id: string }>(`INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]!.id;
      await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
      return { ws, actor };
    },
    { pool: sysPool },
  );
  otherWorkspace = ids.ws;
  otherOwner = ids.actor;
  await sys(async (tx) => {
    await insertEvent(tx, { team: ENG, metric: 'run.count', dims: { status: 'done' } });
    await insertEvent(tx, { team: ENG, metric: 'tool.call', dims: { outcome: 'allowed' } });
    await insertEvent(tx, { team: ENG, metric: 'llm.cost_micro', value: 1200, dims: { alias: 'smart' } });
    await insertEvent(tx, { team: MKT, metric: 'run.count', dims: { status: 'failed' } });
    await insertEvent(tx, { team: MKT, metric: 'llm.cost_micro', value: 900, dims: { alias: 'fast' } });
    await insertEvent(tx, { actor: omar.actorId, metric: 'signin.ok', dims: { method: 'password' } });
    await insertEvent(tx, { metric: 'llm.cost_micro', value: 50, dims: { alias: 'smart' } });
    await tx.query(
      `INSERT INTO app.analytics_daily (day, workspace_id, team_id, metric, dim, total, n) VALUES
         (current_date, $1, $2, 'run.count', 'done', 3, 3), (current_date, $1, $2, 'llm.cost_micro', 'smart', 1200, 1),
         (current_date, $1, $3, 'run.count', 'failed', 1, 1), (current_date, $1, NULL, 'signin.ok', 'password', 1, 1)`,
      [omar.workspaceId, ENG, MKT],
    );
  });
  await withSystem(async (tx) => void (await insertEvent(tx, { ws: otherWorkspace, metric: 'run.count' })), { pool: sysPool, workspaceId: otherWorkspace as never });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('analytics tables (P8-11)', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'analytics_events')).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'analytics_daily')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('are read by a workspace admin across the whole workspace, money and no-team rows included, and not across workspaces', async () => {
    const seen = await metricsSeenBy(omar);
    expect(seen).toEqual(
      [`llm.cost_micro@${ENG}`, `llm.cost_micro@${MKT}`, 'llm.cost_micro@workspace', `run.count@${ENG}`, `run.count@${MKT}`, 'signin.ok@workspace', `tool.call@${ENG}`].sort(),
    );
    const other = await withActor({ kind: 'person', id: otherOwner as never, workspaceId: otherWorkspace as never }, async (tx) => (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.analytics_events')).rows, { pool: appPool });
    expect(other.map((r) => r.workspace_id)).toEqual([otherWorkspace]);
  });

  it('are read by a team member for their own teams only, without money and without the workspace rows', async () => {
    expect(await metricsSeenBy(nadia)).toEqual([`run.count@${ENG}`, `tool.call@${ENG}`]); // Engineering member
    expect(await metricsSeenBy(tariq)).toEqual([`run.count@${MKT}`]); // Marketing lead, not an admin
    expect(await metricsSeenBy(priya)).toEqual([`run.count@${ENG}`, `run.count@${MKT}`, `tool.call@${ENG}`]); // both teams
    expect(await metricsSeenBy(nadia, 'analytics_daily')).toEqual([`run.count@${ENG}`]);
    expect(await metricsSeenBy(tariq, 'analytics_daily')).toEqual([`run.count@${MKT}`]);
  });

  it('are not read by a guest', async () => {
    expect(await metricsSeenBy(lena)).toEqual([]);
    expect(await metricsSeenBy(lena, 'analytics_daily')).toEqual([]);
  });

  it('are written only by the system role, and nobody changes or removes a stored event', async () => {
    expect(await code(as(omar, (tx) => insertEvent(tx, { team: ENG, metric: 'run.count' })))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.analytics_events SET value = 2`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.analytics_events')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.analytics_daily (day, workspace_id, metric, total, n) VALUES (current_date, $1, 'run.count', 1, 1)`, [omar.workspaceId])))).toBe('42501');
    expect(await code(sys((tx) => tx.query(`UPDATE app.analytics_events SET value = 2`)))).toBe('42501');
    expect(await code(sys((tx) => tx.query('DELETE FROM app.analytics_events')))).toBe('42501');
    expect(await code(sys((tx) => tx.query('TRUNCATE app.analytics_events')))).toBe('42501');
  });

  it('keep the sweep position away from the app role', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.analytics_progress')))).toBe('42501');
  });

  it('never hold a person and a team on one row, nor text where a number or a short label goes', async () => {
    expect(await code(sys((tx) => insertEvent(tx, { team: ENG, actor: omar.actorId, metric: 'run.count' })))).toBe('23514');
    expect(await code(sys((tx) => insertEvent(tx, { metric: 'Not A Metric' })))).toBe('23514');
    expect(await code(sys((tx) => insertEvent(tx, { metric: 'run.count', value: Number.POSITIVE_INFINITY })))).toBe('23514');
    expect(await code(sys((tx) => insertEvent(tx, { metric: 'run.count', dims: { note: 'x'.repeat(1200) } })))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.analytics_events (id, occurred_at, workspace_id, metric, value, dims) VALUES ($1, now(), $2, 'run.count', 1, '[1]')`, [randomUUID(), omar.workspaceId])))).toBe('23514');
  });

  it('keep one daily row per day, workspace, metric, label, team and bot, with an empty team counted as one', async () => {
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.analytics_daily (day, workspace_id, team_id, metric, dim, total, n) VALUES (current_date, $1, NULL, 'signin.ok', 'password', 5, 5)`, [omar.workspaceId])))).toBe('23505');
  });
});

describe('the monthly partitions (P8-11)', () => {
  const owner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = testClient({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const attached = (): Promise<string[]> =>
    owner(async (c) => (await c.query<{ relname: string }>(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'app.analytics_events'::regclass ORDER BY 1`)).rows.map((r) => r.relname));
  const monthName = (offset: number): string => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + offset, 1);
    return `analytics_events_${d.toISOString().slice(0, 7).replace('-', '_')}`;
  };

  it('exist for this month and the next two after the migration', async () => {
    expect(await attached()).toEqual([monthName(0), monthName(1), monthName(2)].sort());
  });

  it('are made by a write for a month that has none, once, and refused outside the kept window', async () => {
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
    const later = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 3, 1)).toISOString().slice(0, 10);
    const tooFar = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 4, 1)).toISOString().slice(0, 10);
    const ago = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    const answer = (month: string, oldest: string) => sys(async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.analytics_ensure_month($1::date, $2::date) AS ok', [month, oldest])).rows[0]!.ok);
    expect(await answer(thisMonth, thisMonth)).toBe(true); // already there
    expect(await answer(later, thisMonth)).toBe(true); // made
    expect(await answer(later, thisMonth)).toBe(true); // and not made twice
    expect(await attached()).toContain(monthName(3));
    expect(await answer(tooFar, thisMonth)).toBe(false); // a clock gone wrong makes no partitions
    expect(await answer(ago, thisMonth)).toBe(false); // older than the window
    expect(await attached()).not.toContain(monthName(4));
    // the new month takes a row and routes it to its own partition
    await sys((tx) => insertEvent(tx, { team: ENG, metric: 'run.count', at: `${later}T12:00:00Z` }));
    const where = await owner(async (c) => (await c.query<{ p: string }>(`SELECT tableoid::regclass::text AS p FROM app.analytics_events WHERE occurred_at = $1::timestamptz`, [`${later}T12:00:00Z`])).rows[0]?.p);
    expect(where).toBe(`app.${monthName(3)}`);
  });

  it('are skipped by a one-day read: only the partition of that day is in the plan', async () => {
    const day = new Date();
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
    const to = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString();
    const plan = await owner(async (c) => {
      const res = await c.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) SELECT metric, sum(value) FROM app.analytics_events WHERE occurred_at >= '${from}' AND occurred_at < '${to}' GROUP BY metric`);
      return JSON.stringify(res.rows[0]!['QUERY PLAN']);
    });
    const touched = new Set(plan.match(/analytics_events_\d{4}_\d{2}/g) ?? []);
    expect(touched.size).toBeLessThanOrEqual(1);
  });

  it('are locked down: the app role cannot read one directly and the system role cannot edit it', async () => {
    expect(await code(as(omar, (tx) => tx.query(`SELECT * FROM app.${monthName(0)}`)))).toBe('42501');
    expect(await code(sys((tx) => tx.query(`UPDATE app.${monthName(0)} SET value = 3`)))).toBe('42501');
    expect(await code(sys((tx) => tx.query(`DELETE FROM app.${monthName(0)}`)))).toBe('42501');
    // the policies of the parent still decide what a normal read sees (the partition is reached through it)
    expect(await metricsSeenBy(lena)).toEqual([]);
  });

  it('cannot be made or detached by the app role', async () => {
    expect(await code(as(omar, (tx) => tx.query(`SELECT app.analytics_ensure_month(current_date, current_date)`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`SELECT app.analytics_detach_before(current_date)`)))).toBe('42501');
  });

  it('are detached, not dropped, once their whole month is past, keeping their rows and not clashing with a new one', async () => {
    // make an old month by hand (the window refuses it for a write), put a row in it, then detach everything that ended a month ago
    await owner(async (c) => {
      // made by the same function a write uses, with a window that reaches back that far
      expect((await c.query<{ ok: boolean }>(`SELECT app.analytics_ensure_month('2020-01-01', '2020-01-01') AS ok`)).rows[0]!.ok).toBe(true);
      await c.query(`INSERT INTO app.analytics_events (id, occurred_at, workspace_id, metric, value) VALUES (gen_random_uuid(), '2020-01-15 10:00:00+00', $1, 'run.count', 1)`, [omar.workspaceId]);
    });
    const detached = await sys(async (tx) => (await tx.query<{ names: string[] }>(`SELECT app.analytics_detach_before(date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS names`)).rows[0]!.names);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatch(/^analytics_events_2020_01_detached_\d{14}$/);
    expect(await attached()).not.toContain('analytics_events_2020_01');
    const kept = await owner(async (c) => (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${detached[0]}`)).rows[0]!.n);
    expect(kept).toBe('1');
    // the current and the coming months stay attached
    expect(await attached()).toEqual(expect.arrayContaining([monthName(0), monthName(1), monthName(2)]));
    // the detached month keeps the lock-down the partition had and passes the harness (it is a plain table now)
    expect(await code(as(omar, (tx) => tx.query(`SELECT * FROM app.${detached[0]}`)))).toBe('42501');
    expect(await owner((c) => explainRlsViolations(c))).toEqual([]);
  });
});
