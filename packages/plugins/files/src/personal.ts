import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  DEFAULT_PERSONAL_QUOTA_BYTES,
  FilesTreeEntry,
  GetFilesTreeResponse,
  PERSONAL_SEED_FOLDERS,
  type FilesManagedBy,
  type FilesReadOnlyReason,
  type PersonalFilesUsage,
} from '@manythreads/shared';
import { conflict, forbidden, notFound } from './http.ts';
import { PERSONAL_FILE_COLUMNS, dbFolder, wireFolder, type PersonalFileRow } from './rows.ts';

// A person's Personal files, the parts the routes share: who may have a Personal space, the allowance, folders, and the tree. The access rule
// itself is in the database (files 0005); nothing here decides who may read a row, it only asks the questions the screens ask.

/** `MANYTHREADS_PERSONAL_QUOTA_BYTES` (read per call), else 5 GiB. */
export function personalQuotaBytes(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['MANYTHREADS_PERSONAL_QUOTA_BYTES']);
  return Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_PERSONAL_QUOTA_BYTES;
}

export interface Member {
  personId: string;
  workspaceId: string;
}

/**
 * The caller as someone who has a Personal space: a signed-in person who is an owner, admin or member of the workspace. A guest, a bot, a
 * suspended person: 403 (a guest has no Personal space, P20-14).
 */
export async function requireMember(tx: PluginTx): Promise<Member> {
  const res = await tx.query<{ role: string | null; person_id: string | null; workspace_id: string | null }>(
    'SELECT app.lookup_workspace_role() AS role, app.person_id() AS person_id, app.workspace_id() AS workspace_id',
  );
  const r = res.rows[0];
  if (!r?.person_id || !r.workspace_id || r.role === null || r.role === 'guest') {
    throw forbidden('Personal files are for members of the workspace');
  }
  return { personId: r.person_id, workspaceId: r.workspace_id };
}

/** Bytes in use by a person: their live files plus every kept version. Counts what the caller can read, so it is exact for the owner. */
export async function personalUsage(tx: PluginTx, personId: string): Promise<PersonalFilesUsage> {
  const res = await tx.query<{ files: string | number; file_bytes: string | number; version_bytes: string | number }>(
    `SELECT (SELECT count(*) FROM app.files WHERE owner_person_id = $1) AS files,
            (SELECT coalesce(sum(size), 0) FROM app.files WHERE owner_person_id = $1) AS file_bytes,
            (SELECT coalesce(sum(size), 0) FROM app.file_versions WHERE owner_person_id = $1) AS version_bytes`,
    [personId],
  );
  const r = res.rows[0];
  return {
    usedBytes: Number(r?.file_bytes ?? 0) + Number(r?.version_bytes ?? 0),
    quotaBytes: personalQuotaBytes(),
    fileCount: Number(r?.files ?? 0),
  };
}

/** Serialises the allowance check and the write of one person (two uploads at once cannot both pass on the same free space). */
export async function lockAllowance(tx: PluginTx, personId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20))', [`personal-files:${personId}`]);
}

/** The path and its parents, each made if missing: `a/b/c` makes `a`, `a/b`, `a/b/c`. */
export async function ensureFolder(ctx: PluginContext, tx: PluginTx, member: Member, path: string): Promise<void> {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    await ctx.db.getOneOrCreate(tx, {
      table: 'app.personal_folders',
      values: { workspace_id: member.workspaceId, owner_person_id: member.personId, path: parts.slice(0, i).join('/') },
      conflict: ['owner_person_id', 'path'],
      returning: ['id'],
    });
  }
}

/** The seven starting folders, made the first time a person's tree is read. */
export async function seedFolders(ctx: PluginContext, tx: PluginTx, member: Member): Promise<void> {
  const any = await tx.query('SELECT 1 FROM app.personal_folders WHERE owner_person_id = $1 LIMIT 1', [member.personId]);
  if (any.rows.length > 0) return;
  for (const name of PERSONAL_SEED_FOLDERS) await ensureFolder(ctx, tx, member, name);
}

export const isSeedFolder = (path: string): boolean => (PERSONAL_SEED_FOLDERS as readonly string[]).includes(path);

const MEMORY_DIR = 'Memory';
const managedBy = (path: string): FilesManagedBy | null => (path === MEMORY_DIR || path.startsWith(`${MEMORY_DIR}/`) ? 'personal_memory' : null);

