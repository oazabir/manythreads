import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetFilesTreeQuery,
  GetFilesTreeResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  GetRepoDiffQuery,
  GetRepoDiffResponse,
  GetRepoHistoryQuery,
  GetRepoHistoryResponse,
  RestoreRepoFileRequest,
  RestoreRepoFileResponse,
  WritePageRequest,
  WritePageResponse,
  commitRepoRoute,
  getFilesTreeRoute,
  getRepoBlobRoute,
  getRepoDiffRoute,
  getRepoHistoryRoute,
  restoreRepoFileRoute,
  writePageRoute,
  isGuardedRepoPath,
  type FilesTreeEntry,
  type RepoChange,
} from '@manythreads/shared';
import { ApiError, call, isApiError } from '../../api/client';
import { deleteAttachment, fetchFileMeta, fetchNavChannels, fileContentUrl, uploadChannelFile } from '../../api/endpoints';
import { isMockMode } from '../../api/setup';
import { httpSource, type ContentSource } from '../../viewers/source';
import { repoFile } from '../../viewers/repoFile';
import { mockBackend } from './mockBackend';
import { baseName, channelNameOf, parentOf, type Actor, type Commit, type FileDiff, type FileRow, type Listing } from './model';

/** What the signed-in person may do in this team; the server enforces it again on every write. */
export type Perms = {
  /** A team lead or workspace admin: may change bots/, skills/, routines/ and TEAM.md directly. */
  leadsTeam: boolean;
  /** The person's own name and id: the author of commits made here. */
  personName: string;
  personId: string;
  /** Who an actor id is, from the team's roster; an actor the roster does not know is shown as a bot. */
  who: (actorId: string | null) => Actor | null;
};

/** The content of one file: what the viewers read and how a save becomes a commit. */
export type FileContent = {
  source: ContentSource;
  save: ((text: string) => Promise<void>) | null;
  /** The blob the content was read from or last saved as; lets the screen tell its own save from a change made elsewhere (a restore). */
  sha?: () => string | null | undefined;
};

/** Everything the Files screen asks of a store. One implementation talks to the server; another serves `?mock=1`. */
export interface FilesBackend {
  list(folder: string): Promise<Listing>;
  /** One row by path (its parent folder's listing). */
  stat(path: string): Promise<FileRow | null>;
  /** One attachment by file id (`?panel=file:<id>` from a link in a message). */
  statById(fileId: string): Promise<FileRow | null>;
  open(row: FileRow): FileContent;
  history(path: string): Promise<Commit[]>;
  diff(path: string, commit: Commit): Promise<FileDiff>;
  /** The text of a file as of a commit (null: it did not exist then, or is not text). */
  version(path: string, sha: string | null): Promise<string | null>;
  restore(path: string, commit: Commit, message: string): Promise<void>;
  /** A new text file (a page); refuses a path that exists. */
  create(path: string, text: string): Promise<void>;
  /** Git holds no empty folder: a new folder is its first file. */
  createFolder(path: string): Promise<void>;
  /** Rename or move one file (one commit with the delete and the put). Attachments keep their name and place. */
  move(row: FileRow, to: string): Promise<void>;
  remove(row: FileRow): Promise<void>;
  /** Attachments go to a channel folder; text goes to a git folder as a commit; anything else is refused with `text_only`. */
  upload(folder: { path: string; channelId: string | null }, file: File, onProgress: (fraction: number) => void): Promise<void>;
}

/** Thrown for a refusal the screen words itself. */
export class FilesError extends Error {
  constructor(readonly code: 'text_only' | 'conflict' | 'forbidden' | 'exists' | 'unsupported' | 'other', message: string) {
    super(message);
    this.name = 'FilesError';
  }
}

/** The bytes look like text the repo accepts: no NUL byte in the first 8 KB, at most 1 MB. */
export async function looksLikeText(file: File): Promise<boolean> {
  if (file.size > 1_048_576) return false;
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  return !head.includes(0);
}

const KEEP = '.gitkeep';
const sha7 = (sha: string): string => sha.slice(0, 7);

/** The flags every row of the team repo carries, computed the way the server does (the mock and the fallback use it). */
export function repoRowFlags(path: string, perms: Pick<Perms, 'leadsTeam'>): Pick<FileRow, 'readOnly' | 'readOnlyReason' | 'managedBy'> {
  const guarded = isGuardedRepoPath(path) && !perms.leadsTeam;
  return {
    readOnly: guarded,
    readOnlyReason: guarded ? 'change_by_pull_request' : null,
    managedBy: path === 'memory' || path.startsWith('memory/') ? 'team_memory' : null,
  };
}

