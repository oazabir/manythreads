import type { RetentionMode } from '@manythreads/shared';

// The deployment's say over what retention does. Read per use from the environment (an operator, or a test, can move it without a build).

/**
 * `MANYTHREADS_RETENTION` = `dry-run` (the default: count and report, delete nothing) | `on` (delete) | `off` (do not even count). Anything else,
 * empty or misspelt, is `dry-run`, never `on`: only the word `on` deletes. A destructive job is opted into by name, like the blob garbage
 * collector (`MANYTHREADS_BLOB_GC`); a workspace admin chooses the window, the operator chooses whether anything is deleted at all.
 */
export function retentionMode(env: Record<string, string | undefined> = process.env): RetentionMode {
  const raw = (env['MANYTHREADS_RETENTION'] ?? '').trim().toLowerCase();
  return raw === 'on' ? 'on' : raw === 'off' ? 'off' : 'dry-run';
}

const posInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const v = Number(raw);
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : fallback;
};

/**
 * `MANYTHREADS_RETENTION_BATCH` (runs per job step, default 500, 1 to 5,000; the retain-log page is four times that): one step is one transaction,
 * so this bounds how long any lock is held. A sweep of a large backlog is many small jobs, each its own transaction.
 */
export function retentionBatch(env: Record<string, string | undefined> = process.env): { runs: number; logLines: number } {
  const runs = posInt(env['MANYTHREADS_RETENTION_BATCH'], 500, 1, 5_000);
  return { runs, logLines: Math.min(10_000, runs * 4) };
}
