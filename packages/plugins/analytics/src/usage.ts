import type { PluginTx } from '@manythreads/sdk';
import {
  AnswerQuality,
  UsageAliasRow,
  UsageBotRow,
  UsageBudget,
  UsageDay,
  UsageRange,
  UsageSignIns,
  UsageTeamRow,
  UsageTotals,
} from '@manythreads/shared';
import { labelSql } from './sweep.ts';

// The numbers behind the usage pages. A read takes whole UTC days: the days before yesterday come from `analytics_daily` (about thirty rows per series for
// a month), and yesterday and today from the events themselves (one or two partitions), so the page is live and never waits for the next rollup. The
// reader's own row level security decides what is there to add up; `money` only decides whether the page may SAY the money figures.

const DAY_MS = 86_400_000;
const dayStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface UsageSubject {
  teamId?: string;
  botId?: string;
}

/** One cell of the read: a metric, its label, and its total and count for one day of one team and bot. */
export interface SeriesRow {
  day: string;
  team_id: string | null;
  bot_id: string | null;
  metric: string;
  dim: string;
  total: number;
  n: number;
}

export function usageRange(now: Date, days: number): UsageRange {
  const until = dayStart(now);
  return UsageRange.parse({ days, since: isoDay(new Date(until.getTime() - (days - 1) * DAY_MS)), until: isoDay(until) });
}

/** Reads the series of a workspace (narrowed to a team or a bot) over a range. */
export async function readSeries(tx: PluginTx, workspaceId: string, range: UsageRange, now: Date, subject: UsageSubject = {}): Promise<SeriesRow[]> {
  const since = new Date(`${range.since}T00:00:00.000Z`);
  const tomorrow = new Date(dayStart(now).getTime() + DAY_MS);
  // from this instant on the events are read; before it, the daily rows
  const live = new Date(Math.max(since.getTime(), dayStart(now).getTime() - DAY_MS));
  const res = await tx.query<{ day: string; team_id: string | null; bot_id: string | null; metric: string; dim: string; total: string; n: string }>(
    `SELECT d.day::text AS day, d.team_id, d.bot_id, d.metric, d.dim, d.total::text AS total, d.n::text AS n
       FROM app.analytics_daily d
      WHERE d.workspace_id = $1 AND d.day >= $2::date AND d.day < $3::date
        AND ($4::uuid IS NULL OR d.team_id = $4) AND ($5::uuid IS NULL OR d.bot_id = $5)
     UNION ALL
     SELECT (e.occurred_at AT TIME ZONE 'UTC')::date::text, e.team_id, e.bot_id, e.metric, ${labelSql('e')}, sum(e.value)::text, count(*)::text
       FROM app.analytics_events e
      WHERE e.workspace_id = $1 AND e.occurred_at >= $6 AND e.occurred_at < $7
        AND ($4::uuid IS NULL OR e.team_id = $4) AND ($5::uuid IS NULL OR e.bot_id = $5)
      GROUP BY 1, 2, 3, 4, 5`,
    [workspaceId, range.since, isoDay(live), subject.teamId ?? null, subject.botId ?? null, live.toISOString(), tomorrow.toISOString()],
  );
  return res.rows.map((r) => ({ ...r, total: Number(r.total), n: Number(r.n) }));
}

const sum = (rows: readonly SeriesRow[], metric: string, pick: 'total' | 'n', dim?: string): number =>
  rows.reduce((acc, r) => (r.metric === metric && (dim === undefined || r.dim === dim) ? acc + r[pick] : acc), 0);

const usd = (micro: number): number => Math.round(micro) / 1_000_000;

export function totalsOf(rows: readonly SeriesRow[], money: boolean): UsageTotals {
  const decided = sum(rows, 'approval.decided', 'n');
  const waited = sum(rows, 'approval.wait_seconds', 'n');
  const scoped = sum(rows, 'answer.scoped', 'n');
  const full = sum(rows, 'answer.full', 'n');
  return UsageTotals.parse({
    runs: sum(rows, 'run.count', 'n'),
    failedRuns: sum(rows, 'run.count', 'n', 'failed'),
    stoppedRuns: sum(rows, 'run.count', 'n', 'stopped'),
    toolCalls: sum(rows, 'tool.call', 'n'),
    toolsRefused: sum(rows, 'tool.call', 'n', 'denied'),
    toolsHeldForApproval: sum(rows, 'tool.call', 'n', 'needs_approval'),
    approvalsAsked: sum(rows, 'approval.requested', 'n'),
    approvalsApproved: sum(rows, 'approval.decided', 'n', 'approved'),
    approvalsDenied: decided - sum(rows, 'approval.decided', 'n', 'approved'),
    approvalWaitSeconds: waited > 0 ? sum(rows, 'approval.wait_seconds', 'total') / waited : null,
    answers: scoped + full,
    answersScoped: scoped,
    answersFull: full,
    knowledgeHits: sum(rows, 'knowledge.hit', 'n'),
    llmCalls: money ? sum(rows, 'llm.cost_micro', 'n') : null,
    tokens: money ? Math.round(sum(rows, 'llm.tokens', 'total')) : null,
    spendUsd: money ? usd(sum(rows, 'llm.cost_micro', 'total')) : null,
  });
}

