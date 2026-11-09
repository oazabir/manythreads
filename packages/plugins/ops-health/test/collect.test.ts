import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeadJobCounter, collectProcess, collectVolumes, collectDatabaseSections, summariseBudgets } from '../src/collect.ts';

describe('summariseBudgets', () => {
  it('counts caps, those near (80 %) or past (100 %) and the fullest', () => {
    expect(summariseBudgets([{ cap: 100, spent: 10 }, { cap: 50, spent: 45 }, { cap: 10, spent: 12 }])).toEqual({ limits: 3, nearLimit: 2, exhausted: 1, maxBurnPercent: 120 });
  });
  it('is empty without caps', () => {
    expect(summariseBudgets([])).toEqual({ limits: 0, nearLimit: 0, exhausted: 0, maxBurnPercent: 0 });
  });
  it('ignores a cap of zero', () => {
    expect(summariseBudgets([{ cap: 0, spent: 5 }]).limits).toBe(0);
  });
});

describe('collectVolumes', () => {
  it('reads the size and free space of a real directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-health-'));
    try {
      const [v] = await collectVolumes([{ name: 'scratch', path: dir }]);
      expect(v?.name).toBe('scratch');
      expect(v?.totalBytes).toBeGreaterThan(0);
      expect(v?.freeBytes).toBeLessThanOrEqual(v?.totalBytes ?? 0);
      expect(v?.usedPercent).toBeGreaterThanOrEqual(0);
      expect(v?.usedPercent).toBeLessThanOrEqual(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves out a path it cannot read and says which', async () => {
    const failed: string[] = [];
    const out = await collectVolumes([{ name: 'gone', path: '/definitely/not/here' }], (name) => failed.push(name));
    expect(out).toEqual([]);
    expect(failed).toEqual(['gone']);
  });
});

describe('collectProcess', () => {
  it('reports memory and uptime without an event-loop monitor', () => {
    const p = collectProcess(null);
    expect(p.residentBytes).toBeGreaterThan(0);
    expect(p.heapUsedBytes).toBeGreaterThan(0);
    expect(p.eventLoopLagP99Seconds).toBe(0);
  });
});

describe('DeadJobCounter', () => {
  it('reads at most once per interval and keeps the last answer when a read fails', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const c = new DeadJobCounter(
      async () => {
        calls += 1;
        if (fail) throw new Error('down');
        return calls * 10;
      },
      1000,
      () => now,
    );
    expect(await c.get()).toBe(10);
    now = 500;
    expect(await c.get()).toBe(10);
    expect(calls).toBe(1);
    now = 1500;
    fail = true;
    expect(await c.get()).toBe(10);
    expect(calls).toBe(2);
  });
  it('is null before the first successful read', async () => {
    const c = new DeadJobCounter(async () => Promise.reject(new Error('down')));
    expect(await c.get()).toBeNull();
  });
});

