import { type HttpResponse, type PluginContext } from '@manythreads/sdk';
import { RepoConflictResponse, WritePagePathParams, WritePageRequest, WritePageResponse, writePageRoute } from '@manythreads/shared';
import { writePage, type PageOutcome } from './pages.ts';

/** A refusal as the error envelope (returned, not thrown, so the transaction commits: see `writePage`). */
export function refusalResponse(outcome: Extract<PageOutcome, { ok: false }>): HttpResponse {
  if (outcome.status === 409 && outcome.conflicts && outcome.conflicts.length > 0) {
    return { status: 409, body: RepoConflictResponse.parse({ error: { code: 'conflict', message: outcome.message }, conflicts: outcome.conflicts }) };
  }
  return { status: outcome.status, body: { error: { code: outcome.code, message: outcome.message } } };
}

export function registerPageRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...writePageRoute,
    schema: { body: WritePageRequest },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: async (req, tx) => {
      const { slug } = WritePagePathParams.parse(req.params);
      const request = WritePageRequest.parse(req.body);
      const outcome = await writePage(ctx, tx, { team: slug, request });
      if (!outcome.ok) return refusalResponse(outcome);
      return {
        status: outcome.result.noop ? 200 : 201,
        body: WritePageResponse.parse({
          path: request.path,
          mode: outcome.mode,
          sha: outcome.result.sha,
          parentSha: outcome.result.parentSha,
          noop: outcome.result.noop,
          authorId: outcome.result.authorId,
          blobSha: outcome.blobSha,
          size: outcome.size,
        }),
      };
    },
  });
}
