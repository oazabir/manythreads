import {
  BlobTooLargeError,
  HttpError,
  conflict,
  forbidden,
  invalid,
  json,
  notFound,
  route,
  type BlobStorage,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  DeleteImportResponse,
  ImportRun,
  ImportRunPathParams,
  ListImportsResponse,
  UploadImportQuery,
  cancelImportRoute,
  deleteImportRoute,
  dryRunImportRoute,
  getImportRoute,
  listImportsRoute,
  startImportRoute,
  uploadImportRoute,
} from '@manythreads/shared';
import { looksLikeArchive } from './archive.ts';
import { ANALYSE_QUEUE, RUN_QUEUE } from './jobs.ts';
import { importMaxBytes } from './limits.ts';
import { drain, takeUploadSlot, tapped, tooLarge } from './upload.ts';

// Routes of the import plugin. Every one is for workspace owners and admins only: row level security says so on the tables, and each handler asks
// first so that a member gets one plain refusal. The archive is stored with the storage provider as it arrives (never held in memory) and read later by
// the background job; no route reads it.

interface RunRow extends Record<string, unknown> {
  id: string;
  source: 'slack' | 'mattermost';
  status: string;
  file_name: string;
  size_bytes: string;
  team_id: string;
  team_slug: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  dry_run_report: unknown;
  report: unknown;
  progress: unknown;
  error: string | null;
  cancel_requested: boolean;
  blob_key: string | null;
}

const RUN_COLUMNS = `r.id, r.source, r.status, r.file_name, r.size_bytes, r.team_id, coalesce(t.slug, '') AS team_slug, r.created_by, r.created_at, r.updated_at,
  r.started_at, r.finished_at, r.dry_run_report, r.report, r.progress, r.error, r.cancel_requested, r.blob_key`;
const RUN_FROM = 'app.import_runs r LEFT JOIN app.teams t ON t.id = r.team_id';

export const toRun = (r: RunRow): ImportRun =>
  ImportRun.parse({
    id: r.id,
    source: r.source,
    status: r.status,
    fileName: r.file_name,
    size: Number(r.size_bytes),
    teamId: r.team_id,
    teamSlug: r.team_slug,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    dryRun: r.dry_run_report ?? null,
    result: r.report ?? null,
    progress: r.progress ?? null,
    error: r.error,
    cancelRequested: r.cancel_requested,
  });

async function requireAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can import.');
}