function refuse(err: unknown, exists = false): never {
  if (isApiError(err)) {
    if (err.code === 'attachment_not_in_repo') throw new FilesError('text_only', err.message);
    if (err.code === 'conflict') {
      throw exists
        ? new FilesError('exists', 'Something with that name is already here.')
        : new FilesError('conflict', 'Someone changed this while you were working. Reload it to see their version; nothing was overwritten.');
    }
    if (err.code === 'forbidden' || err.status === 403) throw new FilesError('forbidden', 'You cannot change this here. Changes to it go by pull request.');
    throw new FilesError('other', err.message);
  }
  throw err;
}

async function commit(slug: string, changes: RepoChange[], message: string, exists = false): Promise<CommitRepoResponse> {
  try {
    return await call(commitRepoRoute, { request: CommitRepoRequest, response: CommitRepoResponse }, CommitRepoRequest.parse({ changes, message }), { slug });
  } catch (err) {
    return refuse(err, exists);
  }
}

function toRow(e: FilesTreeEntry, perms: Perms): FileRow {
  const attachment = e.source === 'attachment';
  const channel = channelNameOf(e.path);
  return {
    path: e.path,
    name: e.name,
    kind: e.kind,
    store: attachment ? 'attachments' : 'git',
    size: e.size,
    mime: e.mime,
    modifiedAt: e.updatedAt,
    by: perms.who(e.updatedBy),
    where: attachment && channel ? `# ${channel}` : null,
    readOnly: e.readOnly,
    readOnlyReason: e.readOnlyReason,
    managedBy: e.managedBy,
    fileId: e.fileId,
    channelId: e.channelId,
    blobSha: e.blobSha,
    contentUrl: e.contentUrl,
  };
}

