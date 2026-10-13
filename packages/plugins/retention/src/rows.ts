import {
  RETENTION_MEMORY_LOG_DAYS,
  RETENTION_RUN_LOG_DAYS,
  RetentionSettings,
  RetentionSweepSummary,
  type RetentionMode,
} from '@manythreads/shared';

// The one mapper of `app.retention_settings`: a row (or no row: the workspace never changed anything and had no sweep) becomes the shared
// `RetentionSettings`. Nothing else turns this table's columns into a value; the sweep reads its windows through `toRetentionWindows`.

export interface RetentionSettingsRow extends Record<string, unknown> {
  run_log_days: number;
  memory_log_days: number;
  last_sweep: unknown;
  last_dry_run: unknown;
  updated_at: Date | null;
}

export const RETENTION_SETTINGS_COLUMNS = 'run_log_days, memory_log_days, last_sweep, last_dry_run, updated_at';

export interface WorkspaceWindows {
  runLogDays: number;
  memoryLogDays: number;
}

const clamp = (value: number | undefined, bounds: { min: number; default: number; max: number }): number =>
  value === undefined ? bounds.default : Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));

/** The workspace's windows (the defaults when it never changed them), clamped to the bounds again so a hand-edited row cannot go below them. */
export const toRetentionWindows = (row: Pick<RetentionSettingsRow, 'run_log_days' | 'memory_log_days'> | undefined): WorkspaceWindows => ({
  runLogDays: clamp(row?.run_log_days, RETENTION_RUN_LOG_DAYS),
  memoryLogDays: clamp(row?.memory_log_days, RETENTION_MEMORY_LOG_DAYS),
});

const summaryOf = (value: unknown): RetentionSweepSummary | null => {
  if (value === null || value === undefined) return null;
  const parsed = RetentionSweepSummary.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export function toRetentionSettings(row: RetentionSettingsRow | undefined, mode: RetentionMode): RetentionSettings {
  const windows = toRetentionWindows(row);
  return RetentionSettings.parse({
    runLogDays: windows.runLogDays,
    memoryLogDays: windows.memoryLogDays,
    mode,
    lastSweep: summaryOf(row?.last_sweep),
    lastDryRun: summaryOf(row?.last_dry_run),
    updatedAt: row?.updated_at?.toISOString() ?? null,
  });
}
