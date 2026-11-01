import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { BlobStorage, JobInfo, MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import { type ImportReport, type ImportSource } from '@manythreads/shared';
import { z } from 'zod';
import { ArchiveError, openArchive } from './archive.ts';
import { runImport, type Transaction } from './engine.ts';
import { DEFAULT_LIMITS, type ArchiveLimits } from './limits.ts';
import type { ArchiveReader } from './model.ts';
import { ZipRefused } from './zip.ts';

// The background half of the import. `import.analyse` reads the stored archive and writes the dry-run report; `import.run` writes the import. Both are
// `detached`: they hold no database transaction while they read the archive, and open a short one for each step through `job.transaction`. One of each
// runs per workspace at a time. A run that is cut off (a crash, a deploy) starts again from the top on the next attempt and skips everything it already
// wrote, because every channel, person and message is recorded by the archive's own id (`app.import_map`, `app.import_people`).

export const ANALYSE_QUEUE = 'import.analyse';
export const RUN_QUEUE = 'import.run';
export const PURGE_QUEUE = 'import.purge';
export const PURGE_CRON = '41 3 * * *';
/** Every few minutes a run that no job is working on any more is let go (see `import.sweep` below). */
export const SWEEP_QUEUE = 'import.sweep';
export const SWEEP_CRON = '*/10 * * * *';
/** A run in analysing, queued or running whose last sign of life is older than this, and that no job holds, has been lost. */
export const STALE_MINUTES = 30;
/** How many times the import job tries before the run is marked failed. */
export const RUN_ATTEMPTS = 3;
/** An archive nobody started is dropped from storage after this long (the run's report stays). */
export const KEEP_ARCHIVE_DAYS = 7;

const STALE_DRY_RUN = 'The dry run stopped before it finished, most likely because the server was restarted. Nothing was written. Remove this run and upload the archive again.';
const STALE_IMPORT = 'The import stopped before it finished, most likely because the server was restarted. What it already wrote stays: upload the same archive again, read a dry run and start it, and it carries on where it stopped.';

const Payload = z.object({ workspaceId: z.uuid(), runId: z.uuid() });

/** What tests replace: the archive limits, the clock and the temp folder. */
export interface JobDeps {
  limits: ArchiveLimits;
  now: () => number;
  tempRoot: () => string;
}
export const DEFAULT_JOB_DEPS: JobDeps = { limits: DEFAULT_LIMITS, now: Date.now, tempRoot: tmpdir };

interface RunState extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  source: ImportSource;
  team_id: string;
  status: string;
  sha256: string;
  blob_key: string | null;
  created_by: string;
  started_by: string | null;
  cancel_requested: boolean;
  dry_run_report: ImportReport | null;
}

const plainError = (err: unknown): string => {
  if (err instanceof ZipRefused || err instanceof ArchiveError) return err.message.slice(0, 480);
  return 'The import stopped because of an unexpected problem. What it already wrote stays: upload the same archive again and start it, and it carries on where it stopped.';
};

/** Copies the stored archive to a private temporary file, checking that it is the bytes that were uploaded. The caller removes `dir`. */
async function copyToTemp(storage: BlobStorage, run: RunState, root: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(root, 'manythreads-import-'));
  const path = join(dir, 'archive.bin');
  try {
    const hash = createHash('sha256');
    const tee = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.from(await storage.get(run.blob_key!)), tee, createWriteStream(path, { mode: 0o600 }));
    if (hash.digest('hex') !== run.sha256) throw new ArchiveError('The stored archive does not match what was uploaded. Upload it again.');
    return { dir, path };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

const loadState = async (tx: PluginTx, runId: string): Promise<RunState | null> =>
  (
    await tx.query<RunState>(
      `SELECT id, workspace_id, source, team_id, status, sha256, blob_key, created_by, started_by, cancel_requested, dry_run_report FROM app.import_runs WHERE id = $1`,
      [runId],
    )
  ).rows[0] ?? null;