/** The server: one tree over the team repo and the channels' attachments, history over git, uploads over the files routes. */
export function serverBackend(slug: string, perms: Perms): FilesBackend {
  const channelIds = new Map<string, string>();
  const channelIdOf = async (name: string): Promise<string | null> => {
    const known = channelIds.get(name);
    if (known) return known;
    const dir = await fetchNavChannels(slug);
    for (const g of dir.groups) for (const c of g.channels) channelIds.set(c.name.replace(/^#/, ''), c.id);
    return channelIds.get(name) ?? null;
  };
  const people = (id: string | null): Actor | null => perms.who(id);

  const self: FilesBackend = {
    async list(folder) {
      const res = await call(getFilesTreeRoute, { request: GetFilesTreeQuery, response: GetFilesTreeResponse }, GetFilesTreeQuery.parse({ path: folder }), { slug });
      return {
        path: res.path,
        folder: { path: res.folder.path, store: res.folder.source === 'repo' ? 'git' : 'attachments', readOnly: res.folder.readOnly, readOnlyReason: res.folder.readOnlyReason, managedBy: res.folder.managedBy, channelId: res.folder.channelId },
        rows: res.entries.filter((e) => e.name !== KEEP).map((e) => toRow(e, perms)),
        truncated: res.truncated,
      };
    },
    async stat(path) {
      const dir = await self.list(parentOf(path));
      return dir.rows.find((r) => r.path === path) ?? null;
    },
    async statById(fileId) {
      try {
        const m = await fetchFileMeta(fileId);
        const channel = channelNameOf(m.folderPath);
        return {
          path: `${m.folderPath}${m.name}`, name: m.name, kind: 'file', store: 'attachments', size: m.size, mime: m.mime, modifiedAt: m.createdAt, by: perms.who(m.uploaderId),
          where: channel ? `# ${channel}` : null, readOnly: true, readOnlyReason: 'attachment', managedBy: null, fileId: m.id, channelId: m.channelId, blobSha: null, contentUrl: fileContentUrl(m.id),
        };
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    open(r) {
      if (r.store === 'attachments') return { source: httpSource(r.contentUrl ?? ''), save: null };
      const file = repoFile(slug, r.path);
      return { source: r.contentUrl ? { ...file.source, url: r.contentUrl } : file.source, save: r.readOnly ? null : file.save, sha: file.sha };
    },
    async history(path) {
      const res = await call(getRepoHistoryRoute, { request: GetRepoHistoryQuery, response: GetRepoHistoryResponse }, GetRepoHistoryQuery.parse({ path, limit: 100 }), { slug });
      return res.commits.map(
        (c): Commit => ({
          sha: c.sha,
          parentSha: c.parentSha,
          author: c.authorId ? (people(c.authorId) ?? { id: c.authorId, name: c.authorName, kind: 'person' }) : { id: null, name: c.authorName, kind: 'system' },
          coAuthors: c.coAuthorIds.map((id) => people(id)).filter((a): a is Actor => a !== null),
          subject: c.subject,
          message: c.message,
          committedAt: c.committedAt,
          change: c.change,
        }),
      );
    },
    async diff(path, c) {
      const res = await call(getRepoDiffRoute, { request: GetRepoDiffQuery, response: GetRepoDiffResponse }, GetRepoDiffQuery.parse({ path, to: c.sha }), { slug });
      return { status: res.status, binary: res.binary, additions: res.additions, deletions: res.deletions, hunks: res.hunks.map((h) => ({ header: h.header, lines: h.lines })), truncated: res.truncated };
    },
    async version(path, sha) {
      if (sha === null) return null;
      try {
        const b = await call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path, ref: sha }), { slug });
        return b.encoding === 'utf8' ? b.content : null;
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    async restore(path, c, message) {
      try {
        await call(restoreRepoFileRoute, { request: RestoreRepoFileRequest, response: RestoreRepoFileResponse }, RestoreRepoFileRequest.parse({ path, sha: c.sha, message }), { slug });
      } catch (err) {
        refuse(err);
      }
    },
    async create(path, text) {
      if (path.startsWith('pages/')) {
        try {
          await call(writePageRoute, { request: WritePageRequest, response: WritePageResponse }, WritePageRequest.parse({ mode: 'create', path, content: text }), { slug });
        } catch (err) {
          refuse(err, true);
        }
        return;
      }
      await commit(slug, [{ op: 'put', path, content: text, encoding: 'utf8', baseBlobSha: null }], `Create ${path}`, true);
    },
    async createFolder(path) {
      await commit(slug, [{ op: 'put', path: `${path}/${KEEP}`, content: '', encoding: 'utf8', baseBlobSha: null }], `Create folder ${path}`, true);
    },
    async move(r, to) {
      if (r.store !== 'git') throw new FilesError('unsupported', 'Attachments keep the name and the folder they were posted with.');
      const text = await repoFile(slug, r.path).source.text();
      await commit(
        slug,
        [
          { op: 'put', path: to, content: text, encoding: 'utf8', baseBlobSha: null },
          { op: 'delete', path: r.path, ...(r.blobSha ? { baseBlobSha: r.blobSha } : {}) },
        ],
        parentOf(r.path) === parentOf(to) ? `Rename ${r.path} to ${baseName(to)}` : `Move ${r.path} to ${to}`,
        true,
      );
    },
    async remove(r) {
      if (r.store === 'attachments') {
        if (!r.fileId) throw new FilesError('unsupported', 'This attachment cannot be deleted from here.');
        try {
          await deleteAttachment(r.fileId);
        } catch (err) {
          refuse(err);
        }
        return;
      }
      await commit(slug, [{ op: 'delete', path: r.path, ...(r.blobSha ? { baseBlobSha: r.blobSha } : {}) }], `Delete ${r.path}`);
    },
    async upload(folder, file, onProgress) {
      const name = channelNameOf(folder.path);
      if (name !== null) {
        const channelId = folder.channelId ?? (await channelIdOf(name));
        if (!channelId) throw new FilesError('other', 'That channel could not be found.');
        try {
          await uploadChannelFile(channelId, file, onProgress);
        } catch (err) {
          if (err instanceof ApiError) throw new FilesError(err.status === 403 ? 'forbidden' : 'other', err.message);
          throw err;
        }
        return;
      }
      if (!(await looksLikeText(file))) throw new FilesError('text_only', 'text only');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new FilesError('text_only', 'text only');
      }
      const path = folder.path === '' ? file.name : `${folder.path}/${file.name}`;
      await commit(slug, [{ op: 'put', path, content: text, encoding: 'utf8', baseBlobSha: null }], `Add ${path}`, true);
      onProgress(1);
    },
  };
  return self;
}

/** The store for this page load: the mock in `?mock=1`, the server otherwise. */
export function createBackend(slug: string, perms: Perms): FilesBackend {
  return isMockMode() ? mockBackend(slug, perms) : serverBackend(slug, perms);
}

export { sha7 };
