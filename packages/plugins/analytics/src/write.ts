import { createHash } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';
import { ANALYTICS_METRICS, type AnalyticsMetric } from '@manythreads/shared';
import { oldestKeptMonth } from './config.ts';

// The one writer of `analytics_events` for rows made in code (the live subscribers). The sweeps write with SQL of their own (`sweep.ts`) but use the same
// month check. Nothing here ever receives text: a label is a short fixed word, and a longer or odd one is cut or dropped rather than stored.

export type DimValue = string | number | boolean;

export interface EventRow {
  /** The id the row is stored under. Made from the source (`derivedId`), so counting the same thing twice writes it once. */
  id: string;
  occurredAt: Date;
  workspaceId: string;
  teamId: string | null;
  /** Only for rows with no team (sign-ins); the table refuses a row with both. */
  actorId: string | null;
  botId: string | null;
  metric: AnalyticsMetric;
  value: number;
  dims: Record<string, DimValue>;
}

/** A stable uuid for "this metric of this source": the same inputs always give the same id, and different ones differ. */
export function derivedId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const LABEL_MAX = 80;

/** Keeps only short, plain labels: a key of letters, and a value that is a short string, a finite number or a boolean. */
export function cleanDims(dims: Record<string, DimValue | null | undefined>): Record<string, DimValue> {
  const out: Record<string, DimValue> = {};
  for (const [k, v] of Object.entries(dims)) {
    if (!KEY.test(k) || v === null || v === undefined) continue;
    if (typeof v === 'string') out[k] = v.slice(0, LABEL_MAX);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** The first day of every month (UTC) between two instants, both included. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (cursor.getTime() <= end && out.length < 240) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** Makes sure each month has its partition; answers the months a row can be written for (a month outside the kept window or too far ahead is refused). */
export async function ensureMonths(tx: PluginTx, months: readonly string[], now: Date): Promise<Set<string>> {
  const ok = new Set<string>();
  if (months.length === 0) return ok;
  const oldest = oldestKeptMonth(now);
  const res = await tx.query<{ month: string; ok: boolean }>(
    `SELECT m::text AS month, app.analytics_ensure_month(m, $2::date) AS ok FROM unnest($1::date[]) AS m`,
    [[...new Set(months)], oldest],
  );
  for (const r of res.rows) if (r.ok) ok.add(r.month);
  return ok;
}

const monthOf = (d: Date): string => `${d.toISOString().slice(0, 7)}-01`;

/** Writes the rows (those whose month can be written), skipping any whose id is already stored. Answers how many were new. */
export async function appendRows(tx: PluginTx, rows: readonly EventRow[], now: Date = new Date()): Promise<number> {
  if (rows.length === 0) return 0;
  const writable = await ensureMonths(tx, rows.map((r) => monthOf(r.occurredAt)), now);
  const kept = rows.filter((r) => writable.has(monthOf(r.occurredAt)) && Number.isFinite(r.value) && ANALYTICS_METRICS.includes(r.metric));
  if (kept.length === 0) return 0;
  const payload = kept.map((r) => ({
    id: r.id,
    at: r.occurredAt.toISOString(),
    ws: r.workspaceId,
    team: r.teamId,
    actor: r.teamId === null ? r.actorId : null,
    bot: r.botId,
    metric: r.metric,
    value: r.value,
    dims: cleanDims(r.dims),
  }));
  const res = await tx.query(
    `INSERT INTO app.analytics_events (id, occurred_at, workspace_id, team_id, actor_id, bot_id, metric, value, dims)
     SELECT x.id, x.at, x.ws, x.team, x.actor, x.bot, x.metric, x.value, x.dims
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, at timestamptz, ws uuid, team uuid, actor uuid, bot uuid, metric text, value double precision, dims jsonb)
     ON CONFLICT (id, occurred_at) DO NOTHING
     RETURNING id`,
    [JSON.stringify(payload)],
  );
  return res.rows.length;
}
