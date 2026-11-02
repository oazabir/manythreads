import type { PluginTx } from '@manythreads/sdk';
import { ANALYTICS_METRIC_LABEL } from '@manythreads/shared';
import { BACKFILL_DAYS, SWEEP_OVERLAP_MS, eventMonths, oldestKeptMonth } from './config.ts';
import { ensureMonths, monthsBetween } from './write.ts';

// The background work: read three source tables that no event covers (the spend ledger, a run's tool decisions, what a run reached), keep the partitions
// ahead of the clock, add the last two days up into `analytics_daily`, and detach months past the window. Every step can run twice: a row is stored under an
// id made from its source, and the rollup rewrites its days from the events.

export const PARTITIONS_QUEUE = 'analytics.partitions';
export const SWEEP_QUEUE = 'analytics.sweep';
export const ROLLUP_QUEUE = 'analytics.rollup';
export const RETAIN_QUEUE = 'analytics.retain';

const dayStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

async function getProgress(tx: PluginTx, name: string): Promise<string | null> {
  const res = await tx.query<{ value: string }>('SELECT value FROM app.analytics_progress WHERE name = $1', [name]);
  return res.rows[0]?.value ?? null;
}

async function setProgress(tx: PluginTx, name: string, value: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.analytics_progress (name, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, value],
  );
}

/** Partitions for the current month and the next two (the job's whole work). Answers the months that now have one. */
export async function ensurePartitions(tx: PluginTx, now: Date): Promise<string[]> {
  const months = monthsBetween(now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)));
  const ok = await ensureMonths(tx, months, now);
  return months.filter((m) => ok.has(m));
}

interface Source {
  /** The progress name: how far this source has been read. */
  name: string;
  /** The SELECT that makes events from the source rows in [$1, $2). */
  select: string;
}

// The time column of each source is its row's own commit-time default (`now()` at the start of the writing transaction), so a row may become visible a
// little after its time; the overlap re-reads a window and the ids skip what is already stored.
const SOURCES: Source[] = [
  {
    // one event per model call for the cost, one for the tokens
    name: 'llm_spend',
    select: `
      SELECT s.id AS id, s.occurred_at, s.workspace_id, s.team_id, s.bot_id, 'llm.cost_micro' AS metric, round(s.cost_usd * 1000000)::double precision AS value,
             jsonb_strip_nulls(jsonb_build_object('alias', s.alias, 'model', left(s.model, 80), 'purpose', left(s.purpose, 40),
                                                  'tokensIn', s.prompt_tokens, 'tokensOut', s.completion_tokens)) AS dims
        FROM app.llm_spend s WHERE s.occurred_at >= $1 AND s.occurred_at < $2
      UNION ALL
      SELECT md5(s.id::text || ':llm.tokens')::uuid, s.occurred_at, s.workspace_id, s.team_id, s.bot_id, 'llm.tokens',
             (s.prompt_tokens + s.completion_tokens)::double precision, jsonb_build_object('alias', s.alias)
        FROM app.llm_spend s WHERE s.occurred_at >= $1 AND s.occurred_at < $2`,
  },
  {
    // a tool call a run made: which tool and what the door decided (allowed, waits for a person, refused)
    name: 'run_decisions',
    select: `
      SELECT md5(d.run_id::text || ':' || d.seq::text || ':tool.call')::uuid AS id, d.created_at AS occurred_at, r.workspace_id, r.team_id, r.bot_id,
             'tool.call' AS metric, 1::double precision AS value,
             jsonb_build_object('tool', left(d.subject, 80), 'outcome', d.outcome) AS dims
        FROM app.run_decisions d JOIN app.bot_runs r ON r.id = d.run_id
       WHERE d.kind = 'tool' AND d.created_at >= $1 AND d.created_at < $2`,
  },
  {
    // a knowledge document a run reached (the document's name stays in the run's log, not here)
    name: 'run_source_log',
    select: `
      SELECT md5(l.run_id::text || ':' || l.seq::text || ':knowledge.hit')::uuid AS id, l.created_at AS occurred_at, r.workspace_id, r.team_id, r.bot_id,
             'knowledge.hit' AS metric, 1::double precision AS value, jsonb_build_object('scope', l.scope) AS dims
        FROM app.run_source_log l JOIN app.bot_runs r ON r.id = l.run_id
       WHERE l.source_type = 'knowledge' AND l.created_at >= $1 AND l.created_at < $2`,
  },
];

export interface SweepResult {
  source: string;
  read: number;
  stored: number;
}

