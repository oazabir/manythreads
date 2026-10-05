import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetBotResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  ListBotsResponse,
  botMdPath,
  commitRepoRoute,
  getBotRoute,
  getRepoBlobRoute,
  listBotsRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Bots screens ask of the server (PLAN P5-05). Two reads over the bots plugin — the roster and one bot — plus the definition
 * itself, which is a file of the team repo: read through `repo/blob`, written through `repo/commit` with the blob that was read
 * (`baseBlobSha`). That is deliberate: the editor inherits the repo writer's own rules, so a team lead or a workspace admin commits an
 * existing `bots/` file directly and a member's save is refused with 403 — the page then offers a pull request, exactly as the Files screen does.
 */

export const fetchBots = (slug: string) => call(listBotsRoute, { response: ListBotsResponse }, undefined, { slug });

export const fetchBot = (slug: string, botSlug: string) => call(getBotRoute, { response: GetBotResponse }, undefined, { slug, botSlug });

/** The definition file as the loader reads it: the text and the blob a save must be based on. */
export type DefinitionFile = { content: string; blobSha: string; commitSha: string };

export async function readDefinition(slug: string, path: string): Promise<DefinitionFile> {
  const b = await call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path }), { slug });
  return { content: b.encoding === 'utf8' ? b.content : new TextDecoder().decode(Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0))), blobSha: b.blobSha, commitSha: b.commitSha };
}

/**
 * One commit with the whole file, as the signed-in person. `baseBlobSha` is the blob the page read: a file someone else changed in the
 * meantime is refused with 409 and nothing is overwritten. `noop` means the bytes were already there (no commit, no event).
 */
export async function writeDefinition(slug: string, path: string, content: string, baseBlobSha: string | null, message: string): Promise<{ sha: string; noop: boolean; blobSha: string | null }> {
  const res = await call(
    commitRepoRoute,
    { request: CommitRepoRequest, response: CommitRepoResponse },
    CommitRepoRequest.parse({ changes: [{ op: 'put', path, content, encoding: 'utf8', baseBlobSha }], message }),
    { slug },
  );
  return { sha: res.sha, noop: res.noop, blobSha: res.paths.find((p) => p.path === path)?.blobSha ?? null };
}

export { botMdPath };