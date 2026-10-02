import {
  BlobNotFoundError,
  BlobTooLargeError,
  HttpError,
  type BlobStorage,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  ChannelFilesPathParams,
  DeleteFileResponse,
  FilePathParams,
  GetFileResponse,
  ListChannelFilesQuery,
  ListChannelFilesResponse,
  UploadFileQuery,
  UploadFileResponse,
  deleteFileRoute,
  downloadFileRoute,
  getFileRoute,
  listChannelFilesRoute,
  uploadFileRoute,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route, tooLarge } from './http.ts';
import { decideMime, dispositionFor, servedMime } from './mime.ts';
import { asciiFallback, decodeHeaderName, numberedName, sanitizeFileName } from './names.ts';
import { FILE_COLUMNS, toFileMeta, type FileRow } from './rows.ts';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** `MANYTHREADS_MAX_UPLOAD_BYTES` (read per request so an operator or a test can change it), else 50 MB. */
export function maxUploadBytes(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['MANYTHREADS_MAX_UPLOAD_BYTES']);
  return Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_MAX_UPLOAD_BYTES;
}

type ChannelInfo = { id: string; name: string; kind: string; team_id: string | null; archived_at: Date | null; can_post: boolean };

/** The channel as the caller sees it (row level security), with their post permission; 403 for a missing or hidden one. */
async function requireChannel(tx: PluginTx, channelId: string): Promise<ChannelInfo> {
  const res = await tx.query<ChannelInfo>(
    `SELECT c.id, c.name, c.kind, c.team_id, c.archived_at, app.channel_can(c.id, 'post') AS can_post FROM app.channels c WHERE c.id = $1`,
    [channelId],
  );
  const channel = res.rows[0];
  if (!channel) throw forbidden('You cannot see this channel');
  return channel;
}

