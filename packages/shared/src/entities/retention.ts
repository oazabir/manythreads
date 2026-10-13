import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';

// Retention (PLAN P5-14; SPEC §15): how long a workspace keeps the logs a bot's runs leave behind, and what the last sweep did. The audit log
// (`events`) and everything an auditor reads from it are NOT in this list and no setting here reaches them: retention deletes run logs and the
// memory feed's own bookkeeping, nothing that says who did what.

/** Days of run logs (`bot_runs`, `run_source_log`, and what hangs off a run) a workspace keeps. Below the minimum would out-run the platform's own windows (approvals expire at 7 days, a run's verdict looks back a day). */
export const RETENTION_RUN_LOG_DAYS = { min: 30, default: 90, max: 3650 } as const;
/** Days of superseded `memory_retain_log` lines and attempt notes. The newest state of every source and every `withheld` line are kept whatever this says. */
export const RETENTION_MEMORY_LOG_DAYS = { min: 90, default: 365, max: 3650 } as const;

/**
 * What the deployment lets retention do (`MANYTHREADS_RETENTION`): `dry-run` counts and reports and deletes nothing (the default, and what any
 * unknown value means: only the word `on` deletes), `on` deletes, `off` does not even count.
 */
export const RetentionMode = z.enum(['on', 'dry-run', 'off']);
export type RetentionMode = z.infer<typeof RetentionMode>;

/** What one sweep removed (or, in a dry run, would have). */
export const RetentionCounts = z.object({
  /** `bot_runs` rows. */
  runs: z.number().int().nonnegative(),
  /** Eligible runs that could not be deleted (the database refused one; the sweep went on and left it). */
  runsSkipped: z.number().int().nonnegative(),
  /** `run_source_log` lines that went with them. */
  runSourceLines: z.number().int().nonnegative(),
  /** `mcp_run_tokens` rows (the runs' endpoint credentials) that went with them. */
  runTokens: z.number().int().nonnegative(),
  /** Runs that left a memo for the memory feed before they went (see docs/plugins/retention.md "The feed's verdict"). */
  runMemos: z.number().int().nonnegative(),
  /** Superseded `memory_retain_log` lines and attempt notes. */
  memoryLogLines: z.number().int().nonnegative(),
  /** Memos of bots that no longer exist (their verdicts are `bot_removed` now). */
  memosRemoved: z.number().int().nonnegative(),
});
export type RetentionCounts = z.infer<typeof RetentionCounts>;

export const RetentionSweepSummary = z.object({
  sweepId: z.uuid(),
  dryRun: z.boolean(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  /** Run logs ended before this are pruned. */
  runLogCutoff: IsoDateTime,
  memoryLogCutoff: IsoDateTime,
  counts: RetentionCounts,
});
export type RetentionSweepSummary = z.infer<typeof RetentionSweepSummary>;

export const RetentionSettings = z.object({
  runLogDays: z.number().int().min(RETENTION_RUN_LOG_DAYS.min).max(RETENTION_RUN_LOG_DAYS.max),
  memoryLogDays: z.number().int().min(RETENTION_MEMORY_LOG_DAYS.min).max(RETENTION_MEMORY_LOG_DAYS.max),
  /** What the deployment allows; read-only here (an environment variable). */
  mode: RetentionMode,
  /** The newest sweep that deleted (mode `on`); null before the first. A dry run never replaces it. */
  lastSweep: RetentionSweepSummary.nullable(),
  /** The newest dry run (the default mode, or a preview); null before the first. */
  lastDryRun: RetentionSweepSummary.nullable(),
  /** When an admin last changed the windows; null for a workspace that never did. */
  updatedAt: IsoDateTime.nullable(),
});
export type RetentionSettings = z.infer<typeof RetentionSettings>;