/** Opens the run's archive from storage, hands the reader to `fn`, and cleans up the temporary copy whatever happens. */
async function withReader<T>(ctx: PluginContext, deps: JobDeps, run: RunState, fn: (reader: ArchiveReader) => Promise<T>): Promise<T> {
  const storage = ctx.providers.get<BlobStorage>('storage');
  if (!storage) throw new ArchiveError('File storage is not available.');
  if (!run.blob_key) throw new ArchiveError('The archive is no longer stored. Upload it again.');
  const tmp = await copyToTemp(storage, run, deps.tempRoot());
  let reader: ArchiveReader | null = null;
  try {
    reader = await openArchive(tmp.path, run.source, deps.limits, deps.now);
    return await fn(reader);
  } finally {
    await reader?.close().catch(() => undefined);
    await rm(tmp.dir, { recursive: true, force: true });
  }
}

export function registerJobs(ctx: PluginContext, deps: JobDeps = DEFAULT_JOB_DEPS): void {
  const messages = (): MessageProvider => {
    const p = ctx.providers.get<MessageProvider>('messages');
    if (!p) throw new ArchiveError('Channels are not available.');
    return p;
  };
  const dropArchive = async (blobKey: string | null): Promise<void> => {
    if (blobKey) await ctx.providers.get<BlobStorage>('storage')?.delete(blobKey).catch(() => false);
  };

  ctx.jobs.register(
    ANALYSE_QUEUE,
    async (payload, _tx, job: JobInfo) => {
      const p = Payload.parse(payload);
      const transaction: Transaction = (fn) => job.transaction(fn);
      const run = await transaction((tx) => loadState(tx, p.runId));
      if (!run || run.workspace_id !== p.workspaceId || run.status !== 'analysing') return;
      const requestedBy = run.started_by ?? run.created_by;
      try {
        const outcome = await withReader(ctx, deps, run, (reader) =>
          runImport({
            mode: 'dry',
            transaction,
            provider: messages(),
            reader,
            runId: run.id,
            workspaceId: run.workspace_id,
            source: run.source,
            teamId: run.team_id,
            startedBy: requestedBy,
            // Cancel on a dry run ends the run from the request; this job only has to notice and stop reading
            shouldStop: async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.import_runs WHERE id = $1', [run.id])).rows[0]?.status !== 'analysing',
          }),
        );
        if (outcome.cancelled) return;
        const r = outcome.report;
        await transaction(async (tx) => {
          const res = await tx.query(
            `UPDATE app.import_runs SET status = 'analysed', dry_run_report = $2::jsonb, error = NULL, cancel_requested = false, updated_at = now() WHERE id = $1 AND status = 'analysing' RETURNING id`,
            [run.id, JSON.stringify(r)],
          );
          if (res.rows.length === 0) return;
          await ctx.audit.emit(tx, {
            type: 'import.run.analysed',
            runId: run.id,
            source: run.source,
            requestedBy,
            ok: true,
            people: r.people.total,
            channels: r.channels.total,
            messages: r.messages.total,
            skipped: r.skipped.reduce((n, s) => n + s.count, 0),
            at: new Date(deps.now()).toISOString(),
          });
        });
      } catch (err) {
        job.log.warn(`import: the dry run of ${run.id} failed: ${err instanceof Error ? err.name : 'error'}`);
        const message = plainError(err);
        await transaction(async (tx) => {
          const res = await tx.query(
            `UPDATE app.import_runs SET status = 'failed', error = $2, blob_key = NULL, updated_at = now(), finished_at = now() WHERE id = $1 AND status = 'analysing' RETURNING id`,
            [run.id, message],
          );
          if (res.rows.length === 0) return;
          await ctx.audit.emit(tx, {
            type: 'import.run.analysed',
            runId: run.id,
            source: run.source,
            requestedBy,
            ok: false,
            people: 0,
            channels: 0,
            messages: 0,
            skipped: 0,
            at: new Date(deps.now()).toISOString(),
          });
        });
        await dropArchive(run.blob_key);
      }
    },
    { concurrency: 1, maxAttempts: 1, detached: true, serialKey: 'workspaceId' },
  );

  ctx.jobs.register(
    RUN_QUEUE,
    async (payload, _tx, job: JobInfo) => {
      const p = Payload.parse(payload);
      const transaction: Transaction = (fn) => job.transaction(fn);
      const run = await transaction(async (tx) => {
        const r = await loadState(tx, p.runId);
        if (!r || r.workspace_id !== p.workspaceId || (r.status !== 'queued' && r.status !== 'running')) return null;
        // the status is checked again in the update itself: a cancel that lands between the read above and this write (it ends a queued run from the request)
        // must not be turned back into a running one
        const taken = await tx.query(
          `UPDATE app.import_runs SET status = 'running', started_at = coalesce(started_at, now()), updated_at = now() WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
          [r.id],
        );
        return taken.rows.length === 1 ? r : null;
      });
      if (!run) return;
      let outcome: { report: ImportReport; cancelled: boolean } | null = null;
      let failure: unknown;
      try {
        if (!run.started_by) throw new ArchiveError('The import has no one who started it.');
        const startedBy = (await transaction((tx) => tx.query<{ id: string }>('SELECT id FROM app.actors WHERE id = $1 AND kind = $2', [run.started_by, 'person']))).rows[0]?.id;
        if (!startedBy) throw new ArchiveError('The admin who started the import no longer has an account.');
        // the bar counts what the run will write or find already written, not every message of the archive (those it leaves out would never be counted)
        const expected = (run.dry_run_report?.messages.imported ?? 0) + (run.dry_run_report?.messages.alreadyImported ?? 0);
        outcome = await withReader(ctx, deps, run, (reader) =>
          runImport({
            mode: 'real',
            transaction,
            provider: messages(),
            reader,
            runId: run.id,
            workspaceId: run.workspace_id,
            source: run.source,
            teamId: run.team_id,
            startedBy,
            expectedMessages: expected,
            onProgress: async (tx, progress) => {
              await tx.query('UPDATE app.import_runs SET progress = $2::jsonb, updated_at = now() WHERE id = $1', [run.id, JSON.stringify(progress)]);
            },
            shouldStop: async (tx) => (await tx.query<{ c: boolean }>('SELECT cancel_requested AS c FROM app.import_runs WHERE id = $1', [run.id])).rows[0]?.c === true,
          }),
        );
      } catch (err) {
        failure = err;
        job.log.warn(`import: run ${run.id} stopped on attempt ${job.attempt}: ${err instanceof Error ? err.name : 'error'}`);
        // an archive that cannot be trusted will not get better on another attempt; anything else is tried again
        if (job.attempt < RUN_ATTEMPTS && !(err instanceof ZipRefused) && !(err instanceof ArchiveError)) throw err;
      }
      const status = failure !== undefined ? 'failed' : outcome!.cancelled ? 'cancelled' : 'done';
      const report = outcome?.report ?? null;
      await transaction(async (tx) => {
        await tx.query(
          `UPDATE app.import_runs SET status = $2, report = $3::jsonb, error = $4, blob_key = NULL, cancel_requested = false, updated_at = now(), finished_at = now() WHERE id = $1`,
          [run.id, status, report ? JSON.stringify(report) : null, failure !== undefined ? plainError(failure) : null],
        );
        await ctx.audit.emit(tx, {
          type: 'import.run.finished',
          runId: run.id,
          source: run.source,
          teamId: run.team_id,
          startedBy: run.started_by ?? run.created_by,
          outcome: status,
          channels: report?.channels.imported ?? 0,
          messages: report?.messages.imported ?? 0,
          matchedPeople: report?.people.matched ?? 0,
          placeholders: report?.people.placeholders ?? 0,
          skipped: report?.skipped.reduce((n, s) => n + s.count, 0) ?? 0,
          at: new Date(deps.now()).toISOString(),
        });
      });
      await dropArchive(run.blob_key);
    },
    { concurrency: 1, maxAttempts: RUN_ATTEMPTS, detached: true, serialKey: 'workspaceId' },
  );

  // Archives nobody started do not stay forever: a week after the last change the stored copy goes (the run and its report stay).
  ctx.jobs.register(
    PURGE_QUEUE,
    async (_payload, tx, job) => {
      const old = await tx.query<{ id: string; blob_key: string }>(
        `SELECT id, blob_key FROM app.import_runs
          WHERE blob_key IS NOT NULL AND status IN ('uploaded', 'analysed', 'failed', 'cancelled', 'done') AND updated_at < now() - make_interval(days => $1) LIMIT 200`,
        [KEEP_ARCHIVE_DAYS],
      );
      for (const r of old.rows) {
        await dropArchive(r.blob_key);
        await tx.query('UPDATE app.import_runs SET blob_key = NULL WHERE id = $1', [r.id]);
      }
      if (old.rows.length > 0) job.log.info(`import: dropped ${old.rows.length} stored archive(s) nobody started`);
    },
    { cron: PURGE_CRON, maxAttempts: 1 },
  );

  // A run that nothing works on any more: a server killed in the middle of it, a job that was lost. Its status would stay analysing, queued or running for
  // ever, the admin could neither delete it nor start another import ("another import is running"). When a run has shown no sign of life for
  // STALE_MINUTES (every batch of a real run touches `updated_at`) and no job of ours is waiting for or running it, it is ended as failed with a plain
  // sentence, and its stored archive is dropped. What it had written stays.
  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_payload, tx, job) => {
      const stuck = await tx.query<{ id: string; workspace_id: string; source: ImportSource; team_id: string; created_by: string; started_by: string | null; was: string; blob_key: string | null }>(
        `WITH stale AS (
            SELECT r.id, r.status AS was, r.blob_key FROM app.import_runs r
             WHERE r.status IN ('analysing', 'queued', 'running') AND r.updated_at < now() - make_interval(mins => $1)
               AND NOT EXISTS (SELECT 1 FROM app.jobs j WHERE j.queue IN ($2, $3) AND j.state IN ('ready', 'running') AND j.payload ->> 'runId' = r.id::text)
             ORDER BY r.updated_at LIMIT 100
               FOR UPDATE OF r SKIP LOCKED)
         UPDATE app.import_runs r
            SET status = 'failed', error = CASE WHEN s.was = 'analysing' THEN $4 ELSE $5 END, blob_key = NULL, cancel_requested = false, finished_at = now(), updated_at = now()
           FROM stale s WHERE r.id = s.id
       RETURNING r.id, r.workspace_id, r.source, r.team_id, r.created_by, r.started_by, s.was, s.blob_key`,
        [STALE_MINUTES, ANALYSE_QUEUE, RUN_QUEUE, STALE_DRY_RUN, STALE_IMPORT],
      );
      for (const r of stuck.rows) {
        if (r.was === 'analysing') {
          await ctx.audit.emit(tx, {
            type: 'import.run.analysed',
            workspaceId: r.workspace_id,
            runId: r.id,
            source: r.source,
            requestedBy: r.started_by ?? r.created_by,
            ok: false,
            people: 0,
            channels: 0,
            messages: 0,
            skipped: 0,
            at: new Date(deps.now()).toISOString(),
          });
        } else {
          await ctx.audit.emit(tx, {
            type: 'import.run.finished',
            workspaceId: r.workspace_id,
            runId: r.id,
            source: r.source,
            teamId: r.team_id,
            startedBy: r.started_by ?? r.created_by,
            outcome: 'failed',
            channels: 0,
            messages: 0,
            matchedPeople: 0,
            placeholders: 0,
            skipped: 0,
            at: new Date(deps.now()).toISOString(),
          });
        }
        await dropArchive(r.blob_key);
      }
      if (stuck.rows.length > 0) job.log.warn(`import: ended ${stuck.rows.length} run(s) that no job was working on`);
    },
    { cron: SWEEP_CRON, maxAttempts: 1 },
  );
}
