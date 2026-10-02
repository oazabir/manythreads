import { randomBytes } from 'node:crypto';
import type { BlobStorage, JobHandler, PluginContext, PluginTx } from '@manythreads/sdk';

/** The job queue, and its schedule: every day at 03:17 UTC (an odd minute, so replicas of many deployments do not all wake on the hour). */
export const BLOB_GC_QUEUE = 'files.blob-gc';
export const BLOB_GC_CRON = '17 3 * * *';

export const DEFAULT_GRACE_HOURS = 24;
export const MIN_GRACE_HOURS = 1;
export const DEFAULT_ORPHAN_DAYS = 30;
/** Blobs looked at per run before the job hands the rest to a follow-up job (one transaction should not run for hours). */
export const DEFAULT_MAX_SCAN = 200_000;
const PAGE_SIZE = 1000;
const DELETE_CONCURRENCY = 8;
const BLOB_KEY = /^[0-9a-f]{32}$/;

export type BlobGcMode = 'on' | 'dry-run' | 'off';

export interface BlobGcConfig {
  mode: BlobGcMode;
  /** A blob must be at least this old before it can be deleted: an upload in flight has its bytes in the store before its row exists. */
  graceMs: number;
  /** Days a file of a deleted message is kept (hidden) before its row is deleted. */
  orphanDays: number;
  /** Refuse to delete when the database holds no `files` row at all but the store holds old blobs (the server is probably pointed at the wrong database). */
  allowEmpty: boolean;
  /** Take the store's instance marker as this database's when the database has none (a database restored from a backup, pointed at its own store). */
  adoptMarker: boolean;
}

const posInt = (raw: string | undefined, fallback: number, min: number): number => {
  const v = Number(raw);
  return Number.isSafeInteger(v) && v >= min ? v : fallback;
};

/**
 * `MANYTHREADS_BLOB_GC` = `dry-run` (default: count and log, delete nothing) | `on` (delete, only when asked for by name) | `off`; `MANYTHREADS_BLOB_GC_GRACE_HOURS` (default 24, at
 *  least 1); `MANYTHREADS_FILES_ORPHAN_DAYS` (default 30, at least 1); `MANYTHREADS_BLOB_GC_ALLOW_EMPTY=1` lifts the empty-database guard;
 * `MANYTHREADS_BLOB_GC_ADOPT_MARKER=1` adopts the store's instance marker. An unset, empty or unknown mode is `dry-run`, never `on`: only the word
 * `on` deletes (a deployment must opt in, and a typo must not delete anything).
 */
export function blobGcConfigFromEnv(env: Record<string, string | undefined> = process.env): BlobGcConfig {
  const raw = (env['MANYTHREADS_BLOB_GC'] ?? '').trim().toLowerCase();
  const mode: BlobGcMode = raw === 'on' ? 'on' : raw === 'off' ? 'off' : 'dry-run';
  return {
    mode,
    graceMs: posInt(env['MANYTHREADS_BLOB_GC_GRACE_HOURS'], DEFAULT_GRACE_HOURS, MIN_GRACE_HOURS) * 3_600_000,
    orphanDays: posInt(env['MANYTHREADS_FILES_ORPHAN_DAYS'], DEFAULT_ORPHAN_DAYS, 1),
    allowEmpty: env['MANYTHREADS_BLOB_GC_ALLOW_EMPTY'] === '1',
    adoptMarker: env['MANYTHREADS_BLOB_GC_ADOPT_MARKER'] === '1',
  };
}

export interface BlobGcOptions {
  dryRun: boolean;
  graceMs: number;
  orphanDays: number;
  allowEmpty?: boolean;
  adoptMarker?: boolean;
  now?: Date;
  /** Continue a sweep after this key (the previous run's `next`); a sweep that starts at the beginning also purges expired orphan rows. */
  cursor?: string;
  /** Stop after this many listed blobs and report `next`. */
  maxScan?: number;
  pageSize?: number;
}

