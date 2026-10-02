import type { PluginTx, ProviderImpl } from './types.ts';

// The team repo as other plugins see it (SPEC section 5.1; PLAN P4-02): `ctx.providers.get<RepoProvider>('repo')`, registered by repo-git. Look it up
// when a request arrives, not in `register` (repo-git may load after you). Every change to a team repo goes through `write`: one writer per team, a
// commit per call with the actor as author, the writer rules of docs/plugins/repo-git.md applied. Failures reject with an `Error` that carries
// `status` (400, 403, 404, 409, 413, 422), `code` (an `ErrorCode`) and, on a 409, `conflicts` (each path with the current content).

/** Who commits. Must be the actor of the transaction (`tx.actor`): a caller cannot commit as somebody else. */
export interface RepoWriteActor {
  id: string;
  kind: 'person' | 'bot' | 'system';
  /** The name on the commit's author line; a person's is read from the directory when absent. */
  name?: string;
}

/** A contributor who gets a `Co-authored-by` trailer (every editor of a page that was edited live). */
export interface RepoCommitIdentity {
  actorId: string;
  name: string;
}

/**
 * One change. `baseBlobSha` is the blob the caller edited: if the file now holds another, the whole write is refused (409, nothing written) with the
 * current content; `null` means "must not exist yet"; left out means the last write wins. `append` adds to the end of the file and creates it.
 * Content is text (a string, or UTF-8 bytes); anything with a NUL byte in its first 8 KB, or over 1 MB, is refused with 422 `attachment_not_in_repo`.
 */
export type RepoWriteChange =
  | { path: string; op: 'put'; content: string | Uint8Array; baseBlobSha?: string | null }
  | { path: string; op: 'append'; content: string | Uint8Array }
  | { path: string; op: 'delete'; baseBlobSha?: string | null };

export interface RepoWriteResult {
  /** The new commit; the unchanged head when `noop`. */
  sha: string;
  parentSha: string | null;
  /** The changes left the tree as it was: no commit, no event. */
  noop: boolean;
  /** The actor id of the author; null for a commit the system made. */
  authorId: string | null;
  paths: { path: string; op: 'put' | 'delete'; blobSha: string | null; size: number | null }[];
}

/**
 * How a write is authorized for a bot. Default: the broker's `files.write` (`files.delete` for a delete) for every path. A plugin that offers the write under
 * its own capability (`pages.write`) says so here: the bot then needs that grant instead of `files.write`. The broker's path guard applies either way, and a
 * delete is always `files.delete`. Ignored for people (team role) and the system.
 */
export interface RepoWriteOptions {
  capability?: 'files.write' | 'pages.write';
}

export interface RepoBlob {
  commitSha: string;
  sha: string;
  size: number;
  content: Uint8Array;
}

export interface RepoTreeListing {
  commitSha: string;
  entries: { name: string; path: string; type: 'blob' | 'tree'; sha: string; size: number | null }[];
}

/** One row of a folder listing, straight from the index: a file with its last change, or a folder with the newest change below it. */
export interface RepoFolderEntry {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  /** The blob of a file; null for a folder. */
  blobSha: string | null;
  size: number | null;
  /** The commit time of the last change (a folder: the newest below it). */
  updatedAt: string | null;
  /** The actor of that commit; null for a system commit. */
  updatedBy: string | null;
}

export interface RepoProvider extends ProviderImpl {
  /** Commit `changes` to the team's repo as `actor`, in `tx` (the index and the `repo.repo.committed` event are written in the same transaction). */
  write(
    tx: PluginTx,
    teamId: string,
    actor: RepoWriteActor,
    changes: readonly RepoWriteChange[],
    message: string,
    coAuthors?: readonly RepoCommitIdentity[],
    options?: RepoWriteOptions,
  ): Promise<RepoWriteResult>;
  /** Put `path` back as it was at commit `sha`, as a new commit; the old commits stay. */
  restore(tx: PluginTx, teamId: string, actor: RepoWriteActor, path: string, sha: string, coAuthors?: readonly RepoCommitIdentity[], message?: string): Promise<RepoWriteResult>;
  /** The files and folders directly below `path` ('' is the root) from the index, with who changed them last and when. `.gitkeep` placeholders are not listed. */
  list(tx: PluginTx, teamId: string, path: string): Promise<RepoFolderEntry[]>;
  /** One file at `ref` (`main`, `HEAD` or a commit sha). Rejects 404 when it does not exist, 413 over `maxBytes` (default 1 MB). */
  blob(tx: PluginTx, teamId: string, path: string, ref: string, maxBytes?: number): Promise<RepoBlob>;
  /** The folders and files directly below `path` ('' is the root) at `ref`. */
  tree(tx: PluginTx, teamId: string, path: string, ref: string): Promise<RepoTreeListing>;
}
