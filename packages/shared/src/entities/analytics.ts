import { z } from 'zod';
import { BotId, TeamId } from '../ids.ts';
import { IsoDateTime } from '../common/time.ts';
import { Team } from './team.ts';

const TeamSlug = Team.shape.slug;

// Usage (PLAN P8-11, Appendix A.7): counts, ids and amounts of what the workspace's bots did, kept in a monthly-partitioned table and rolled up per day.
// Nothing here ever holds what was said, read or written: a metric is a number, its labels are fixed words (a model alias, an outcome), never text.

/**
 * Every metric the `analytics` plugin writes. A name is `<area>.<what>`; the value's unit is in `ANALYTICS_METRIC_UNITS`. Add new ones at the END.
 *  - `llm.cost_micro`: one model call's cost in millionths of a US dollar (label `alias`); `llm.tokens`: its tokens in and out.
 *  - `run.count`: one bot run that ended (label `status`: done, failed or stopped).
 *  - `tool.call`: one tool call a run made (label `outcome`: allowed, needs_approval or denied).
 *  - `approval.requested`, `approval.decided` (label `decision`), `approval.wait_seconds`: how long a decided approval waited.
 *  - `answer.scoped` / `answer.full`: an Answer given for the person who asked (scoped, it may rest on that person's own sources) or for the team (full);
 *    `answer.citations`, `answer.dropped`, `answer.reached`: its citations kept, citations the platform removed, and sources the run reached.
 *  - `knowledge.hit`: one knowledge document a run reached.
 *  - `signin.ok` (label `method`) and `signin.failed` (label `reason`).
 */
export const ANALYTICS_METRICS = [
  'llm.cost_micro',
  'llm.tokens',
  'run.count',
  'tool.call',
  'approval.requested',
  'approval.decided',
  'approval.wait_seconds',
  'answer.scoped',
  'answer.full',
  'answer.citations',
  'answer.dropped',
  'answer.reached',
  'knowledge.hit',
  'signin.ok',
  'signin.failed',
] as const;
export const AnalyticsMetric = z.enum(ANALYTICS_METRICS);
export type AnalyticsMetric = z.infer<typeof AnalyticsMetric>;

/**
 * The one label of an event the daily rollup keeps apart (so "spend by model alias" and "runs by outcome" can be read from the rolled-up rows).
 * A metric with no entry rolls up to one row per day. The other labels stay on the event until its month is detached.
 */
export const ANALYTICS_METRIC_LABEL: Partial<Record<AnalyticsMetric, string>> = {
  'llm.cost_micro': 'alias',
  'run.count': 'status',
  'tool.call': 'outcome',
  'approval.requested': 'source',
  'approval.decided': 'decision',
  'signin.ok': 'method',
  'signin.failed': 'reason',
};

/** Metrics that are money or model use. Only workspace owners and admins read them (the spend ledger has always been admin-only). */
export const ANALYTICS_ADMIN_ONLY_PREFIX = 'llm.';

/** How many days a usage page may ask for. */
export const ANALYTICS_USAGE_DAYS = { min: 1, default: 30, max: 366 } as const;

/** The most days of detailed events kept (older months are detached from the table; the daily rows stay). */
export const ANALYTICS_EVENT_MONTHS = { min: 2, default: 14, max: 120 } as const;

const Count = z.number().int().nonnegative();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What happened over the page's range. `null` money fields mean the reader may not see money (only workspace owners and admins do). */
export const UsageTotals = z.object({
  runs: Count,
  failedRuns: Count,
  stoppedRuns: Count,
  toolCalls: Count,
  /** Tool calls the platform refused. */
  toolsRefused: Count,
  /** Tool calls that waited for a person to approve. */
  toolsHeldForApproval: Count,
  approvalsAsked: Count,
  approvalsApproved: Count,
  approvalsDenied: Count,
  /** The average time a decided approval waited, in seconds; null when none was decided. */
  approvalWaitSeconds: z.number().nonnegative().nullable(),
  answers: Count,
  answersScoped: Count,
  answersFull: Count,
  knowledgeHits: Count,
  llmCalls: Count.nullable(),
  tokens: Count.nullable(),
  spendUsd: z.number().nonnegative().nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** One UTC day of the chart. */
export const UsageDay = z.object({
  day: Day,
  runs: Count,
  failedRuns: Count,
  toolCalls: Count,
  answers: Count,
  spendUsd: z.number().nonnegative().nullable(),
});
export type UsageDay = z.infer<typeof UsageDay>;

/** A bot's line in a table. A bot that has since been removed has no slug or name. */
export const UsageBotRow = z.object({
  botId: BotId,
  slug: z.string().nullable(),
  name: z.string().nullable(),
  teamId: TeamId.nullable(),
  teamSlug: TeamSlug.nullable(),
  teamName: z.string().nullable(),
  runs: Count,
  failedRuns: Count,
  toolCalls: Count,
  answers: Count,
  spendUsd: z.number().nonnegative().nullable(),
  /** Failed runs as a share of runs, 0 to 1; null when the bot had no run. */
  errorRate: z.number().min(0).max(1).nullable(),
});
export type UsageBotRow = z.infer<typeof UsageBotRow>;

/** A team's line in the workspace table. Work that belongs to no team (the workspace's own helpers) has no team. */
export const UsageTeamRow = z.object({
  teamId: TeamId.nullable(),
  slug: TeamSlug.nullable(),
  name: z.string().nullable(),
  runs: Count,
  failedRuns: Count,
  toolCalls: Count,
  answers: Count,
  spendUsd: z.number().nonnegative().nullable(),
});
export type UsageTeamRow = z.infer<typeof UsageTeamRow>;

export const UsageAliasRow = z.object({ alias: z.string(), spendUsd: z.number().nonnegative(), calls: Count });
export type UsageAliasRow = z.infer<typeof UsageAliasRow>;

/** How good Brain's answers were over the range: whom they were for, how well they were backed, and how often the platform had to remove a citation. */
export const AnswerQuality = z.object({
  answers: Count,
  scoped: Count,
  full: Count,
  citations: Count,
  /** Citations the platform removed because the reader could not open the source or the run never reached it. */
  dropped: Count,
  sourcesReached: Count,
  knowledgeHits: Count,
  /** Citations kept per answer; null when nothing was answered. */
  citationsPerAnswer: z.number().nonnegative().nullable(),
  /** Removed citations as a share of all citations given (kept and removed), 0 to 1; null when there were none. */
  droppedShare: z.number().min(0).max(1).nullable(),
});
export type AnswerQuality = z.infer<typeof AnswerQuality>;

/** A budget (set under Workspace, LLM) and how much of its window is used. Admins only. */
export const UsageBudget = z.object({
  scope: z.enum(['workspace', 'team', 'bot']),
  window: z.enum(['day', 'month']),
  limitUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  /** Start of the window the spend counts from. */
  since: IsoDateTime,
});
export type UsageBudget = z.infer<typeof UsageBudget>;

export const UsageSignIns = z.object({
  ok: Count,
  failed: Count,
  byMethod: z.array(z.object({ method: z.string(), count: Count })),
});
export type UsageSignIns = z.infer<typeof UsageSignIns>;

/** The range every usage page shows: whole UTC days, `since` included and `until` included. */
export const UsageRange = z.object({ days: z.number().int().positive(), since: Day, until: Day });
export type UsageRange = z.infer<typeof UsageRange>;
