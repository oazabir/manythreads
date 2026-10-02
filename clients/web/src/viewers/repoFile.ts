import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  commitRepoRoute,
  getRepoBlobRoute,
} from '@manythreads/shared';
import { call, isApiError } from '../api/client';
import { ContentError, type ContentSource } from './source';

/** A file of the team repo as the viewers see it: its content, and a save that is one commit by the signed-in person. */
export type RepoFile = { source: ContentSource; save: (text: string) => Promise<void> };

const base64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * `GET /api/teams/:slug/repo/blob` to read, `POST /api/teams/:slug/repo/commit` with a `put` carrying the blob that was read
 * (`baseBlobSha`) to save: if someone else changed the file meanwhile, the commit is refused and nothing is overwritten.
 */
export function repoFile(slug: string, path: string): RepoFile {
  let blob: Promise<GetRepoBlobResponse> | undefined;
  let blobSha: string | null | undefined;
  const read = (): Promise<GetRepoBlobResponse> => {
    blob ??= call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path }), { slug }).then(
      (b) => {
        blobSha = b.blobSha;
        return b;
      },
      (err: unknown) => {
        blob = undefined;
        if (isApiError(err)) throw new ContentError(err.status, err.status === 403 ? 'You do not have access to this file.' : err.status === 404 ? 'This file no longer exists.' : err.message);
        throw err;
      },
    );
    return blob;
  };
  const source: ContentSource = {
    // the repo holds text; a media element has nothing to load from here (attachments are served by the files plugin)
    url: '',
    text: async () => {
      const b = await read();
      return b.encoding === 'utf8' ? b.content : new TextDecoder().decode(base64ToBytes(b.content));
    },
    bytes: async () => {
      const b = await read();
      return b.encoding === 'base64' ? base64ToBytes(b.content) : new TextEncoder().encode(b.content);
    },
  };
  const save = async (text: string): Promise<void> => {
    if (blobSha === undefined) await read();
    try {
      const res = await call(
        commitRepoRoute,
        { request: CommitRepoRequest, response: CommitRepoResponse },
        { changes: [{ op: 'put', path, content: text, encoding: 'utf8', baseBlobSha: blobSha ?? null }], message: `Edit ${path}` },
        { slug },
      );
      const written = res.paths.find((p) => p.path === path);
      if (written) blobSha = written.blobSha;
    } catch (err) {
      if (isApiError(err) && err.code === 'conflict') throw new Error('Someone changed this file while you were editing. Reload it to see their version; nothing was overwritten.');
      if (isApiError(err) && err.code === 'forbidden') throw new Error('You cannot change this file here. Changes to it go by pull request.');
      throw err;
    }
  };
  return { source, save };
}
