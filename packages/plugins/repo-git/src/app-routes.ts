import { HttpError, type HttpResponse, type PluginContext } from '@manythreads/sdk';
import { APP_BRIDGE_CLIENT_FILE, APP_BRIDGE_CLIENT_JS, embeddedAppHeaders, parseRepoPath, repoMimeOf, splitRepoAppRest } from '@manythreads/shared';
import { RepoError } from './errors.ts';
import type { RepoService } from './repo.ts';
import { APP_READ_LIMIT, teamIdBySlug } from './routes.ts';

// The content route of embedded apps (SPEC section 5.2, PLAN P4-10): the files of a folder that holds an `index.html`, served with the mime type
// of the file so the browser runs the page inside the sandboxed frame. The server adds the strict CSP and `sandbox` to everything under this path
// (build-server.ts) and lets a short-lived signed token in the path stand in for the session cookie (a sandboxed frame has none): by the time
// this handler runs, `tx` is the person's, either way, so a read is still the team's row level security and nothing else.

const CHARSET = new Set(['text/html', 'text/css', 'text/javascript', 'text/xml', 'application/json', 'text/plain', 'text/csv', 'text/markdown']);

/**
 * Every answer of this handler carries the app headers itself (CSP with `sandbox allow-scripts`, nosniff, no-referrer): defence in depth, so the
 * lock never depends on the server matching the URL the same way the router did (C1 of the Phase 4 review: `/repo/%61pp/...` reached this handler
 * with no CSP). The server's hook adds them to refusals that never get here.
 */
const withAppHeaders = (res: HttpResponse): HttpResponse => ({ ...res, headers: { ...res.headers, ...embeddedAppHeaders() } });

type Handler = Parameters<PluginContext['http']['route']>[0]['handler'];

/** `GET /api/teams/:slug/repo/app/<folder>/<file>`; a folder (or `.../`) answers its `index.html`. */
export function registerRepoAppRoute(ctx: PluginContext, repo: RepoService): void {
  ctx.http.route({
    method: 'GET',
    path: '/api/teams/:slug/repo/app/*',
    rateLimit: APP_READ_LIMIT,
    handler: async (req, tx): Promise<HttpResponse> => withAppHeaders(await serve(repo, req, tx)),
  });
}

async function serve(repo: RepoService, req: Parameters<Handler>[0], tx: Parameters<Handler>[1]): Promise<HttpResponse> {
  try {
    const slug = req.params['slug'] ?? '';
    // The token segment (if any) was checked by the server before this ran; it is not part of the repo path.
    const { path: rest } = splitRepoAppRest(req.params['*'] ?? '');
    const wantsIndex = rest === '' || rest.endsWith('/');
    const parsed = parseRepoPath(wantsIndex ? `${rest}index.html` : rest);
    if (!parsed.ok) return { status: 404, body: { error: { code: 'not_found', message: 'No such file' } } };
    const teamId = await teamIdBySlug(tx, slug);
    const path = parsed.path;
    const name = path.slice(path.lastIndexOf('/') + 1);

    // The bridge client every app folder can load: not a repo file, but only readers of the team get it.
    if (name === APP_BRIDGE_CLIENT_FILE) {
      return { status: 200, body: Buffer.from(APP_BRIDGE_CLIENT_JS, 'utf8'), headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-cache' } };
    }

    let blob: Awaited<ReturnType<RepoService['blob']>>;
    try {
      blob = await repo.blob(tx, teamId, path, 'main');
    } catch (err) {
      // `apps/x` without the slash names a folder: it answers its index.html (404 if there is none, as for any missing file).
      if (!(err instanceof RepoError) || (err.status !== 404 && err.status !== 400) || wantsIndex) throw err;
      try {
        blob = await repo.blob(tx, teamId, `${path}/index.html`, 'main');
      } catch {
        throw err.status === 400 ? new RepoError(404, 'not_found', 'No such file') : err;
      }
    }
    const mime = repoMimeOf(path);
    return {
      status: 200,
      body: Buffer.from(blob.content),
      headers: {
        'content-type': CHARSET.has(mime) ? `${mime}; charset=utf-8` : mime,
        'content-length': String(blob.size),
        // The headers that make a response an app's (CSP, sandbox, nosniff, no-referrer) are the server's, set for every answer on this path.
        'cache-control': 'private, no-cache',
      },
    };
  } catch (err) {
    if (err instanceof RepoError) {
      if (err.status === 500) throw new HttpError(500, 'internal', 'The app could not be read');
      return { status: err.status, body: { error: { code: err.code, message: err.message } } };
    }
    throw err;
  }
}