async function loadRun(tx: PluginTx, runId: string): Promise<RunRow> {
  const row = (await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE r.id = $1`, [runId])).rows[0];
  if (!row) throw notFound('No such import');
  return row;
}

const storageOf = (ctx: PluginContext): BlobStorage => {
  const storage = ctx.providers.get<BlobStorage>('storage');
  if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
  return storage;
};

/** A file name from the browser as a label: one line, no path, no control characters. */
const labelOf = (raw: string): string => {
  // eslint-disable-next-line no-control-regex
  const base = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/[\\/]/).pop()!.trim().slice(0, 200);
  return base === '' ? 'export' : base;
};

export function registerRoutes(ctx: PluginContext): void {
  const emit = ctx.audit.emit;
  const now = (): string => new Date().toISOString();

  ctx.http.route({
    ...uploadImportRoute,
    rawBody: true,
    schema: { query: UploadImportQuery, response: ImportRun },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const source = req.stream;
      // A refusal is sent while the client may still be sending: read a little of the body so the answer can be heard, then stop reading and cut the
      // connection a moment later, instead of reading a gigabyte nobody will keep.
      const refuse = (err: HttpError): never => {
        if (source) drain(source);
        throw err;
      };
      await requireAdmin(tx).catch((err: unknown) => refuse(err as HttpError));
      if (!source) throw invalid('The body must be the archive');
      const q = UploadImportQuery.parse(req.query);
      const team = (await tx.query<{ id: string; archived_at: Date | null }>('SELECT id, archived_at FROM app.teams WHERE slug = $1', [q.team])).rows[0];
      if (!team) return refuse(notFound(`No team "${q.team}"`));
      if (team.archived_at) return refuse(conflict('That team is archived'));
      const limit = importMaxBytes();
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) return refuse(tooLarge(`That archive is larger than the ${limit} byte limit`));
      const storage = storageOf(ctx);
      const release = takeUploadSlot(tx.actor.id);
      if (!release) return refuse(new HttpError(429, 'rate_limited', 'Another archive is still uploading: wait for it to finish'));
      const body = tapped(source);
      let stored;
      try {
        stored = await storage.put(body.stream, { maxBytes: limit });
      } catch (err) {
        body.drain();
        if (err instanceof BlobTooLargeError) throw tooLarge(`That archive is larger than the ${limit} byte limit`);
        throw invalid('The upload was interrupted');
      } finally {
        release();
      }
      try {
        if (stored.size === 0 || !looksLikeArchive(q.source, body.head())) {
          throw invalid(
            q.source === 'slack' ? 'That is not a Slack export: a Slack export is a zip file.' : 'That is not a Mattermost export: it is a JSON-lines file, or a zip with one.',
          );
        }
        const name = labelOf(q.name ?? String(req.headers['x-file-name'] ?? ''));
        const row = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.import_runs (workspace_id, source, team_id, file_name, size_bytes, sha256, blob_key, created_by)
             VALUES (app.workspace_id(), $1, $2, $3, $4, $5, $6, app.actor()) RETURNING id`,
            [q.source, team.id, name, stored.size, stored.sha256, stored.blobKey],
          )
        ).rows[0]!;
        await emit(tx, { type: 'import.run.uploaded', runId: row.id, source: q.source, teamId: team.id, size: stored.size, uploadedBy: tx.actor.id, at: now() });
        return json(toRun(await loadRun(tx, row.id)), 201);
      } catch (err) {
        // the row never committed (the transaction rolls back): do not leave a gigabyte nobody can reach
        await storage.delete(stored.blobKey).catch(() => false);
        throw err;
      }
    }),
  });

  ctx.http.route({
    ...listImportsRoute,
    schema: { response: ListImportsResponse },
    handler: route(async (_req, tx) => {
      await requireAdmin(tx);
      const rows = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} ORDER BY r.id DESC LIMIT 50`);
      return json(ListImportsResponse.parse({ items: rows.rows.map(toRun) }));
    }),
  });

  ctx.http.route({
    ...getImportRoute,
    schema: { response: ImportRun },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { runId } = ImportRunPathParams.parse(req.params);
      return json(toRun(await loadRun(tx, runId)));
    }),
  });

  ctx.http.route({
    ...dryRunImportRoute,
    schema: { response: ImportRun },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { runId } = ImportRunPathParams.parse(req.params);
      const run = await loadRun(tx, runId);
      if (run.status !== 'uploaded' && run.status !== 'analysed') throw conflict('A dry run can be done on an archive that has been uploaded and not started.');
      if (!run.blob_key) throw conflict('The archive is no longer stored: upload it again.');
      await tx.query(`UPDATE app.import_runs SET status = 'analysing', error = NULL, updated_at = now() WHERE id = $1`, [runId]);
      await ctx.jobs.enqueue(tx, ANALYSE_QUEUE, { workspaceId: tx.actor.workspaceId, runId }, { dedupeKey: `analyse:${runId}` });
      return json(toRun(await loadRun(tx, runId)), 202);
    }),
  });

  ctx.http.route({
    ...startImportRoute,
    schema: { response: ImportRun },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { runId } = ImportRunPathParams.parse(req.params);
      const run = await loadRun(tx, runId);
      if (run.status !== 'analysed') throw conflict('Do a dry run and read its report first: an import starts only from a finished dry run.');
      if (!run.blob_key) throw conflict('The archive is no longer stored: upload it again.');
      const person = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id;
      if (!person) throw forbidden('Only a person can start an import.');
      // one import at a time per workspace: two writing into the same channels would only get in each other's way
      const busy = await tx.query(`SELECT 1 FROM app.import_runs WHERE status IN ('queued', 'running') AND id <> $1 LIMIT 1`, [runId]);
      if (busy.rows.length > 0) throw conflict('Another import is running. Wait for it to end or cancel it.');
      await tx.query(
        `UPDATE app.import_runs SET status = 'queued', started_by = app.actor(), started_at = now(), cancel_requested = false, error = NULL, updated_at = now() WHERE id = $1`,
        [runId],
      );
      await emit(tx, { type: 'import.run.started', runId, source: run.source, teamId: run.team_id, startedBy: tx.actor.id, at: now() });
      await ctx.jobs.enqueue(tx, RUN_QUEUE, { workspaceId: tx.actor.workspaceId, runId }, { dedupeKey: `run:${runId}` });
      return json(toRun(await loadRun(tx, runId)), 202);
    }),
  });

  ctx.http.route({
    ...cancelImportRoute,
    schema: { response: ImportRun },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { runId } = ImportRunPathParams.parse(req.params);
      const run = await loadRun(tx, runId);
      if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'analysing') throw conflict('Only an import that is waiting or running can be cancelled.');
      // A run that is only waiting (queued) or being read (analysing) has written nothing a job must finish, so it ends here and now: this is also how a run
      // whose job died is let go. The job, if it is alive, finds the status changed and stops. Only a running import is asked to stop after its batch.
      const ended = (
        await tx.query<{ started_by: string | null }>(
          `UPDATE app.import_runs SET status = 'cancelled', cancel_requested = false, blob_key = NULL, finished_at = now(), updated_at = now()
            WHERE id = $1 AND status IN ('analysing', 'queued') RETURNING started_by`,
          [runId],
        )
      ).rows[0];
      if (ended) {
        if (run.status === 'queued') {
          await emit(tx, {
            type: 'import.run.finished',
            runId,
            source: run.source,
            teamId: run.team_id,
            startedBy: ended.started_by ?? run.created_by,
            outcome: 'cancelled',
            channels: 0,
            messages: 0,
            matchedPeople: 0,
            placeholders: 0,
            skipped: 0,
            at: now(),
          });
        }
        if (run.blob_key) await storageOf(ctx).delete(run.blob_key).catch(() => false);
      } else {
        await tx.query(`UPDATE app.import_runs SET cancel_requested = true, updated_at = now() WHERE id = $1 AND status = 'running'`, [runId]);
      }
      return json(toRun(await loadRun(tx, runId)), 202);
    }),
  });

  ctx.http.route({
    ...deleteImportRoute,
    schema: { response: DeleteImportResponse },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { runId } = ImportRunPathParams.parse(req.params);
      const run = await loadRun(tx, runId);
      if (run.status === 'queued' || run.status === 'running' || run.status === 'analysing') throw conflict('Cancel the import first.');
      const res = await tx.query('DELETE FROM app.import_runs WHERE id = $1 RETURNING id', [runId]);
      if (run.blob_key) await storageOf(ctx).delete(run.blob_key).catch(() => false);
      return json(DeleteImportResponse.parse({ deleted: res.rows.length > 0 }));
    }),
  });
}
