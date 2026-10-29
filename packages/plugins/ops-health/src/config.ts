// The limits the health watcher holds each check against, and the few other settings of the plugin. All of them come from the environment
// (the Helm chart passes `server.env` through), every one has a sensible default, and `0` switches a check off.

export interface Thresholds {
  /** A volume (the attachment store, the team repositories) counts as full above this share of its size, in percent. */
  volumePercent: number;
  /** The oldest event waiting in the outbox may be this old, in seconds. */
  outboxLagSeconds: number;
  /** The oldest job waiting for a worker may be this old, in seconds. */
  jobAgeSeconds: number;
  /** Every bot run slot may be taken, with runs waiting, for this long, in seconds. */
  runSlotsSeconds: number;
  /** An approval may wait for a decision this long, in seconds. */
  approvalAgeSeconds: number;
  /** A model budget may be this full, in percent. */
  budgetPercent: number;
  /** The database may have this share of its connections open, in percent. */
  dbConnectionsPercent: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = {
  volumePercent: 85,
  outboxLagSeconds: 60,
  jobAgeSeconds: 10 * 60,
  runSlotsSeconds: 10 * 60,
  approvalAgeSeconds: 24 * 60 * 60,
  budgetPercent: 90,
  dbConnectionsPercent: 90,
};

type Env = Readonly<Record<string, string | undefined>>;

/** A non-negative number from the environment; anything else (missing, empty, negative, not a number) is `fallback`. */
function numberFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * `MANYTHREADS_ALERT_VOLUME_PERCENT` (85), `_OUTBOX_LAG_SECONDS` (60), `_JOB_AGE_SECONDS` (600), `_RUN_SLOTS_SECONDS` (600),
 * `_APPROVAL_HOURS` (24), `_BUDGET_PERCENT` (90), `_DB_CONNECTIONS_PERCENT` (90).
 */
export function thresholdsFrom(env: Env): Thresholds {
  const d = DEFAULT_THRESHOLDS;
  return {
    volumePercent: Math.min(100, numberFrom(env['MANYTHREADS_ALERT_VOLUME_PERCENT'], d.volumePercent)),
    outboxLagSeconds: numberFrom(env['MANYTHREADS_ALERT_OUTBOX_LAG_SECONDS'], d.outboxLagSeconds),
    jobAgeSeconds: numberFrom(env['MANYTHREADS_ALERT_JOB_AGE_SECONDS'], d.jobAgeSeconds),
    runSlotsSeconds: numberFrom(env['MANYTHREADS_ALERT_RUN_SLOTS_SECONDS'], d.runSlotsSeconds),
    approvalAgeSeconds: numberFrom(env['MANYTHREADS_ALERT_APPROVAL_HOURS'], d.approvalAgeSeconds / 3600) * 3600,
    budgetPercent: numberFrom(env['MANYTHREADS_ALERT_BUDGET_PERCENT'], d.budgetPercent),
    dbConnectionsPercent: Math.min(100, numberFrom(env['MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT'], d.dbConnectionsPercent)),
  };
}

/** `MANYTHREADS_ALERTS=off` stops the watcher from writing events and sending mail; `/metrics` and the panel keep working. */
export const alertsEnabled = (env: Env): boolean => (env['MANYTHREADS_ALERTS'] ?? '').trim().toLowerCase() !== 'off';

/** `MANYTHREADS_ALERT_MAIL=0` keeps the events and the panel but sends no mail. */
export const alertMailEnabled = (env: Env): boolean => (env['MANYTHREADS_ALERT_MAIL'] ?? '').trim() !== '0';

/** How many rounds in a row (one a minute) a check must be back inside its limit before it counts as recovered (`MANYTHREADS_ALERT_RECOVER_ROUNDS`, default 3). */
export function recoverRoundsFrom(env: Env): number {
  const n = numberFrom(env['MANYTHREADS_ALERT_RECOVER_ROUNDS'], 3);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 3;
}

/**
 * Runs of different bots at once in one server process. The same rule as the Hermes runtime's own (`MANYTHREADS_RUN_CONCURRENCY`, default 6,
 * 1 to 64); this plugin cannot import that plugin, so the rule is repeated here and a test pins the two to the same default.
 */
export function runSlotsLimitFrom(env: Env): number {
  const n = Number((env['MANYTHREADS_RUN_CONCURRENCY'] ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 6;
}

/** The job queue the bot runs go through; every run in progress holds one `running` job of it (a slot). */
export const RUN_QUEUE = 'runtime-hermes.run';

export interface VolumeSpec {
  name: string;
  path: string;
}

/**
 * The volumes the server measures: the attachment store (`MANYTHREADS_STORAGE_DIR`, only with the local store), the team repositories
 * (`MANYTHREADS_REPO_DIR`) and any more named in `MANYTHREADS_OPS_VOLUMES` as `name=/path,name2=/path2`. A volume whose variable is
 * unset is not measured: a guess at a default path would report another disk.
 */
export function volumesFrom(env: Env): VolumeSpec[] {
  const out: VolumeSpec[] = [];
  const blobs = env['MANYTHREADS_STORAGE_DIR']?.trim();
  if (blobs && (env['MANYTHREADS_STORAGE'] ?? 'local').trim().toLowerCase() !== 's3') out.push({ name: 'blobs', path: blobs });
  const repos = env['MANYTHREADS_REPO_DIR']?.trim();
  if (repos) out.push({ name: 'repos', path: repos });
  for (const part of (env['MANYTHREADS_OPS_VOLUMES'] ?? '').split(',')) {
    const [name, ...rest] = part.split('=');
    const path = rest.join('=').trim();
    const label = (name ?? '').trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(label) && path.startsWith('/') && !out.some((v) => v.name === label)) out.push({ name: label, path });
  }
  return out;
}
