import type {
  CopyPersonalFileToTeamRequest,
  CopyPersonalFileToTeamResponse,
  FilesTreeEntry,
  GetFilesTreeResponse,
  PersonalFile,
  PersonalFileVersion,
  PersonalFilesUsage,
  PersonalShareCheckRequest,
  PersonalShareCheckResponse,
  PersonalShareDestination,
  UpdatePersonalFileRequest,
} from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { isMockMode } from '../../api/setup';
import { uploadInboxFile } from '../memory/inboxApi';
import { httpSource } from '../../viewers/source';
import { FilesError, type FileContent, type FilesBackend, type Perms } from './backend';
import { lineDiff } from './diff';
import { baseName, isTextual, parentOf, type Actor, type Commit, type FileDiff, type FileRow, type Listing } from './model';
import * as api from './personalApi';
import { mockPersonalTransport } from './personalMock';

/*
 * A person's own files as a Files store. Everything the screen asks is answered from `/api/me/files/*` (the shared contract, P20-02): the tree, uploads,
 * rename and move, delete, folders, the versions of a file and the allowance. The wire is a `PersonalTransport`, so the real server and the `?mock=1` store
 * (and the unit tests) sit behind the same logic.
 */

/** The id of the "current content" entry in a file's version list (the server gives it `id: null`). */
export const CURRENT_VERSION = 'current';

/** What leaves the page: the server in production, an in-memory store in `?mock=1` and in tests. */
export interface PersonalTransport {
  tree(path: string): Promise<GetFilesTreeResponse & { validUntil?: string; displayName?: string }>;
  upload(folderPath: string, file: File, conflict: 'rename' | 'version', onProgress: (fraction: number) => void): Promise<PersonalFile>;
  patch(fileId: string, body: UpdatePersonalFileRequest): Promise<PersonalFile>;
  remove(fileId: string): Promise<void>;
  makeFolder(path: string): Promise<void>;
  removeFolder(path: string): Promise<void>;
  versions(fileId: string): Promise<PersonalFileVersion[]>;
  restore(fileId: string, versionId: string): Promise<PersonalFile>;
  usage(): Promise<PersonalFilesUsage>;
  check(fileId: string, body: PersonalShareCheckRequest): Promise<PersonalShareCheckResponse>;
  copy(fileId: string, body: CopyPersonalFileToTeamRequest): Promise<CopyPersonalFileToTeamResponse>;
  /** The text of a file or of one of its versions. */
  text(url: string): Promise<string>;
  /** Drops a copy of a file into a team's memory inbox as the signed-in person. */
  drop(row: FileRow, teamSlug: string): Promise<void>;
}

/** What only a Personal store can do besides the common store calls. */
export interface PersonalOps {
  usage(): Promise<PersonalFilesUsage>;
  /** What the workspace's data rules say about sending this file to a team (nothing is sent). */
  shareCheck(row: FileRow, destination: PersonalShareDestination, teamSlug: string): Promise<PersonalShareCheckResponse>;
  /** A text file into a team's files, as a commit by the caller. */
  copyToTeam(row: FileRow, teamSlug: string, path: string): Promise<CopyPersonalFileToTeamResponse>;
  /** A copy into a team's memory inbox. */
  sendToInbox(row: FileRow, teamSlug: string): Promise<void>;
  /** An admin's read-only view: who it is, and when the open lapses (null until the first listing arrives). */
  admin: (() => { displayName: string; validUntil: string } | null) | null;
}

export type PersonalBackend = FilesBackend & { personal: PersonalOps };

const guess = (name: string): string => (/\.md$/i.test(name) ? 'text/markdown' : /\.csv$/i.test(name) ? 'text/csv' : 'text/plain');

function refuse(err: unknown): never {
  if (isApiError(err)) {
    if (err.status === 409) throw new FilesError('exists', err.message || 'Something with that name is already here.');
    if (err.status === 403) throw new FilesError('forbidden', err.message || 'You cannot change this here.');
    if (err.status === 413) throw new FilesError('other', api.tooLargeWords(err.message));
    throw new FilesError('other', err.message);
  }
  throw err;
}

/**
 * What tells one state of a Personal file from the next. The tree carries no blob sha for a Personal file (that is a git word), so the row holds the time of its
 * last change and its size: a restore, an upload of a new version or a save from another page changes it, and the open viewer reads the file again.
 */
