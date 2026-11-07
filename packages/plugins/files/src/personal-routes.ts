import { BlobNotFoundError, BlobTooLargeError, HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CreatePersonalFolderRequest,
  CreatePersonalFolderResponse,
  DeletePersonalFileResponse,
  DeletePersonalFolderQuery,
  DeletePersonalFolderResponse,
  GetFilesTreeQuery,
  GetFilesTreeResponse,
  ListPersonalFileVersionsResponse,
  PersonalFile,
  PersonalFilePathParams,
  PersonalFilesUsage,
  PersonalFileVersionPathParams,
  RestorePersonalFileVersionResponse,
  UpdatePersonalFileRequest,
  UpdatePersonalFileResponse,
  UploadPersonalFileQuery,
  UploadPersonalFileResponse,
  createPersonalFolderRoute,
  deletePersonalFileRoute,
  deletePersonalFolderRoute,
  downloadPersonalFileVersionRoute,
  getMyFilesTreeRoute,
  getPersonalFilesUsageRoute,
  listPersonalFileVersionsRoute,
  restorePersonalFileVersionRoute,
  spaceRefOf,
  updatePersonalFileRoute,
  uploadPersonalFileRoute,
  type PersonId,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route, tooLarge } from './http.ts';
import { decideMime } from './mime.ts';
import { decodeHeaderName, numberedName, sanitizeFileName } from './names.ts';
import { ensureFolder, isSeedFolder, listTree, lockAllowance, nameTaken, personalUsage, requireMember, requireOwnFile, seedFolders, type Member } from './personal.ts';
import { PERSONAL_FILE_COLUMNS, dbFolder, toPersonalFile, type PersonalFileRow } from './rows.ts';
import { fileContentResponse, maxUploadBytes, storageOf, takeUploadSlot, tapped, type ReadableLike } from './routes.ts';
import { sizeInWords } from './units.ts';

// The caller's own Personal files: /api/me/files/*. Every route starts with `requireMember` (a guest has no Personal space) and reads or writes
// through row level security, which is the real rule; the checks here only give the answers a screen needs (409, 413, plain sentences).

const space = (personId: string) => spaceRefOf({ kind: 'person', personId: personId as PersonId });
const outOfSpace = (usage: PersonalFilesUsage): HttpError =>
  tooLarge(`That would take you over your ${sizeInWords(usage.quotaBytes)} of Personal space. Delete something or an older version first.`);

type VersionRow = { id: string; file_id: string; blob_key: string; size: string | number; mime: string; sha256: string; author_actor_id: string | null; stored_at: Date };

