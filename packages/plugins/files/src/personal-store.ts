import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PERSONAL_TEXT_MAX_BYTES, type PersonalFilesProvider, type PersonalTextFile, type PersonalWriteOptions, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { spaceRefOf, type PersonId } from '@manythreads/shared';
import { conflict, forbidden, invalid, tooLarge } from './http.ts';
import { sanitizeFileName } from './names.ts';
import { ensureFolder, lockAllowance, personalUsage } from './personal.ts';
import { PERSONAL_FILE_COLUMNS, dbFolder, wireFolder, type PersonalFileRow } from './rows.ts';
import { storageOf } from './routes.ts';
import { sizeInWords } from './units.ts';

// The `personal.files` provider (SDK personal-files.ts): other plugins keep a person's text in their Personal space through it. It does what the upload route does for a
// text file (a new version of a changed file, the allowance, the folders), for a person named in the call, in the caller's transaction. Row level security is still the
// rule on every statement; the checks here give the plain answers.

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const mimeFor = (name: string): string => (/\.md$/i.test(name) ? 'text/markdown' : /\.ya?ml$/i.test(name) ? 'application/yaml' : 'text/plain');

function splitPath(path: string): { folder: string; name: string } {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  const folder = parts.join('/');
  if (folder === '' || name === '' || parts.some((p) => p === '' || p === '.' || p === '..') || name === '.' || name === '..' || path.length > 500) {
    throw invalid('A file lives inside a folder, and a path has no empty, . or .. part');
  }
  if (sanitizeFileName(name) !== name) throw invalid('That is not a name a file can have');
  return { folder, name };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export function createPersonalFilesProvider(ctx: PluginContext): PersonalFilesProvider {
  const asText = async (row: PersonalFileRow): Promise<PersonalTextFile | null> => {
    if (Number(row.size) > PERSONAL_TEXT_MAX_BYTES) return null;
    let buf: Buffer;
    try {
      buf = await readAll(await storageOf(ctx).get(row.blob_key));
    } catch {
      return null;
    }
    return {
      fileId: row.id,
      path: `${wireFolder(row.folder_path)}/${row.name}`,
      text: buf.toString('utf8'),
      revision: row.sha256,
      updatedAt: (row.updated_at ?? row.created_at).toISOString(),
    };
  };

  const find = async (tx: PluginTx, personId: string, folder: string, name: string, lock: boolean): Promise<PersonalFileRow | undefined> =>
    (
      await tx.query<PersonalFileRow>(
        `SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.owner_person_id = $1 AND f.folder_path = $2 AND f.name = $3 ${lock ? 'FOR UPDATE OF f' : ''}`,
        [personId, dbFolder(folder), name],
      )
    ).rows[0];

  return {
    id: 'files',

    async read(tx, personId, path) {
      const { folder, name } = splitPath(path);
      const row = await find(tx, personId, folder, name, false);
      return row ? asText(row) : null;
    },

    async write(tx, personId, path, text, options: PersonalWriteOptions = {}) {
      const { folder, name } = splitPath(path);
      const mode = options.mode ?? 'replace';
      const member = (
        await tx.query<{ workspace_id: string; actor_id: string | null }>(
          `SELECT p.workspace_id, (SELECT a.id FROM app.actors a WHERE a.kind = 'person' AND a.ref_id = p.id) AS actor_id
             FROM app.people p JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
            WHERE p.id = $1 AND p.status = 'active' AND wm.role <> 'guest'`,
          [personId],
        )
      ).rows[0];
      if (!member) throw forbidden('Personal files are for members of the workspace');
      const author = options.authorActorId ?? (await tx.query<{ a: string | null }>('SELECT app.actor() AS a')).rows[0]?.a ?? member.actor_id;
      if (!author) throw forbidden();

      await lockAllowance(tx, personId);
      const existing = await find(tx, personId, folder, name, true);
      if (options.expectedRevision !== undefined && (existing?.sha256 ?? null) !== options.expectedRevision) {
        throw conflict('That file changed since it was read; read it again');
      }
      if (mode === 'create' && existing) throw conflict('That file already exists');

      let next = text;
      if (mode === 'append' && existing) {
        const current = await asText(existing);
        if (!current) throw invalid('The file is not text that can be added to');
        next = current.text.endsWith('\n') || current.text === '' ? current.text + text : `${current.text}\n${text}`;
      }
      const buf = Buffer.from(next, 'utf8');
      if (buf.length > PERSONAL_TEXT_MAX_BYTES) throw tooLarge(`A text file here is at most ${sizeInWords(PERSONAL_TEXT_MAX_BYTES)}`);
      const digest = sha256(buf);
      if (existing && existing.sha256 === digest) {
        const same = await asText(existing);
        return { file: same ?? { fileId: existing.id, path, text: next, revision: digest, updatedAt: (existing.updated_at ?? existing.created_at).toISOString() }, created: false, changed: false };
      }
      const usage = await personalUsage(tx, personId);
      if (usage.usedBytes + buf.length > usage.quotaBytes) throw tooLarge(`That would take you over your ${sizeInWords(usage.quotaBytes)} of Personal space.`);

      const storage = storageOf(ctx);
      const stored = await storage.put(Readable.from([buf]), { maxBytes: PERSONAL_TEXT_MAX_BYTES + 1 });
      try {
        await ensureFolder(ctx, tx, { personId, workspaceId: member.workspace_id }, folder);
        let id: string;
        if (existing) {
          await tx.query(
            `INSERT INTO app.file_versions (workspace_id, file_id, blob_key, size, mime, sha256, author_actor_id, stored_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [existing.workspace_id, existing.id, existing.blob_key, existing.size, existing.mime, existing.sha256, existing.updated_by ?? existing.uploader_id, existing.updated_at ?? existing.created_at],
          );
          await tx.query('UPDATE app.files SET blob_key = $2, size = $3, mime = $4, sha256 = $5, updated_at = now(), updated_by = $6 WHERE id = $1', [
            existing.id,
            stored.blobKey,
            stored.size,
            mimeFor(name),
            stored.sha256,
            author,
          ]);
          id = existing.id;
        } else {
          id = (
            await tx.query<{ id: string }>(
              `INSERT INTO app.files (workspace_id, owner_person_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
              [member.workspace_id, personId, dbFolder(folder), name, stored.blobKey, stored.size, mimeFor(name), stored.sha256, author],
            )
          ).rows[0]!.id;
        }
        const row = (await tx.query<PersonalFileRow>(`SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.id = $1`, [id])).rows[0]!;
        await ctx.audit.emit(tx, {
          type: 'files.file.uploaded',
          channelId: null,
          teamId: null,
          fileId: id,
          uploaderId: author,
          name: '',
          size: Number(row.size),
          mime: row.mime,
          space: spaceRefOf({ kind: 'person', personId: personId as PersonId }),
        });
        return { file: { fileId: id, path, text: next, revision: stored.sha256, updatedAt: (row.updated_at ?? row.created_at).toISOString() }, created: !existing, changed: true };
      } catch (err) {
        await storage.delete(stored.blobKey).catch(() => false);
        throw err;
      }
    },
  };
}