/** Reads each source from where it stopped last time (less the overlap) up to `now`, in slices of at most a month. */
export async function sweepSources(tx: PluginTx, now: Date): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  const oldest = new Date(oldestKeptMonth(now));
  for (const source of SOURCES) {
    const mark = await getProgress(tx, source.name);
    const last = mark === null ? null : new Date(mark);
    const from = new Date(Math.max(oldest.getTime(), last === null || Number.isNaN(last.getTime()) ? now.getTime() - BACKFILL_DAYS * 86_400_000 : last.getTime() - SWEEP_OVERLAP_MS));
    const months = await ensureMonths(tx, monthsBetween(from, now), now);
    let stored = 0;
    let read = 0;
    // a slice per month, so a row never needs a partition that was not ensured
    for (const month of monthsBetween(from, now)) {
      if (!months.has(month)) continue;
      const start = new Date(`${month}T00:00:00.000Z`);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const lo = new Date(Math.max(start.getTime(), from.getTime()));
      const hi = new Date(Math.min(end.getTime(), now.getTime()));
      if (lo >= hi) continue;
      const res = await tx.query<{ n: string; stored: string }>(
        `WITH src AS (${source.select}),
              ins AS (
                INSERT INTO app.analytics_events (id, occurred_at, workspace_id, team_id, bot_id, metric, value, dims)
                SELECT id, occurred_at, workspace_id, team_id, bot_id, metric, value, dims FROM src
                ON CONFLICT (id, occurred_at) DO NOTHING
                RETURNING 1)
         SELECT (SELECT count(*) FROM src)::text AS n, (SELECT count(*) FROM ins)::text AS stored`,
        [lo.toISOString(), hi.toISOString()],
      );
      read += Number(res.rows[0]?.n ?? 0);
      stored += Number(res.rows[0]?.stored ?? 0);
    }
    await setProgress(tx, source.name, now.toISOString());
    results.push({ source: source.name, read, stored });
  }
  return results;
}

/** The SQL of the label a metric rolls up by: `e.dims->>'alias'` for spend, and so on; '' for a metric with none. */
export function labelSql(column: string): string {
  const cases = Object.entries(ANALYTICS_METRIC_LABEL)
    .map(([metric, key]) => `WHEN '${metric}' THEN left(coalesce(${column}.dims ->> '${key}', ''), 80)`)
    .join(' ');
  return `CASE ${column}.metric ${cases} ELSE '' END`;
}

export interface RollupResult {
  from: string;
  to: string;
  groups: number;
}

/** Adds the events of [from, to) up into `analytics_daily`, a row per UTC day, team, bot, metric and label, rewriting each group that exists (ON CONFLICT … DO UPDATE). */
export async function rollupRange(tx: PluginTx, from: Date, to: Date): Promise<number> {
  const res = await tx.query(
    `INSERT INTO app.analytics_daily (day, workspace_id, team_id, bot_id, metric, dim, total, n)
     SELECT (e.occurred_at AT TIME ZONE 'UTC')::date, e.workspace_id, e.team_id, e.bot_id, e.metric, ${labelSql('e')}, sum(e.value), count(*)
       FROM app.analytics_events e
      WHERE e.occurred_at >= $1 AND e.occurred_at < $2
      GROUP BY 1, 2, 3, 4, 5, 6
     ON CONFLICT (workspace_id, day, metric, dim, team_id, bot_id) DO UPDATE SET total = EXCLUDED.total, n = EXCLUDED.n
     RETURNING 1`,
    [from.toISOString(), to.toISOString()],
  );
  return res.rows.length;
}

/**
 * The hourly rollup: whole UTC days from yesterday (or from the last day it finished, when the job was down for longer) to the end of today. The first run
 * on a deployment that already has events starts at the oldest event. Yesterday is rewritten once more by the next run, so events written late are counted.
 */
export async function rollupDays(tx: PluginTx, now: Date): Promise<RollupResult> {
  let from = addDays(dayStart(now), -1);
  const mark = await getProgress(tx, 'rolled_through');
  if (mark === null) {
    const first = await tx.query<{ day: string | null }>(`SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date::text AS day FROM app.analytics_events`);
    const day = first.rows[0]?.day;
    if (day) from = new Date(`${day}T00:00:00.000Z`);
  } else {
    const last = new Date(`${mark}T00:00:00.000Z`);
    if (!Number.isNaN(last.getTime()) && last < from) from = last;
  }
  const to = addDays(dayStart(now), 1);
  const groups = await rollupRange(tx, from, to);
  await setProgress(tx, 'rolled_through', isoDay(addDays(dayStart(now), -1)));
  return { from: isoDay(from), to: isoDay(to), groups };
}

/** Detaches the months that fall outside the kept window. The days they held were rolled up first (a month is detached only once its last day is over). */
export async function retainEvents(tx: PluginTx, now: Date): Promise<string[]> {
  const oldest = oldestKeptMonth(now, eventMonths());
  // make sure every day that is about to leave has been added up
  const first = await tx.query<{ day: string | null }>(
    `SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date::text AS day FROM app.analytics_events WHERE occurred_at < $1`,
    [`${oldest}T00:00:00.000Z`],
  );
  if (first.rows[0]?.day) await rollupRange(tx, new Date(`${first.rows[0].day}T00:00:00.000Z`), new Date(`${oldest}T00:00:00.000Z`));
  const res = await tx.query<{ names: string[] }>('SELECT app.analytics_detach_before($1::date) AS names', [oldest]);
  return res.rows[0]?.names ?? [];
}
