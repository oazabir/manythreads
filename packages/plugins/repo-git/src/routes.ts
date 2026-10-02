import { HttpError, type HttpResponse, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CommitRepoRequest,
  CommitRepoResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  GetRepoContentQuery,
  GetRepoDiffQuery,
  GetRepoDiffResponse,
  GetRepoHistoryQuery,
  GetRepoHistoryResponse,
  GetRepoTreeQuery,
  GetRepoTreeResponse,
  RepoConflictResponse,
  RepoPathParams,
  RestoreRepoFileRequest,
  RestoreRepoFileResponse,
  commitRepoRoute,
  getRepoBlobRoute,
  getRepoContentRoute,
  getRepoDiffRoute,
  getRepoHistoryRoute,
  getRepoTreeRoute,
  repoMimeOf,
  restoreRepoFileRoute,
} from '@manythreads/shared';
import { parseUnifiedPatch } from './diff.ts';
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

// What a browser would run when it is opened directly: served as opaque bytes. SVG is the exception, served as an image (it runs nothing in an
// `<img>`, and under `sandbox` a direct visit runs nothing either).
const RUNNABLE_TYPES: ReadonlySet<string> = new Set(['text/html', 'text/xml', 'application/xhtml+xml', 'text/javascript', 'text/css']);
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf']);
const asciiName = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, '_');

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

  ctx.http.route({
    ...getRepoContentRoute,
    schema: { query: GetRepoContentQuery },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const q = GetRepoContentQuery.parse(req.query);
        const teamId = await teamIdBySlug(tx, slug);
        const blob = await repo.blob(tx, teamId, q.path, q.ref);
        const mime = repoMimeOf(q.path);
        const name = q.path.slice(q.path.lastIndexOf('/') + 1);
        const inline = q.download !== '1' && !RUNNABLE_TYPES.has(mime) && (INLINE_TYPES.has(mime) || mime.startsWith('text/'));
        return {
          status: 200,
          body: Buffer.from(blob.content),
          headers: {
            'content-type': RUNNABLE_TYPES.has(mime) ? 'application/octet-stream' : mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime,
            'content-length': String(blob.size),
            'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            // Access is decided again on every read.
            'cache-control': 'private, no-cache',
          },
        };
      }),
  });

  ctx.http.route({
    ...getRepoHistoryRoute,
    schema: { query: GetRepoHistoryQuery },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const q = GetRepoHistoryQuery.parse(req.query);
        const teamId = await teamIdBySlug(tx, slug);
        const page = await repo.history(tx, teamId, { path: q.path, limit: q.limit, cursor: q.cursor });
        return { body: GetRepoHistoryResponse.parse({ path: q.path, commits: page.commits, nextCursor: page.nextCursor }) };
      }),
  });

  ctx.http.route({
    ...getRepoDiffRoute,
    schema: { query: GetRepoDiffQuery },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const q = GetRepoDiffQuery.parse(req.query);
        const teamId = await teamIdBySlug(tx, slug);
        const d = await repo.diffFile(tx, teamId, { path: q.path, from: q.from, to: q.to });
        const parsed = parseUnifiedPatch(d.patch);
        const status = d.files.find((f) => f.path === q.path)?.status;
        return {
          body: GetRepoDiffResponse.parse({
            path: q.path,
            fromCommitSha: d.from,
            toCommitSha: d.to,
            status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === undefined ? 'unchanged' : 'modified',
            binary: parsed.binary,
            additions: parsed.additions,
            deletions: parsed.deletions,
            hunks: parsed.hunks,
            truncated: d.truncated,
          }),
        };
      }),
  });

  // A restore is a write like any other: the writer's rules apply (a member cannot restore bots/ or TEAM.md; a bot goes through the broker).
  ctx.http.route({
    ...restoreRepoFileRoute,
    schema: { body: RestoreRepoFileRequest },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: (req, tx) =>
      guarded(async () => {
        const { slug } = RepoPathParams.parse(req.params);
        const body = RestoreRepoFileRequest.parse(req.body);
        const teamId = await teamIdBySlug(tx, slug);
        const result = await repo.restore(tx, teamId, { id: tx.actor.id, kind: tx.actor.kind }, body.path, body.sha, [], body.message);
        return { status: result.noop ? 200 : 201, body: RestoreRepoFileResponse.parse({ ...result, restoredFromSha: body.sha }) };
      }),
  });
}
