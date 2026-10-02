import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetRepoTreeQuery,
  GetRepoTreeResponse,
  commitRepoRoute,
  getRepoTreeRoute,
  isGuardedRepoPath,
  type RepoChange,
} from '@manythreads/shared';
import { ApiError, call, isApiError } from '../../api/client';
import { fetchNavChannels, fileContentUrl, uploadChannelFile } from '../../api/endpoints';
import { isMockMode } from '../../api/setup';
import { httpSource, type ContentSource } from '../../viewers/source';
import { repoFile } from '../../viewers/repoFile';
import { mockBackend } from './mockBackend';
import { baseName, channelNameOf, isAttachmentPath, parentOf, type Commit, type CommitDiff, type FileRow, type Listing } from './model';

/** What the signed-in person may do in this team; the server enforces it again on every write. */
export type Perms = {
  /** A team lead or workspace admin: may change bots/, skills/, routines/ and TEAM.md directly. */
  leadsTeam: boolean;
  /** The person's own name: the author of commits made here. */
  personName: string;
  personId: string;
};

/** The content of one file: what the viewers read and how a save becomes a commit. */
export type FileContent = { source: ContentSource; save: ((text: string) => Promise<void>) | null };

/** Everything the Files screen asks of a store. One implementation talks to the server; another serves `?mock=1`. */
export interface FilesBackend {
  list(folder: string): Promise<Listing>;
  /** One row by path (its parent folder's listing, cached by the caller). */
  stat(path: string): Promise<FileRow | null>;
  open(row: FileRow): FileContent;
  history(path: string): Promise<Commit[]>;
  diff(path: string, sha: string): Promise<CommitDiff>;
  restore(path: string, sha: string): Promise<{ sha: string }>;
  /** A new text file (a page); refuses a path that exists. */
  create(path: string, text: string): Promise<void>;
  /** Git holds no empty folder: a new folder is its first file. */
  createFolder(path: string): Promise<void>;
  /** Rename or move one file (a commit with the delete and the put). Attachments keep their name and place. */
  move(row: FileRow, to: string): Promise<void>;
  remove(row: FileRow): Promise<void>;
  /** Attachments go to a channel folder; text goes to a git folder as a commit; anything else is refused with GIT_TEXT_ONLY. */
  upload(folder: FileRow | { path: string; channelId: string | null }, file: File, onProgress: (fraction: number) => void): Promise<void>;
}

/** Thrown for a refusal the screen words itself. */
export class FilesError extends Error {
  constructor(readonly code: 'text_only' | 'conflict' | 'forbidden' | 'exists' | 'unsupported' | 'other', message: string) {
    super(message);
    this.name = 'FilesError';
  }
}

/** The bytes look like text the repo accepts: UTF-8 with no NUL byte in the first 8 KB, at most 1 MB. */
export async function looksLikeText(file: File): Promise<boolean> {
  if (file.size > 1_048_576) return false;
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  return !head.includes(0);
}

const KEEP = '.gitkeep';

function row(over: Partial<FileRow> & Pick<FileRow, 'path' | 'kind'>): FileRow {
  return {
    name: baseName(over.path),
    store: 'git',
    size: null,
    mime: null,
    modifiedAt: null,
    by: null,
    where: null,
    readOnly: false,
    readOnlyReason: null,
    managedBy: null,
    fileId: null,
    channelId: null,
    messageId: null,
    ...over,
  };
}

/** The server-held parts of the contract that are the same for every row of the team repo. */
export function repoRowFlags(path: string, perms: Perms): Pick<FileRow, 'readOnly' | 'readOnlyReason' | 'managedBy'> {
  const guarded = isGuardedRepoPath(path) && !perms.leadsTeam;
  return {
    readOnly: guarded,
    readOnlyReason: guarded ? 'change_by_pull_request' : null,
    managedBy: path === 'memory' || path.startsWith('memory/') ? 'team_memory' : null,
  };
}

const refusal = (err: unknown): never => {
  if (isApiError(err)) {
    if (err.code === 'attachment_not_in_repo') throw new FilesError('text_only', err.message);
    if (err.code === 'conflict') throw new FilesError('conflict', 'Someone changed this while you were working. Reload it to see their version; nothing was overwritten.');
    if (err.code === 'forbidden' || err.status === 403) throw new FilesError('forbidden', 'You cannot change this here. Changes to it go by pull request.');
    throw new FilesError('other', err.message);
  }
  throw err;
};

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function commit(slug: string, changes: RepoChange[], message: string): Promise<CommitRepoResponse> {
  try {
    return await call(commitRepoRoute, { request: CommitRepoRequest, response: CommitRepoResponse }, CommitRepoRequest.parse({ changes, message }), { slug });
  } catch (err) {
    return refusal(err);
  }
}