/** What one run did: the line the job logs. */
export interface BlobGcReport {
  dryRun: boolean;
  /** Rows of deleted-message files older than the orphan period: deleted (or, in a dry run, that would be). */
  purgedFiles: number;
  /** Blobs listed in this run. */
  scanned: number;
  /** Listed blobs that a `files` row points at. */
  referenced: number;
  /** Unreferenced but younger than the grace period: left for a later run. */
  withinGrace: number;
  /** Unreferenced and old enough: deleted (or, in a dry run, that would be). */
  orphans: number;
  deleted: number;
  bytes: number;
  /** Deletions that failed (logged and retried by the next sweep). */
  failed: number;
  /** Set when the guard refused to delete (see `allowEmpty`). */
  refused: string | null;
  /** Where the next run continues; null when the sweep reached the end of the store. */
  next: string | null;
  ms: number;
}

/**
 * Ties this database to its store before anything is deleted (M4). Returns why not to delete, or null when the database's id and the store's marker
 * are the same. No marker anywhere: both are written now (the store's write is create-only, so two deployments starting at once cannot both win).
 */
export async function checkInstanceMarker(tx: PluginTx, storage: BlobStorage, adopt: boolean): Promise<string | null> {
  if (typeof storage.getInstanceMarker !== 'function' || typeof storage.putInstanceMarker !== 'function') {
    return `the storage provider "${storage.id}" cannot keep an instance marker, so the GC cannot tell this deployment's blobs from another's`;
  }
  const dbRow = async (): Promise<string | null> =>
    ((await tx.query<{ instance_id: string }>('SELECT instance_id FROM app.blob_gc_instance')).rows[0]?.instance_id ?? null);
  let dbId = await dbRow();
  let storeId = await storage.getInstanceMarker();
  if (dbId === null && storeId !== null) {
    if (!adopt) {
      return 'the store belongs to another database (its instance marker is not this database\'s): a bucket or prefix must serve one database only; to adopt it for a database restored from a backup, set MANYTHREADS_BLOB_GC_ADOPT_MARKER=1';
    }
    if (!/^[0-9a-f]{32}$/.test(storeId)) return 'the store\'s instance marker is malformed';
    await tx.query('INSERT INTO app.blob_gc_instance (instance_id) VALUES ($1) ON CONFLICT (singleton) DO NOTHING', [storeId]);
    dbId = await dbRow();
  }
  if (dbId === null) {
    await tx.query('INSERT INTO app.blob_gc_instance (instance_id) VALUES ($1) ON CONFLICT (singleton) DO NOTHING', [randomBytes(16).toString('hex')]);
    dbId = await dbRow();
  }
  if (storeId === null && dbId !== null) {
    if (!(await storage.putInstanceMarker(dbId))) storeId = await storage.getInstanceMarker();
    else storeId = dbId;
  }
  if (dbId === null || storeId === null || dbId !== storeId) {
    return 'the store\'s instance marker differs from this database\'s: the bucket, prefix or directory is shared with another deployment (or the database was restored from another one); nothing was deleted';
  }
  return null;
}

/**
 * One blob GC run, in the caller's (system) transaction:
 * 1. (a sweep's first run) deletes `files` rows hidden for `orphanDays` because their messages were deleted;
 * 2. walks the store's listing in pages, and deletes every blob that no `files` row references and that is older than the grace period.
 * Blobs are never derived from content, so "no row has this key" is the whole test. `dryRun` does everything except the deletions.
 */