describe('collectDatabaseSections', () => {
  /** A transaction that answers by the table named in the statement, and fails for the ones in `broken`. */
  function fakeTx(answers: Record<string, unknown[]>, broken: string[] = []) {
    const statements: string[] = [];
    return {
      statements,
      tx: {
        actor: {},
        query: async (sql: string) => {
          statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
          if (/SAVEPOINT|RELEASE/.test(sql)) return { rows: [] };
          const key = Object.keys(answers).find((k) => sql.includes(k));
          if (key && broken.includes(key)) throw new Error(`relation ${key} does not exist`);
          return { rows: key ? answers[key] : [] };
        },
      },
    };
  }

  const answers = {
    'app.outbox': [{ backlog: 7, retrying: 1, oldest: 42.5 }],
    'app.jobs': [
      { queue: 'runtime-hermes.run', ready: 3, running: 6, oldest: 130 },
      { queue: 'files.gc', ready: 0, running: 1, oldest: 0 },
    ],
    'app.approvals': [{ pending: 2, oldest: 3600 }],
    'app.llm_limits': [{ cap: 10, spent: 9 }],
    pg_stat_activity: [{ used: 33, max: 100 }],
  };

  it('turns the rows into a snapshot, with run slots read from the run queue', async () => {
    const { tx } = fakeTx(answers);
    const s = await collectDatabaseSections(tx as never, { runSlotsLimit: 6, deadJobs: async () => 2 });
    expect(s.outbox).toEqual({ backlog: 7, retrying: 1, oldestAgeSeconds: 42.5 });
    expect(s.jobs).toMatchObject({ ready: 3, running: 7, dead: 2, oldestReadyAgeSeconds: 130, queues: [{ queue: 'runtime-hermes.run', ready: 3, oldestAgeSeconds: 130 }] });
    expect(s.runs).toEqual({ slotsUsed: 6, slotsLimit: 6, queued: 3, oldestQueuedAgeSeconds: 130 });
    expect(s.approvals).toEqual({ pending: 2, oldestPendingAgeSeconds: 3600 });
    expect(s.budgets).toEqual({ limits: 1, nearLimit: 1, exhausted: 0, maxBurnPercent: 90 });
    expect(s.database).toEqual({ connectionsUsed: 33, connectionsMax: 100 });
  });

  it('a failing section is null and the rest still answer', async () => {
    const { tx, statements } = fakeTx(answers, ['app.approvals', 'app.llm_limits']);
    const failed: string[] = [];
    const s = await collectDatabaseSections(tx as never, { runSlotsLimit: 6, deadJobs: async () => 0, onSectionError: (n) => failed.push(n) });
    expect(s.approvals).toBeNull();
    expect(s.budgets).toBeNull();
    expect(s.outbox).not.toBeNull();
    expect(s.database).not.toBeNull();
    expect(failed.sort()).toEqual(['approvals', 'budgets']);
    expect(statements.filter((x) => x.startsWith('ROLLBACK'))).toHaveLength(2);
  });

  it('measures the outbox over rows that are still undelivered: a row given up on (dead_at) is not backlog and does not age the lag', async () => {
    const seen: string[] = [];
    const tx = { actor: {}, query: async (sql: string) => (seen.push(sql), { rows: [] }) };
    await collectDatabaseSections(tx as never, { runSlotsLimit: 6, deadJobs: async () => 0 });
    const outbox = seen.find((sql) => sql.includes('FROM app.outbox')) ?? '';
    expect(outbox).toMatch(/done_at IS NULL\s+AND dead_at IS NULL/);
  });

  it('no job rows means no runs in progress, not an unreadable section', async () => {
    const { tx } = fakeTx({ ...answers, 'app.jobs': [] });
    const s = await collectDatabaseSections(tx as never, { runSlotsLimit: 4, deadJobs: async () => 0 });
    expect(s.runs).toEqual({ slotsUsed: 0, slotsLimit: 4, queued: 0, oldestQueuedAgeSeconds: 0 });
  });
});

describe('collectDatabaseSections: replication', () => {
  /** A transaction whose `pg_stat_replication` answer is the one given (or an error), everything else empty. */
  const withReplication = (row: Record<string, unknown> | Error | null) => ({
    actor: {},
    query: async (sql: string) => {
      if (sql.includes('pg_stat_replication')) {
        if (row instanceof Error) throw row;
        return { rows: row === null ? [] : [row] };
      }
      return { rows: [] };
    },
  });
  const read = async (row: Record<string, unknown> | Error | null) =>
    (await collectDatabaseSections(withReplication(row) as never, { runSlotsLimit: 6, deadJobs: async () => 0 })).replication;

  it('a single database has no standby and no lag', async () => {
    expect(await read({ standbys: 0, readable: 0, lag: null })).toEqual({ standbys: 0, lagSeconds: null });
    expect(await read(null)).toEqual({ standbys: 0, lagSeconds: null });
  });

  it('one standby reports how far behind it is', async () => {
    expect(await read({ standbys: 1, readable: 1, lag: 12.5 })).toEqual({ standbys: 1, lagSeconds: 12.5 });
  });

  it('a standby this role cannot read is unknown, never a lag of zero', async () => {
    expect(await read({ standbys: 2, readable: 1, lag: 3 })).toEqual({ standbys: 2, lagSeconds: null });
  });

  it('a failing read is a null section and the rest still answer', async () => {
    const failed: string[] = [];
    const s = await collectDatabaseSections(withReplication(new Error('permission denied')) as never, {
      runSlotsLimit: 6,
      deadJobs: async () => 0,
      onSectionError: (n) => failed.push(n),
    });
    expect(s.replication).toBeNull();
    expect(s.outbox).not.toBeNull();
    expect(failed).toEqual(['replication']);
  });

  it('asks only for readable rows when it measures the lag', async () => {
    const seen: string[] = [];
    const tx = { actor: {}, query: async (sql: string) => (seen.push(sql), { rows: [] }) };
    await collectDatabaseSections(tx as never, { runSlotsLimit: 6, deadJobs: async () => 0 });
    expect(seen.find((sql) => sql.includes('pg_stat_replication'))).toMatch(/FILTER \(WHERE replay_lsn IS NOT NULL\)/);
  });
});