/** Every day of the range, oldest first, with a zero for a day that had nothing (a chart needs the gaps). */
export function dailyOf(rows: readonly SeriesRow[], range: UsageRange, money: boolean): UsageDay[] {
  const byDay = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.day);
    if (list) list.push(r);
    else byDay.set(r.day, [r]);
  }
  const out: UsageDay[] = [];
  const first = new Date(`${range.since}T00:00:00.000Z`).getTime();
  for (let i = 0; i < range.days; i += 1) {
    const day = isoDay(new Date(first + i * DAY_MS));
    const cells = byDay.get(day) ?? [];
    out.push(
      UsageDay.parse({
        day,
        runs: sum(cells, 'run.count', 'n'),
        failedRuns: sum(cells, 'run.count', 'n', 'failed'),
        toolCalls: sum(cells, 'tool.call', 'n'),
        answers: sum(cells, 'answer.scoped', 'n') + sum(cells, 'answer.full', 'n'),
        spendUsd: money ? usd(sum(cells, 'llm.cost_micro', 'total')) : null,
      }),
    );
  }
  return out;
}

export function qualityOf(rows: readonly SeriesRow[]): AnswerQuality {
  const scoped = sum(rows, 'answer.scoped', 'n');
  const full = sum(rows, 'answer.full', 'n');
  const answers = scoped + full;
  const citations = Math.round(sum(rows, 'answer.citations', 'total'));
  const dropped = Math.round(sum(rows, 'answer.dropped', 'total'));
  return AnswerQuality.parse({
    answers,
    scoped,
    full,
    citations,
    dropped,
    sourcesReached: Math.round(sum(rows, 'answer.reached', 'total')),
    knowledgeHits: sum(rows, 'knowledge.hit', 'n'),
    citationsPerAnswer: answers > 0 ? citations / answers : null,
    droppedShare: citations + dropped > 0 ? dropped / (citations + dropped) : null,
  });
}

export function aliasesOf(rows: readonly SeriesRow[], money: boolean): UsageAliasRow[] {
  if (!money) return [];
  const byAlias = new Map<string, { micro: number; calls: number }>();
  for (const r of rows) {
    if (r.metric !== 'llm.cost_micro') continue;
    const key = r.dim === '' ? 'other' : r.dim;
    const cur = byAlias.get(key) ?? { micro: 0, calls: 0 };
    cur.micro += r.total;
    cur.calls += r.n;
    byAlias.set(key, cur);
  }
  return [...byAlias.entries()]
    .map(([alias, v]) => UsageAliasRow.parse({ alias, spendUsd: usd(v.micro), calls: v.calls }))
    .sort((a, b) => b.spendUsd - a.spendUsd || a.alias.localeCompare(b.alias));
}

export function signInsOf(rows: readonly SeriesRow[]): UsageSignIns {
  const methods = new Map<string, number>();
  for (const r of rows) if (r.metric === 'signin.ok') methods.set(r.dim === '' ? 'other' : r.dim, (methods.get(r.dim === '' ? 'other' : r.dim) ?? 0) + r.n);
  return UsageSignIns.parse({
    ok: sum(rows, 'signin.ok', 'n'),
    failed: sum(rows, 'signin.failed', 'n'),
    byMethod: [...methods.entries()].map(([method, count]) => ({ method, count })).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
  });
}

interface BotName {
  slug: string;
  name: string;
  teamId: string;
}
interface TeamName {
  slug: string;
  name: string;
}

export async function namesOf(tx: PluginTx, botIds: readonly string[], teamIds: readonly string[]): Promise<{ bots: Map<string, BotName>; teams: Map<string, TeamName> }> {
  const bots = new Map<string, BotName>();
  const teams = new Map<string, TeamName>();
  if (botIds.length > 0) {
    const res = await tx.query<{ id: string; slug: string; name: string; team_id: string }>('SELECT id, slug, name, team_id FROM app.bots WHERE id = ANY($1::uuid[])', [botIds]);
    for (const r of res.rows) bots.set(r.id, { slug: r.slug, name: r.name, teamId: r.team_id });
  }
  const wanted = [...new Set([...teamIds, ...[...bots.values()].map((b) => b.teamId)])];
  if (wanted.length > 0) {
    const res = await tx.query<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM app.teams WHERE id = ANY($1::uuid[])', [wanted]);
    for (const r of res.rows) teams.set(r.id, { slug: r.slug, name: r.name });
  }
  return { bots, teams };
}