export const personalStamp = (updatedAt: string | null, size: number | null): string | null => (updatedAt === null ? null : `${updatedAt}|${String(size ?? 0)}`);

export function toPersonalRow(e: FilesTreeEntry, perms: Perms): FileRow {
  return {
    path: e.path,
    name: e.name,
    kind: e.kind,
    store: 'personal',
    size: e.size,
    mime: e.mime,
    modifiedAt: e.updatedAt,
    by: perms.who(e.updatedBy),
    where: null,
    readOnly: e.readOnly,
    readOnlyReason: e.readOnlyReason,
    managedBy: e.managedBy,
    fileId: e.fileId,
    channelId: null,
    blobSha: e.kind === 'file' ? personalStamp(e.updatedAt, e.size) : e.blobSha,
    contentUrl: e.contentUrl,
  };
}

export function createPersonalBackend(transport: PersonalTransport, perms: Perms, opts: { admin?: boolean } = {}): PersonalBackend {
  let meta: { displayName: string; validUntil: string } | null = null;
  const versionUrls = new Map<string, string>();

  const self: PersonalBackend = {
    async list(folder): Promise<Listing> {
      const res = await transport.tree(folder);
      if (res.validUntil && res.displayName) meta = { displayName: res.displayName, validUntil: res.validUntil };
      return {
        path: res.path,
        folder: { path: res.folder.path, store: 'personal', readOnly: res.folder.readOnly, readOnlyReason: res.folder.readOnlyReason, managedBy: res.folder.managedBy, channelId: null },
        rows: res.entries.map((e) => toPersonalRow(e, perms)),
        truncated: res.truncated,
      };
    },
    async stat(path) {
      const dir = await self.list(parentOf(path));
      return dir.rows.find((r) => r.path === path) ?? null;
    },
    statById: () => Promise.resolve(null),
    open(row): FileContent {
      let sha = row.blobSha;
      const url = `${row.contentUrl ?? ''}${row.contentUrl && !row.contentUrl.startsWith('data:') ? `?v=${encodeURIComponent(row.blobSha ?? '')}` : ''}`;
      const source = row.contentUrl ? httpSource(url) : httpSource('');
      return {
        source,
        save:
          row.readOnly || !isTextual(row)
            ? null
            : async (text) => {
                try {
                  const saved = await transport.upload(row.path.includes('/') ? parentOf(row.path) : '', new File([text], row.name, { type: row.mime || guess(row.name) }), 'version', () => undefined);
                  sha = personalStamp(saved.updatedAt, saved.size);
                } catch (err) {
                  refuse(err);
                }
              },
        sha: () => sha,
      };
    },
    async history(path) {
      const row = await self.stat(path);
      if (!row?.fileId) return [];
      const items = await transport.versions(row.fileId);
      return items.map((v, i): Commit => {
        const id = v.id ?? CURRENT_VERSION;
        versionUrls.set(`${path}@${id}`, v.contentUrl);
        const author: Actor | null = perms.who(v.authorId);
        return {
          sha: id,
          parentSha: items[i + 1] ? (items[i + 1]?.id ?? CURRENT_VERSION) : null,
          author,
          coAuthors: [],
          subject: v.current ? 'Current version' : 'Earlier version',
          message: v.current ? 'Current version' : 'Earlier version',
          committedAt: v.createdAt,
          change: null,
        };
      });
    },
    async diff(path, commit): Promise<FileDiff> {
      const row = await self.stat(path);
      if (!row || !isTextual(row)) return { status: 'modified', binary: true, additions: 0, deletions: 0, hunks: [], truncated: false };
      const read = async (sha: string | null): Promise<string | null> => {
        const url = sha === null ? undefined : versionUrls.get(`${path}@${sha}`);
        return url ? transport.text(url) : null;
      };
      return lineDiff(await read(commit.parentSha), await read(commit.sha));
    },
    async version(path, sha) {
      if (sha === null) return null;
      const url = versionUrls.get(`${path}@${sha}`);
      return url ? transport.text(url) : null;
    },
    async restore(path, commit) {
      const row = await self.stat(path);
      if (!row?.fileId) throw new FilesError('other', 'That version cannot be restored.');
      if (commit.sha === CURRENT_VERSION) return;
      try {
        await transport.restore(row.fileId, commit.sha);
      } catch (err) {
        refuse(err);
      }
    },
    async create(path, text) {
      if (await self.stat(path)) throw new FilesError('exists', 'Something with that name is already here.');
      try {
        await transport.upload(parentOf(path), new File([text], baseName(path), { type: guess(path) }), 'rename', () => undefined);
      } catch (err) {
        refuse(err);
      }
    },
    async createFolder(path) {
      try {
        await transport.makeFolder(path);
      } catch (err) {
        refuse(err);
      }
    },
    async move(row, to) {
      if (!row.fileId) throw new FilesError('unsupported', 'This item cannot be moved.');
      const body: { name?: string; folderPath?: string } = {};
      if (baseName(to) !== row.name) body.name = baseName(to);
      if (parentOf(to) !== parentOf(row.path)) body.folderPath = parentOf(to);
      if (body.name === undefined && body.folderPath === undefined) return;
      try {
        await transport.patch(row.fileId, body as UpdatePersonalFileRequest);
      } catch (err) {
        refuse(err);
      }
    },
    async remove(row) {
      try {
        if (row.kind === 'folder') await transport.removeFolder(row.path);
        else if (row.fileId) await transport.remove(row.fileId);
      } catch (err) {
        if (row.kind === 'folder' && isApiError(err) && err.status === 409) throw new FilesError('conflict', err.message || 'Only an empty folder can be removed.');
        refuse(err);
      }
    },
    async upload(folder, file, onProgress) {
      if (folder.path === '') throw new FilesError('other', 'Open a folder first: files in Personal live inside a folder.');
      try {
        await transport.upload(folder.path, file, 'rename', onProgress);
      } catch (err) {
        refuse(err);
      }
    },
    personal: {
      usage: () => transport.usage(),
      shareCheck: (row, destination, teamSlug) => {
        if (!row.fileId) return Promise.reject(new FilesError('unsupported', 'Only a file can be sent to a team.'));
        return transport.check(row.fileId, { destination, teamSlug });
      },
      copyToTeam: async (row, teamSlug, path) => {
        if (!row.fileId) throw new FilesError('unsupported', 'Only a file can be copied to a team.');
        try {
          return await transport.copy(row.fileId, { teamSlug, path });
        } catch (err) {
          return refuse(err);
        }
      },
      sendToInbox: async (row, teamSlug) => {
        try {
          await transport.drop(row, teamSlug);
        } catch (err) {
          refuse(err);
        }
      },
      admin: opts.admin ? () => meta : null,
    },
  };
  return self;
}

