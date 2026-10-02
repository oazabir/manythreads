import { HttpError, type HttpResponse, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  GetRepoTreeQuery,
  GetRepoTreeResponse,
  RepoConflictResponse,
  RepoPathParams,
  commitRepoRoute,
  getRepoBlobRoute,
  getRepoTreeRoute,
} from '@manythreads/shared';
import { RepoError, repoForbidden, repoInvalid, repoNotFound } from './errors.ts';
import type { RepoService, RepoWriteChange } from './repo.ts';
import { textOf } from './rules.ts';

// HTTP for the team repo: tree, blob and commit (PLAN P4-01..P4-05). The Files tree, history and restore routes of P4-06 and P4-08 build on the service.

/** The team the caller may see; a team they cannot see is 403 (an admin sees every team, so for them a missing slug is 404). */
async function teamIdBySlug(tx: PluginTx, slug: string): Promise<string> {
  const res = await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug]);
  const id = res.rows[0]?.id;
  if (id) return id;
  const admin = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
  throw admin.rows[0]?.admin === true ? repoNotFound('Team not found') : repoForbidden('You are not a member of this team');
}

/**
 * A refusal as the response the client reads. Returned, not thrown: the transaction commits, which keeps a repository the request created
 * (its first commit is already in git). Nothing else was written when a request is refused.
 */
function refusal(err: RepoError): HttpResponse {
  if (err.status === 409 && err.conflicts.length > 0) {
    return { status: 409, body: RepoConflictResponse.parse({ error: { code: 'conflict', message: err.message }, conflicts: err.conflicts }) };
  }
  if (err.status === 500) throw new HttpError(500, 'internal', 'The repository could not be updated');
  return { status: err.status, body: { error: { code: err.code, message: err.message } } };
}

async function guarded(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepoError) return refusal(err);
    throw err;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(content: string, encoding: 'utf8' | 'base64', path: string): string | Uint8Array {
  if (encoding === 'utf8') return content;
  if (content.length % 4 !== 0 || !BASE64.test(content)) throw repoInvalid(`content of "${path}" is not valid base64`);
  return Buffer.from(content, 'base64');
}

export function registerRepoRoutes(ctx: PluginContext, repo: RepoService): void {
  ctx.http.route({
    ...getRepoTreeRoute,
    schema: { query: GetRepoTreeQuery },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const q = GetRepoTreeQuery.parse(req.query);
        const teamId = await teamIdBySlug(tx, slug);
        const { commitSha, entries } = await repo.tree(tx, teamId, q.path, q.ref);
        return {
          body: GetRepoTreeResponse.parse({
            ref: q.ref,
            commitSha,
            path: q.path,
            entries: entries.map((e) => ({ name: e.name, path: e.path, kind: e.type === 'tree' ? 'dir' : 'file', size: e.size, sha: e.sha })),
          }),
        };
      }),
  });

  ctx.http.route({
    ...getRepoBlobRoute,
    schema: { query: GetRepoBlobQuery },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const q = GetRepoBlobQuery.parse(req.query);
        const teamId = await teamIdBySlug(tx, slug);
        const blob = await repo.blob(tx, teamId, q.path, q.ref);
        const text = textOf(blob.content);
        return {
          body: GetRepoBlobResponse.parse({
            ref: q.ref,
            commitSha: blob.commitSha,
            path: q.path,
            blobSha: blob.sha,
            size: blob.size,
            encoding: text === null ? 'base64' : 'utf8',
            content: text ?? blob.content.toString('base64'),
          }),
        };
      }),
  });

  ctx.http.route({
    ...commitRepoRoute,
    schema: { body: CommitRepoRequest },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const body = CommitRepoRequest.parse(req.body);
        const teamId = await teamIdBySlug(tx, slug);
        const changes: RepoWriteChange[] = body.changes.map((c) =>
          c.op === 'delete'
            ? { path: c.path, op: 'delete', ...(c.baseBlobSha !== undefined ? { baseBlobSha: c.baseBlobSha } : {}) }
            : c.op === 'append'
              ? { path: c.path, op: 'append', content: decode(c.content, c.encoding, c.path) }
              : { path: c.path, op: 'put', content: decode(c.content, c.encoding, c.path), ...(c.baseBlobSha !== undefined ? { baseBlobSha: c.baseBlobSha } : {}) },
        );
        const result = await repo.write(tx, teamId, { id: tx.actor.id, kind: tx.actor.kind }, changes, body.message);
        return { status: result.noop ? 200 : 201, body: CommitRepoResponse.parse(result) };
      }),
  });
}