export async function runBlobGc(tx: PluginTx, storage: BlobStorage, options: BlobGcOptions): Promise<BlobGcReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const pageSize = Math.min(Math.max(options.pageSize ?? PAGE_SIZE, 1), PAGE_SIZE);
  const maxScan = options.maxScan ?? DEFAULT_MAX_SCAN;
  const report: BlobGcReport = {
    dryRun: options.dryRun,
    purgedFiles: 0,
    scanned: 0,
    referenced: 0,
    withinGrace: 0,
    orphans: 0,
    deleted: 0,
    bytes: 0,
    failed: 0,
    refused: null,
    next: null,
    ms: 0,
  };

  if (options.cursor === undefined) {
    const cutoff = new Date(now.getTime() - options.orphanDays * 86_400_000);
    const res = options.dryRun
      ? await tx.query('SELECT count(*)::int AS n FROM app.files WHERE orphaned_at < $1', [cutoff])
      : await tx.query('WITH gone AS (DELETE FROM app.files WHERE orphaned_at < $1 RETURNING 1) SELECT count(*)::int AS n FROM gone', [cutoff]);
    report.purgedFiles = Number((res.rows[0] as { n: number }).n);
  }

  const graceCutoff = now.getTime() - options.graceMs;
  let emptyDatabase: boolean | undefined;
  let markerRefusal: string | null | undefined;
  let after = options.cursor;
  for (;;) {
    const page = await storage.list({ ...(after !== undefined ? { after } : {}), limit: pageSize });
    const items = page.items.filter((i) => BLOB_KEY.test(i.blobKey));
    report.scanned += items.length;
    if (items.length > 0) {
      const known = await tx.query<{ blob_key: string }>('SELECT DISTINCT blob_key FROM app.files WHERE blob_key = ANY ($1::text[])', [items.map((i) => i.blobKey)]);
      const referenced = new Set(known.rows.map((r) => r.blob_key));
      report.referenced += referenced.size;
      const doomed = [];
      for (const item of items) {
        if (referenced.has(item.blobKey)) continue;
        if (item.modifiedAt.getTime() > graceCutoff) report.withinGrace += 1;
        else doomed.push(item);
      }
      report.orphans += doomed.length;
      if (doomed.length > 0 && !options.dryRun) {
        if (emptyDatabase === undefined && !options.allowEmpty) {
          emptyDatabase = !((await tx.query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM app.files) AS found')).rows[0]?.found ?? false);
        }
        if (emptyDatabase === true) {
          report.refused = 'the database has no files rows but the store holds unreferenced blobs: wrong database? (MANYTHREADS_BLOB_GC_ALLOW_EMPTY=1 lifts this)';
        } else if ((markerRefusal ??= await checkInstanceMarker(tx, storage, options.adoptMarker === true)) !== null) {
          report.refused = markerRefusal;
        } else {
          for (let i = 0; i < doomed.length; i += DELETE_CONCURRENCY) {
            await Promise.all(
              doomed.slice(i, i + DELETE_CONCURRENCY).map(async (item) => {
                try {
                  if (await storage.delete(item.blobKey)) {
                    report.deleted += 1;
                    report.bytes += item.size;
                  }
                } catch {
                  report.failed += 1;
                }
              }),
            );
          }
        }
      } else if (options.dryRun) {
        for (const item of doomed) report.bytes += item.size;
      }
    }
    if (page.next === null) break;
    after = page.next;
    if (report.scanned >= maxScan) {
      report.next = page.next;
      break;
    }
  }
  report.ms = Date.now() - started;
  return report;
}

/** The `files.blob-gc` handler: reads the configuration from the environment at each run, logs one line of metrics, hands a long sweep to a follow-up job. */
export function blobGcHandler(ctx: PluginContext): JobHandler {
  return async (payload, tx, job) => {
    const config = blobGcConfigFromEnv();
    if (config.mode === 'off') {
      job.log.info(`${BLOB_GC_QUEUE} skipped: MANYTHREADS_BLOB_GC=off`);
      return;
    }
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage || typeof storage.list !== 'function') {
      job.log.warn(`${BLOB_GC_QUEUE} skipped: no storage provider that can list its blobs is registered`);
      return;
    }
    // The payload is whatever was enqueued (this plugin only): take a well-formed cursor and nothing else from it.
    const cursor = typeof payload['cursor'] === 'string' && BLOB_KEY.test(payload['cursor']) ? payload['cursor'] : undefined;
    const dryRun = config.mode === 'dry-run' || payload['dryRun'] === true;
    const report = await runBlobGc(tx, storage, { dryRun, graceMs: config.graceMs, orphanDays: config.orphanDays, allowEmpty: config.allowEmpty, adoptMarker: config.adoptMarker, ...(cursor !== undefined ? { cursor } : {}) });
    const line = `${BLOB_GC_QUEUE} ${JSON.stringify({ provider: storage.id, graceHours: config.graceMs / 3_600_000, ...report })}`;
    if (report.refused !== null || report.failed > 0) job.log.warn(line);
    else job.log.info(line);
    if (report.next !== null) await ctx.jobs.enqueue(tx, BLOB_GC_QUEUE, { cursor: report.next, dryRun });
  };
}