/** Puts the file's CURRENT content aside as a version (the row keeps its blob; the caller then points the file at new bytes). */
async function archiveCurrent(tx: PluginTx, file: PersonalFileRow): Promise<void> {
  await tx.query(
    `INSERT INTO app.file_versions (workspace_id, file_id, blob_key, size, mime, sha256, author_actor_id, stored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [file.workspace_id, file.id, file.blob_key, file.size, file.mime, file.sha256, file.updated_by ?? file.uploader_id, file.updated_at ?? file.created_at],
  );
}

export function registerPersonalRoutes(ctx: PluginContext): void {
  const emit = ctx.audit.emit;

  const reload = async (tx: PluginTx, id: string): Promise<PersonalFile> => {
    const r = (await tx.query<PersonalFileRow>(`SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.id = $1`, [id])).rows[0];
    if (!r) throw forbidden();
    return toPersonalFile(r);
  };

  // The tree of the caller's own space. The first read makes the seven starting folders.
  ctx.http.route({
    ...getMyFilesTreeRoute,
    schema: { query: GetFilesTreeQuery, response: GetFilesTreeResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const q = GetFilesTreeQuery.parse(req.query);
      await seedFolders(ctx, tx, member);
      return json(await listTree(tx, member.personId, q.path, q.limit, { readOnly: false }));
    }),
  });

  ctx.http.route({
    ...getPersonalFilesUsageRoute,
    schema: { response: PersonalFilesUsage },
    handler: route(async (_req, tx) => {
      const member = await requireMember(tx);
      return json(PersonalFilesUsage.parse(await personalUsage(tx, member.personId)));
    }),
  });

  // Upload: a raw byte stream like a channel upload (see UploadPersonalFileQuery).
  ctx.http.route({
    ...uploadPersonalFileRoute,
    rawBody: true,
    schema: { query: UploadPersonalFileQuery, response: UploadPersonalFileResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const query = UploadPersonalFileQuery.parse(req.query);
      const source = req.stream;
      if (!source) throw invalid('The body must be the file');
      const limit = maxUploadBytes();
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        (source as ReadableLike).resume?.();
        throw tooLarge(`That file is larger than the ${limit} byte limit`);
      }
      // Refuse early what the header already shows will not fit; the exact check comes after the bytes are stored.
      const before = await personalUsage(tx, member.personId);
      if (Number.isFinite(declaredLength) && before.usedBytes + declaredLength > before.quotaBytes) {
        (source as ReadableLike).resume?.();
        throw outOfSpace(before);
      }
      const storage = storageOf(ctx);
      const name = sanitizeFileName(decodeHeaderName(req.headers['x-file-name']) ?? query.name);
      const release = takeUploadSlot(tx.actor.id);
      if (!release) {
        (source as ReadableLike).resume?.();
        throw new HttpError(429, 'rate_limited', 'Too many uploads at once: wait for one to finish');
      }
      const body = tapped(source);
      let stored;
      try {
        stored = await storage.put(body.stream, { maxBytes: limit });
      } catch (err) {
        body.drain();
        if (err instanceof BlobTooLargeError) throw tooLarge(`That file is larger than the ${limit} byte limit`);
        throw invalid('The upload was interrupted');
      } finally {
        release();
      }
      const mime = decideMime(req.headers['content-type'], body.head());
      let keepBlob = false;
      try {
        await lockAllowance(tx, member.personId);
        const usage = await personalUsage(tx, member.personId);
        if (usage.usedBytes + stored.size > usage.quotaBytes) throw outOfSpace(usage);
        await seedFolders(ctx, tx, member); // a person whose first act is an upload still gets the seven starting folders
        await ensureFolder(ctx, tx, member, query.folderPath);
        const folder = dbFolder(query.folderPath);
        let row: PersonalFileRow | undefined;
        let replaced = false;
        if (query.conflict === 'version') {
          const existing = (
            await tx.query<PersonalFileRow>(
              `SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.owner_person_id = $1 AND f.folder_path = $2 AND f.name = $3 FOR UPDATE OF f`,
              [member.personId, folder, name],
            )
          ).rows[0];
          if (existing) {
            replaced = true;
            if (existing.sha256 === stored.sha256) {
              row = existing; // the same bytes again: nothing to keep, nothing to change
            } else {
              await archiveCurrent(tx, existing);
              await tx.query(
                'UPDATE app.files SET blob_key = $2, size = $3, mime = $4, sha256 = $5, updated_at = now(), updated_by = app.actor() WHERE id = $1',
                [existing.id, stored.blobKey, stored.size, mime, stored.sha256],
              );
              keepBlob = true;
              row = (await tx.query<PersonalFileRow>(`SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.id = $1`, [existing.id])).rows[0];
            }
          }
        }
        if (!row) {
          for (let n = 1; n <= 100 && !row; n++) {
            const res = await tx.query<{ id: string }>(
              `INSERT INTO app.files AS f (workspace_id, owner_person_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
               VALUES (app.workspace_id(), $1, $2, $3, $4, $5, $6, $7, app.actor())
               ON CONFLICT (owner_person_id, folder_path, name) WHERE owner_person_id IS NOT NULL DO NOTHING
               RETURNING f.id`,
              [member.personId, folder, numberedName(name, n), stored.blobKey, stored.size, mime, stored.sha256],
            );
            if (res.rows[0]) row = (await tx.query<PersonalFileRow>(`SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.id = $1`, [res.rows[0].id])).rows[0];
          }
          if (!row) throw conflict('Too many files with that name in this folder');
          keepBlob = true;
        }
        if (!keepBlob) await storage.delete(stored.blobKey).catch(() => false);
        if (keepBlob) {
          await emit(tx, {
            type: 'files.file.uploaded',
            channelId: null,
            teamId: null,
            fileId: row.id,
            uploaderId: tx.actor.id,
            name: '',
            size: Number(row.size),
            mime: row.mime,
            space: space(member.personId),
          });
        }
        return json(UploadPersonalFileResponse.parse(toPersonalFile(row)), replaced ? 200 : 201);
      } catch (err) {
        // Nothing committed (the transaction rolls back): do not leave bytes nobody can reach.
        await storage.delete(stored.blobKey).catch(() => false);
        throw err;
      }
    }),
  });

  // Rename and/or move.
  ctx.http.route({
    ...updatePersonalFileRoute,
    schema: { body: UpdatePersonalFileRequest, response: UpdatePersonalFileResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId } = PersonalFilePathParams.parse(req.params);
      const body = UpdatePersonalFileRequest.parse(req.body);
      const file = await requireOwnFile(tx, member, fileId, true);
      const name = body.name !== undefined ? sanitizeFileName(body.name) : file.name;
      const folder = body.folderPath !== undefined ? dbFolder(body.folderPath) : file.folder_path;
      if (name === file.name && folder === file.folder_path) return json(UpdatePersonalFileResponse.parse(toPersonalFile(file)));
      if (body.folderPath !== undefined) {
        await seedFolders(ctx, tx, member);
        await ensureFolder(ctx, tx, member, body.folderPath);
      }
      const clash = await tx.query('SELECT 1 FROM app.files WHERE owner_person_id = $1 AND folder_path = $2 AND name = $3 AND id <> $4', [member.personId, folder, name, fileId]);
      if (clash.rows.length > 0) throw nameTaken();
      await tx.query('UPDATE app.files SET name = $2, folder_path = $3, updated_at = now(), updated_by = app.actor() WHERE id = $1', [fileId, name, folder]);
      return json(UpdatePersonalFileResponse.parse(await reload(tx, fileId)));
    }),
  });

  // Delete the file and all its versions. The row and the version rows go with the transaction; the bytes are removed here, and if that fails the rows come back.
  ctx.http.route({
    ...deletePersonalFileRoute,
    schema: { response: DeletePersonalFileResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId } = PersonalFilePathParams.parse(req.params);
      const file = await requireOwnFile(tx, member, fileId, true);
      const versionKeys = (await tx.query<{ blob_key: string }>('SELECT blob_key FROM app.file_versions WHERE file_id = $1', [fileId])).rows.map((r) => r.blob_key);
      const res = await tx.query('DELETE FROM app.files WHERE id = $1 AND owner_person_id = $2 RETURNING id', [fileId, member.personId]);
      if (res.rows.length === 0) throw forbidden('You cannot delete this file');
      await emit(tx, { type: 'files.file.deleted', channelId: null, teamId: null, fileId, deletedBy: tx.actor.id, space: space(member.personId) });
      const storage = storageOf(ctx);
      for (const key of [file.blob_key, ...versionKeys]) await storage.delete(key);
      return json(DeletePersonalFileResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    ...createPersonalFolderRoute,
    schema: { body: CreatePersonalFolderRequest, response: CreatePersonalFolderResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { path } = CreatePersonalFolderRequest.parse(req.body);
      await seedFolders(ctx, tx, member);
      await ensureFolder(ctx, tx, member, path);
      return json(CreatePersonalFolderResponse.parse({ path }));
    }),
  });

  ctx.http.route({
    ...deletePersonalFolderRoute,
    schema: { query: DeletePersonalFolderQuery, response: DeletePersonalFolderResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { path } = DeletePersonalFolderQuery.parse(req.query);
      if (isSeedFolder(path)) throw conflict('That is one of the folders every Personal space starts with, so it stays');
      const exists = await tx.query('SELECT 1 FROM app.personal_folders WHERE owner_person_id = $1 AND path = $2', [member.personId, path]);
      if (exists.rows.length === 0) throw notFound('That folder does not exist');
      // Below it: a file in it or in a folder under it, or a folder under it. `left(…, n) =` is a prefix test with no LIKE escaping to get wrong.
      const inside = await tx.query(
        `SELECT 1 FROM (
           SELECT folder_path AS p FROM app.files WHERE owner_person_id = $1
           UNION ALL SELECT path || '/' FROM app.personal_folders WHERE owner_person_id = $1 AND path <> $2
         ) x WHERE left(x.p, length($3::text)) = $3::text LIMIT 1`,
        [member.personId, path, dbFolder(path)],
      );
      if (inside.rows.length > 0) throw conflict('That folder is not empty');
      await tx.query('DELETE FROM app.personal_folders WHERE owner_person_id = $1 AND path = $2', [member.personId, path]);
      return json(DeletePersonalFolderResponse.parse({ deleted: true }));
    }),
  });

  // Versions -------------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listPersonalFileVersionsRoute,
    schema: { response: ListPersonalFileVersionsResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId } = PersonalFilePathParams.parse(req.params);
      const file = await requireOwnFile(tx, member, fileId);
      const older = await tx.query<VersionRow>(
        'SELECT id, file_id, blob_key, size, mime, sha256, author_actor_id, stored_at FROM app.file_versions WHERE file_id = $1 ORDER BY created_at DESC, id DESC',
        [fileId],
      );
      return json(
        ListPersonalFileVersionsResponse.parse({
          items: [
            {
              id: null,
              current: true,
              size: Number(file.size),
              mime: file.mime,
              sha256: file.sha256,
              authorId: file.updated_by ?? file.uploader_id,
              createdAt: (file.updated_at ?? file.created_at).toISOString(),
              contentUrl: `/api/files/${file.id}/content`,
            },
            ...older.rows.map((v) => ({
              id: v.id,
              current: false,
              size: Number(v.size),
              mime: v.mime,
              sha256: v.sha256,
              authorId: v.author_actor_id,
              createdAt: v.stored_at.toISOString(),
              contentUrl: `/api/me/files/${fileId}/versions/${v.id}/content`,
            })),
          ],
        }),
      );
    }),
  });

  const requireVersion = async (tx: PluginTx, member: Member, fileId: string, versionId: string): Promise<{ file: PersonalFileRow; version: VersionRow }> => {
    const file = await requireOwnFile(tx, member, fileId, true);
    const version = (
      await tx.query<VersionRow>(
        'SELECT id, file_id, blob_key, size, mime, sha256, author_actor_id, stored_at FROM app.file_versions WHERE id = $1 AND file_id = $2',
        [versionId, fileId],
      )
    ).rows[0];
    if (!version) throw notFound('That version does not exist');
    return { file, version };
  };

  ctx.http.route({
    ...downloadPersonalFileVersionRoute,
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId, versionId } = PersonalFileVersionPathParams.parse(req.params);
      const { file, version } = await requireVersion(tx, member, fileId, versionId);
      let stream;
      try {
        stream = await storageOf(ctx).get(version.blob_key);
      } catch (err) {
        if (err instanceof BlobNotFoundError) throw notFound('The file is no longer in storage');
        throw err;
      }
      return fileContentResponse({ mime: version.mime, name: file.name, size: version.size }, stream, req.query['download'] === '1');
    }),
  });

  // Restore: the older content becomes the file's content and the content it replaces is kept as a version, so nothing is lost. The old version
  // stays in the list; its bytes are copied to a new blob, because one blob is named by exactly one row.
  ctx.http.route({
    ...restorePersonalFileVersionRoute,
    schema: { response: RestorePersonalFileVersionResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId, versionId } = PersonalFileVersionPathParams.parse(req.params);
      const { file, version } = await requireVersion(tx, member, fileId, versionId);
      await lockAllowance(tx, member.personId);
      const usage = await personalUsage(tx, member.personId);
      if (usage.usedBytes + Number(version.size) > usage.quotaBytes) throw outOfSpace(usage);
      const storage = storageOf(ctx);
      let copy;
      try {
        copy = await storage.put(await storage.get(version.blob_key), { maxBytes: Math.max(Number(version.size), 1) });
      } catch (err) {
        if (err instanceof BlobNotFoundError) throw notFound('The file is no longer in storage');
        throw err;
      }
      try {
        await archiveCurrent(tx, file);
        await tx.query(
          'UPDATE app.files SET blob_key = $2, size = $3, mime = $4, sha256 = $5, updated_at = now(), updated_by = app.actor() WHERE id = $1',
          [fileId, copy.blobKey, copy.size, version.mime, copy.sha256],
        );
        await emit(tx, { type: 'files.file.restored', fileId, versionId, space: space(member.personId), restoredBy: tx.actor.id });
        return json(RestorePersonalFileVersionResponse.parse(await reload(tx, fileId)));
      } catch (err) {
        await storage.delete(copy.blobKey).catch(() => false);
        throw err;
      }
    }),
  });

}