const byKindThenName = (a: FilesTreeEntry, b: FilesTreeEntry): number =>
  a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'folder' ? -1 : 1;

/**
 * One folder of a person's space as a tree answer. `ownerId` is the person whose space it is; `readOnly` is true when someone else looks (an admin
 * during an open). The caller has already decided that they may look: the database still filters every row by the same rule.
 */
export async function listTree(
  tx: PluginTx,
  ownerId: string,
  path: string,
  limit: number,
  view: { readOnly: boolean },
): Promise<GetFilesTreeResponse> {
  const folders = (await tx.query<{ path: string }>('SELECT path FROM app.personal_folders WHERE owner_person_id = $1 ORDER BY path', [ownerId])).rows.map((r) => r.path);
  if (path !== '' && !folders.includes(path)) throw notFound('That folder does not exist');
  const reason: FilesReadOnlyReason | null = view.readOnly ? 'admin_view' : null;
  // The newest change below each folder (a folder's own files and everything under it).
  const stamps = (
    await tx.query<{ folder_path: string; at: Date }>(
      'SELECT folder_path, max(coalesce(updated_at, created_at)) AS at FROM app.files WHERE owner_person_id = $1 GROUP BY folder_path',
      [ownerId],
    )
  ).rows;
  const prefix = path === '' ? '' : `${path}/`;
  const entries: FilesTreeEntry[] = [];
  const seen = new Set<string>();
  for (const f of folders) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    if (rest === '' || rest.includes('/') || seen.has(f)) continue;
    seen.add(f);
    let newest: Date | null = null;
    for (const s of stamps) {
      const sf = wireFolder(s.folder_path);
      if ((sf === f || sf.startsWith(`${f}/`)) && (newest === null || s.at > newest)) newest = s.at;
    }
    entries.push(
      FilesTreeEntry.parse({
        kind: 'folder',
        path: f,
        name: rest,
        size: null,
        mime: null,
        updatedAt: newest ? newest.toISOString() : null,
        updatedBy: null,
        source: 'attachment',
        readOnly: view.readOnly,
        readOnlyReason: reason,
        managedBy: managedBy(f),
        fileId: null,
        channelId: null,
        blobSha: null,
        contentUrl: null,
      }),
    );
  }
  if (path !== '') {
    const files = (
      await tx.query<PersonalFileRow>(
        `SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.owner_person_id = $1 AND f.folder_path = $2 ORDER BY f.name COLLATE "C", f.id LIMIT $3`,
        [ownerId, dbFolder(path), limit + 1],
      )
    ).rows;
    for (const r of files) {
      entries.push(
        FilesTreeEntry.parse({
          kind: 'file',
          path: `${path}/${r.name}`,
          name: r.name,
          size: Number(r.size),
          mime: r.mime,
          updatedAt: (r.updated_at ?? r.created_at).toISOString(),
          updatedBy: r.updated_by ?? r.uploader_id,
          source: 'attachment',
          readOnly: view.readOnly,
          readOnlyReason: reason,
          managedBy: managedBy(path),
          fileId: r.id,
          channelId: null,
          blobSha: null,
          contentUrl: `/api/files/${r.id}/content`,
        }),
      );
    }
  }
  entries.sort(byKindThenName);
  const truncated = entries.length > limit;
  return GetFilesTreeResponse.parse({
    path,
    folder: { path, source: 'attachment', readOnly: view.readOnly, readOnlyReason: reason, managedBy: managedBy(path), channelId: null },
    entries: truncated ? entries.slice(0, limit) : entries,
    truncated,
  });
}

/** A Personal file the caller owns, or 403/404: another person's file (an admin's open included) is never changed through the `/api/me` routes. */
export async function requireOwnFile(tx: PluginTx, member: Member, fileId: string, lock = false): Promise<PersonalFileRow> {
  const res = await tx.query<PersonalFileRow>(
    `SELECT ${PERSONAL_FILE_COLUMNS} FROM app.files f WHERE f.id = $1${lock ? ' FOR UPDATE OF f' : ''}`,
    [fileId],
  );
  const row = res.rows[0];
  if (!row) throw forbidden();
  if (row.owner_person_id !== member.personId) throw forbidden('That file is not in your Personal files');
  return row;
}

export const nameTaken = (): ReturnType<typeof conflict> => conflict('A file with that name is already in that folder');