/** The file row if the caller may read it; 403 for a missing one and a hidden one alike. */
async function requireFile(tx: PluginTx, fileId: string): Promise<FileRow> {
  const res = await tx.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM app.files f WHERE f.id = $1`, [fileId]);
  const row = res.rows[0];
  if (!row) throw forbidden();
  return row;
}

const folderOf = (c: ChannelInfo): string => (c.kind === 'channel' ? `channels/${c.name}/` : `dms/${c.id}/`);

type ReadableLike = AsyncIterable<Uint8Array> & {
  iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>;
  resume?: () => unknown;
};

/**
 * The request body for the blob store: remembers the first bytes (for the type sniff) and, unlike iterating a Node stream directly, does
 * not destroy the socket when the reader stops early, so a refusal (413) can still be sent. `drain` then discards what is left.
 */
function tapped(source: AsyncIterable<Uint8Array>): { stream: AsyncIterable<Uint8Array>; head: () => Uint8Array; drain: () => void } {
  const src = source as ReadableLike;
  const it = src.iterator ? src.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
  const HEAD = 32;
  let head = new Uint8Array(0);
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const r = await it.next();
        if (!r.done && head.length < HEAD) {
          const chunk = r.value;
          const merged = new Uint8Array(Math.min(HEAD, head.length + chunk.length));
          merged.set(head);
          merged.set(chunk.subarray(0, merged.length - head.length), head.length);
          head = merged;
        }
        return r;
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
  return { stream, head: () => head, drain: () => void src.resume?.() };
}

function storageOf(ctx: PluginContext): BlobStorage {
  const storage = ctx.providers.get<BlobStorage>('storage');
  if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
  return storage;
}

export function registerFileRoutes(ctx: PluginContext): void {
  const emit = ctx.audit.emit;

  ctx.http.route({
    ...uploadFileRoute,
    rawBody: true,
    schema: { query: UploadFileQuery, response: UploadFileResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelFilesPathParams.parse(req.params);
      const query = UploadFileQuery.parse(req.query);
      const channel = await requireChannel(tx, channelId);
      if (channel.archived_at) throw conflict('This channel is archived');
      if (!channel.can_post) throw forbidden('You can read this channel but not post in it');
      const source = req.stream;
      if (!source) throw invalid('The body must be the file');
      const limit = maxUploadBytes();
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        (source as ReadableLike).resume?.();
        throw tooLarge(`That file is larger than the ${limit} byte limit`);
      }
      const storage = storageOf(ctx);
      const name = sanitizeFileName(decodeHeaderName(req.headers['x-file-name']) ?? query.name);
      const body = tapped(source);
      let stored;
      try {
        stored = await storage.put(body.stream, { maxBytes: limit });
      } catch (err) {
        body.drain();
        if (err instanceof BlobTooLargeError) throw tooLarge(`That file is larger than the ${limit} byte limit`);
        throw invalid('The upload was interrupted');
      }
      const mime = decideMime(req.headers['content-type'], body.head());
      try {
        let row: FileRow | undefined;
        for (let n = 1; n <= 100 && !row; n++) {
          const res = await tx.query<FileRow>(
            `INSERT INTO app.files AS f (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
             VALUES (app.workspace_id(), $1, $2, $3, $4, $5, $6, $7, app.actor())
             ON CONFLICT (channel_id, folder_path, name) WHERE channel_id IS NOT NULL DO NOTHING
             RETURNING ${FILE_COLUMNS}`,
            [channelId, folderOf(channel), numberedName(name, n), stored.blobKey, stored.size, mime, stored.sha256],
          );
          row = res.rows[0];
        }
        if (!row) throw conflict('Too many files with that name in this channel');
        await emit(tx, {
          type: 'files.file.uploaded',
          channelId,
          teamId: channel.team_id,
          fileId: row.id,
          uploaderId: row.uploader_id,
          name: row.name,
          size: Number(row.size),
          mime: row.mime,
        });
        return json(UploadFileResponse.parse(toFileMeta(row)), 201);
      } catch (err) {
        // The row never committed (the transaction rolls back): do not leave bytes nobody can reach.
        await storage.delete(stored.blobKey).catch(() => false);
        throw err;
      }
    }),
  });

  ctx.http.route({
    ...listChannelFilesRoute,
    schema: { query: ListChannelFilesQuery, response: ListChannelFilesResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelFilesPathParams.parse(req.params);
      const q = ListChannelFilesQuery.parse(req.query);
      await requireChannel(tx, channelId);
      const res = await tx.query<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM app.files f WHERE f.channel_id = $1 AND ($2::uuid IS NULL OR f.id < $2) ORDER BY f.id DESC LIMIT $3`,
        [channelId, q.before ?? null, q.limit + 1],
      );
      const more = res.rows.length > q.limit;
      const page = more ? res.rows.slice(0, q.limit) : res.rows;
      const oldest = page[page.length - 1];
      return json(ListChannelFilesResponse.parse({ items: page.map(toFileMeta), nextCursor: more && oldest ? oldest.id : null }));
    }),
  });

  ctx.http.route({
    ...getFileRoute,
    schema: { response: GetFileResponse },
    handler: route(async (req, tx) => {
      const { fileId } = FilePathParams.parse(req.params);
      return json(GetFileResponse.parse(toFileMeta(await requireFile(tx, fileId))));
    }),
  });

  // The bytes. The row is read through row level security on EVERY request: take the channel's access away and the next read is 403,
  // whatever link or token the person holds (there is none: the URL carries only the file id).
  ctx.http.route({
    ...downloadFileRoute,
    handler: route(async (req, tx) => {
      const { fileId } = FilePathParams.parse(req.params);
      const file = await requireFile(tx, fileId);
      const storage = storageOf(ctx);
      let stream;
      try {
        stream = await storage.get(file.blob_key);
      } catch (err) {
        if (err instanceof BlobNotFoundError) throw notFound('The file is no longer in storage');
        throw err;
      }
      const forceDownload = req.query['download'] === '1';
      const disposition = forceDownload ? 'attachment' : dispositionFor(file.mime);
      return {
        status: 200,
        body: stream,
        headers: {
          'content-type': servedMime(file.mime),
          'content-length': String(file.size),
          'content-disposition': `${disposition}; filename="${asciiFallback(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
          // Access is re-decided on every read, so nothing may serve the bytes from a cache without asking.
          'cache-control': 'private, no-cache',
        },
      };
    }),
  });

  ctx.http.route({
    ...deleteFileRoute,
    schema: { response: DeleteFileResponse },
    handler: route(async (req, tx) => {
      const { fileId } = FilePathParams.parse(req.params);
      const file = await requireFile(tx, fileId);
      const manage =
        file.channel_id !== null &&
        (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1, $2) AS ok', [file.channel_id, 'manage'])).rows[0]?.ok === true;
      if (file.uploader_id !== tx.actor.id && !manage) throw forbidden('Only the uploader or a team lead can delete a file');
      const res = await tx.query<{ blob_key: string }>('DELETE FROM app.files WHERE id = $1 RETURNING blob_key', [fileId]);
      if (res.rows.length === 0) throw forbidden('You cannot delete this file');
      await emit(tx, {
        type: 'files.file.deleted',
        channelId: file.channel_id,
        teamId: file.team_id,
        fileId,
        deletedBy: tx.actor.id,
      });
      // Keys are random per upload, so no other row shares these bytes. If this throws the row comes back (the transaction rolls back).
      await storageOf(ctx).delete(file.blob_key);
      return json(DeleteFileResponse.parse({ deleted: true }));
    }),
  });
}