/** The real thing: your own space, or (with `personId`) an admin's read-only look into someone's. */
export function serverTransport(personId?: string): PersonalTransport {
  return {
    tree: (path) => (personId ? api.fetchPersonTree(personId, path) : api.fetchMyTree(path)),
    upload: api.uploadPersonalFile,
    patch: (id, body) => api.patchPersonalFile(id, body),
    remove: async (id) => void (await api.removePersonalFile(id)),
    makeFolder: async (path) => void (await api.makePersonalFolder(path)),
    removeFolder: async (path) => void (await api.removePersonalFolder(path)),
    versions: async (id) => (await api.fetchVersions(id)).items,
    restore: api.restoreVersion,
    usage: api.fetchUsage,
    check: api.checkShare,
    copy: api.copyToTeam,
    text: (url) => httpSource(url).text(),
    drop: async (row, teamSlug) => {
      const res = await fetch(row.contentUrl ?? '', { credentials: 'same-origin' });
      if (!res.ok) throw new FilesError('other', 'The file could not be read.');
      const file = new File([await res.blob()], row.name, { type: row.mime ?? 'application/octet-stream' });
      await uploadInboxFile(teamSlug, file, false, () => undefined);
    },
  };
}

/** The Personal store of this page load. */
export function createPersonal(perms: Perms, opts: { personId?: string } = {}): PersonalBackend {
  const transport = isMockMode() ? mockPersonalTransport(perms, opts.personId !== undefined) : serverTransport(opts.personId);
  return createPersonalBackend(transport, perms, opts.personId ? { admin: true } : {});
}
