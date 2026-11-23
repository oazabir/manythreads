// P35-02: the card's Review: read the pull request's files and checks through the server (the browser never holds the project's token).
// Anyone who can read the team reads them; the decisions (approve, request changes, merge) are leads' and live in their own routes.
import { HttpError, json, notFound, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  isRepoOriginAllowed,
  parseGitRepo,
  pullRequestChecksRoute,
  PullRequestChecksResponse,
  pullRequestDiffRoute,
  PullRequestDiffResponse,
  pullRequestUrlFor,
  type GitRepo,
} from '@manythreads/shared';
import { getRequest, providerOf, pullRequestDeps, type PullRequestDeps } from './pull-requests.ts';
import { listRequestChecks, listRequestFiles, MAX_PAGE, summarize, type ProviderFail, type ProviderTarget } from './review.ts';

interface RecordedRequest extends Record<string, unknown> {
  team_slug: string;
  number: number | null;
  project: string | null;
  origin: string | null;
  head_sha: string | null;
  state: string | null;
}

/** The request recorded on the card, the project's token for the address it was recorded at, and the provider's view of the request now. */
export interface OpenRequest {
  target: ProviderTarget;
  repo: GitRepo;
  number: number;
  recordedHead: string;
  headSha: string | null;
  url: string;
  state: string;
}

const busy = (what: string, why: string): HttpError => new HttpError(502, 'internal', `${what} could not be asked (${why}); try again in a moment`);
export const providerName = (repo: GitRepo): string => (repo.provider === 'github' ? 'GitHub' : 'GitLab');

/** Turns a provider failure into the route's refusal, marking the token refused on a 401 (as the sync does). */
export async function failWith(deps: PullRequestDeps, team: { id: string; slug: string }, project: string, repo: GitRepo, r: ProviderFail): Promise<never> {
  if (r.refused) {
    await deps.credentials()?.setRefused(team, project, true).catch(() => undefined);
    throw new HttpError(409, 'conflict', `${providerName(repo)} no longer accepts this project's token: a lead must save a new one on the Projects page`);
  }
  throw busy(providerName(repo), r.why);
}

export async function openRequest(deps: PullRequestDeps, tx: PluginTx, teamId: string, taskId: string): Promise<OpenRequest & { team: { id: string; slug: string }; project: string }> {
  const row = (
    await tx.query<RecordedRequest>(
      `SELECT te.slug AS team_slug, t.pull_request_number AS number, t.pull_request_project AS project, t.pull_request_origin AS origin,
              t.pull_request_head_sha AS head_sha, t.pull_request_state AS state
         FROM app.tasks t JOIN app.teams te ON te.id = t.team_id
        WHERE t.id = $1::uuid AND t.team_id = $2::uuid`,
      [taskId, teamId],
    )
  ).rows[0];
  if (!row) throw notFound('No such card');
  if (row.number === null || row.project === null || row.origin === null || row.head_sha === null || row.state === null) throw notFound('This card has no pull request');
  const team = { id: teamId, slug: row.team_slug };
  const provider = deps.credentials();
  if (!provider) throw new HttpError(409, 'conflict', 'This server holds no project tokens, so the pull request cannot be read here');
  let cred: Awaited<ReturnType<typeof provider.read>>;
  try {
    cred = await provider.read(team, row.project);
  } catch {
    throw busy('The project token', 'it could not be read');
  }
  // a token now issued for another address (the project moved) is never used against the address recorded on the card
  if (!cred || cred.origin !== row.origin || !isRepoOriginAllowed(row.origin, deps.originAllow)) {
    throw new HttpError(409, 'conflict', "This project has no token for the pull request's repository: a lead connects it on the Projects page");
  }
  if (cred.refused) throw new HttpError(409, 'conflict', "The provider no longer accepts this project's token: a lead must save a new one on the Projects page");
  const repo = parseGitRepo(row.origin, providerOf(cred));
  if (!repo) throw new HttpError(409, 'conflict', "This project's address cannot be read");
  const apiBase = repo.provider === 'github' ? (deps.apiBaseOverride ?? repo.apiBase) : (deps.gitlabApiOverride ?? repo.apiBase);
  const target: ProviderTarget = { repo, token: cred.token, apiBase, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) };
  const now = await getRequest(deps, repo, cred.token, row.number, 0);
  if (now.kind === 'retry') return failWith(deps, team, row.project, repo, { ok: false, status: null, why: now.why, ...(now.refused ? { refused: true as const } : {}) });
  return { target, repo, number: row.number, recordedHead: row.head_sha, headSha: now.pull.headSha, url: pullRequestUrlFor(repo, row.number), state: row.state, team, project: row.project };
}

export function registerReviewRoutes(ctx: PluginContext, depsOf: (ctx: PluginContext) => PullRequestDeps = pullRequestDeps): void {
  ctx.http.route({
    ...pullRequestDiffRoute,
    schema: { response: PullRequestDiffResponse },
    readOnly: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const page = Number(req.query['page'] ?? '1');
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new HttpError(400, 'validation_failed', `page is a whole number from 1 to ${MAX_PAGE}`);
      const team = await requireTeam(tx, slug);
      const deps = depsOf(ctx);
      const r = await openRequest(deps, tx, team.id, taskId);
      const files = await listRequestFiles(r.target, r.number, page);
      if (!files.ok) return failWith(deps, r.team, r.project, r.repo, files);
      return json(
        PullRequestDiffResponse.parse({ number: r.number, url: r.url, headSha: r.headSha, atRecordedHead: r.headSha === r.recordedHead, page, nextPage: files.nextPage, files: files.files }),
      );
    }),
  });

  ctx.http.route({
    ...pullRequestChecksRoute,
    schema: { response: PullRequestChecksResponse },
    readOnly: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const deps = depsOf(ctx);
      const r = await openRequest(deps, tx, team.id, taskId);
      // the checks of the commit the request is at now; when it moved, they are not the tested work's (said by atRecordedHead)
      const head = r.headSha ?? r.recordedHead;
      const checks = await listRequestChecks(r.target, r.number, head);
      if (!checks.ok) return failWith(deps, r.team, r.project, r.repo, checks);
      return json(
        PullRequestChecksResponse.parse({ headSha: r.headSha, atRecordedHead: r.headSha === r.recordedHead, summary: summarize(checks.checks), checks: checks.checks, unreadable: checks.unreadable }),
      );
    }),
  });
}