const rate = (failed: number, runs: number): number | null => (runs > 0 ? Math.min(1, failed / runs) : null);

/** One line per bot that did anything in the range, the busiest first. */
export function botRowsOf(rows: readonly SeriesRow[], names: { bots: Map<string, BotName>; teams: Map<string, TeamName> }, money: boolean): UsageBotRow[] {
  const ids = [...new Set(rows.map((r) => r.bot_id).filter((id): id is string => id !== null))];
  return ids
    .map((botId) => {
      const mine = rows.filter((r) => r.bot_id === botId);
      const bot = names.bots.get(botId);
      const teamId = bot?.teamId ?? mine.find((r) => r.team_id !== null)?.team_id ?? null;
      const team = teamId === null ? undefined : names.teams.get(teamId);
      const runs = sum(mine, 'run.count', 'n');
      const failedRuns = sum(mine, 'run.count', 'n', 'failed');
      return UsageBotRow.parse({
        botId,
        slug: bot?.slug ?? null,
        name: bot?.name ?? null,
        teamId,
        teamSlug: team?.slug ?? null,
        teamName: team?.name ?? null,
        runs,
        failedRuns,
        toolCalls: sum(mine, 'tool.call', 'n'),
        answers: sum(mine, 'answer.scoped', 'n') + sum(mine, 'answer.full', 'n'),
        spendUsd: money ? usd(sum(mine, 'llm.cost_micro', 'total')) : null,
        errorRate: rate(failedRuns, runs),
      });
    })
    .sort((a, b) => b.runs - a.runs || b.toolCalls - a.toolCalls || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** One line per team (and one for work that belongs to no team), the busiest first. */
export function teamRowsOf(rows: readonly SeriesRow[], names: { teams: Map<string, TeamName> }, money: boolean): UsageTeamRow[] {
  const ids = [...new Set(rows.map((r) => r.team_id))];
  return ids
    .map((teamId) => {
      const mine = rows.filter((r) => r.team_id === teamId);
      const team = teamId === null ? undefined : names.teams.get(teamId);
      return UsageTeamRow.parse({
        teamId,
        slug: team?.slug ?? null,
        name: team?.name ?? null,
        runs: sum(mine, 'run.count', 'n'),
        failedRuns: sum(mine, 'run.count', 'n', 'failed'),
        toolCalls: sum(mine, 'tool.call', 'n'),
        answers: sum(mine, 'answer.scoped', 'n') + sum(mine, 'answer.full', 'n'),
        spendUsd: money ? usd(sum(mine, 'llm.cost_micro', 'total')) : null,
      });
    })
    // a team with only a sign-in or a budget line is not a team that worked
    .filter((t) => t.runs + t.toolCalls + t.answers > 0 || (t.spendUsd ?? 0) > 0)
    .sort((a, b) => b.runs - a.runs || (b.spendUsd ?? 0) - (a.spendUsd ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** The workspace's, a team's or a bot's budget with its window's spend (read from the ledger the gateway enforces against, so the bar and the refusal agree). Admins only. */
export async function budgetOf(tx: PluginTx, workspaceId: string, scope: 'workspace' | 'team' | 'bot', targetId: string | null, now: Date): Promise<UsageBudget | null> {
  const column = scope === 'team' ? 'team_id' : scope === 'bot' ? 'bot_id' : null;
  const limit = await tx.query<{ budget_window: 'day' | 'month'; limit_usd: string }>(
    `SELECT budget_window, limit_usd::text AS limit_usd FROM app.llm_limits
      WHERE workspace_id = $1 AND scope = $2 AND limit_usd IS NOT NULL ${column === null ? '' : `AND ${column} = $3`}`,
    column === null ? [workspaceId, scope] : [workspaceId, scope, targetId],
  );
  const row = limit.rows[0];
  if (!row) return null;
  const since = row.budget_window === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : dayStart(now);
  const spent = await tx.query<{ spent: string }>(
    `SELECT coalesce(sum(cost_usd), 0)::text AS spent FROM app.llm_spend WHERE workspace_id = $1 AND occurred_at >= $2 ${column === null ? '' : `AND ${column} = $3`}`,
    column === null ? [workspaceId, since.toISOString()] : [workspaceId, since.toISOString(), targetId],
  );
  return UsageBudget.parse({ scope, window: row.budget_window, limitUsd: Number(row.limit_usd), spentUsd: Number(spent.rows[0]?.spent ?? 0), since: since.toISOString() });
}