/** The server: the team repo over its HTTP routes, attachments over the files routes. */
export function serverBackend(slug: string, perms: Perms): FilesBackend {
  const channelIds = new Map<string, string>();
  const channelIdOf = async (name: string): Promise<string | null> => {
    const known = channelIds.get(name);
    if (known) return known;
    const dir = await fetchNavChannels(slug);
    for (const g of dir.groups) for (const c of g.channels) channelIds.set(c.name.replace(/^#/, ''), c.id);
    return channelIds.get(name) ?? null;
  };

  const self: FilesBackend = {
    async list(folder) {
      const res = await call(getRepoTreeRoute, { request: GetRepoTreeQuery, response: GetRepoTreeResponse }, GetRepoTreeQuery.parse({ path: folder }), { slug });
      const rows = res.entries
        .filter((e) => e.name !== KEEP)
        .map((e) =>
          row({
            path: e.path,
            kind: e.kind === 'dir' ? 'folder' : 'file',
            size: e.size,
            ...repoRowFlags(e.path, perms),
          }),
        );
      return { path: folder, rows };
    },
    async stat(path) {
      const dir = await self.list(parentOf(path));
      return dir.rows.find((r) => r.path === path) ?? null;
    },
    open(r) {
      if (r.store === 'attachments' && r.fileId) return { source: httpSource(fileContentUrl(r.fileId)), save: null };
      const file = repoFile(slug, r.path);
      return { source: file.source, save: r.readOnly ? null : file.save };
    },
    async history() {
      throw new FilesError('unsupported', 'History is not available on this server yet.');
    },
    async diff() {
      throw new FilesError('unsupported', 'History is not available on this server yet.');
    },
    async restore() {
      throw new FilesError('unsupported', 'History is not available on this server yet.');
    },
    async create(path, text) {
      await commit(slug, [{ op: 'put', path, content: text, encoding: 'utf8', baseBlobSha: null }], `Create ${path}`);
    },
    async createFolder(path) {
      await commit(slug, [{ op: 'put', path: `${path}/${KEEP}`, content: '', encoding: 'utf8', baseBlobSha: null }], `Create folder ${path}`);
    },
    async move(r, to) {
      if (r.store !== 'git') throw new FilesError('unsupported', 'Attachments keep the name and the folder they were posted with.');
      const blob = await repoFile(slug, r.path).source.text();
      await commit(
        slug,
        [
          { op: 'put', path: to, content: blob, encoding: 'utf8', baseBlobSha: null },
          { op: 'delete', path: r.path },
        ],
        parentOf(r.path) === parentOf(to) ? `Rename ${r.path} to ${baseName(to)}` : `Move ${r.path} to ${to}`,
      );
    },
    async remove(r) {
      if (r.store === 'attachments') {
        if (!r.fileId) throw new FilesError('unsupported', 'This attachment cannot be deleted from here.');
        const { deleteAttachment } = await import('./attachments');
        await deleteAttachment(r.fileId);
        return;
      }
      await commit(slug, [{ op: 'delete', path: r.path }], `Delete ${r.path}`);
    },
    async upload(folder, file, onProgress) {
      const name = channelNameOf(folder.path);
      if (name !== null) {
        const channelId = ('channelId' in folder ? folder.channelId : null) ?? (await channelIdOf(name));
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const path = folder.path === '' ? file.name : `${folder.path}/${file.name}`;
      await commit(slug, [{ op: 'put', path, content: bytes.length === new TextEncoder().encode(text).length ? text : toBase64(bytes), encoding: bytes.length === new TextEncoder().encode(text).length ? 'utf8' : 'base64', baseBlobSha: null }], `Add ${path}`);
      onProgress(1);
    },
  };
  return self;
}

/** The store for this page load: the mock in `?mock=1`, the server otherwise. */
export function createBackend(slug: string, perms: Perms): FilesBackend {
  return isMockMode() ? mockBackend(slug, perms) : serverBackend(slug, perms);
}

export { isAttachmentPath };
