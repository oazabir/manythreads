// P35-02: the card's Review: read the pull request's files and checks through the server (the browser never holds the project's token).
// Anyone who can read the team reads them; the decisions (approve, request changes, merge) are leads' and live in their own routes.
import { conflict, forbidden, HttpError, json, notFound, requireManage, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  approvePullRequestRoute,
  isRepoOriginAllowed,
  mergePullRequestRoute,
  PullRequestChangesRequest,
  PullRequestDecisionRequest,
  PullRequestDecisionResponse,
  requestPullRequestChangesRoute,
  threadPullRequestsRoute,
  ThreadPullRequestsResponse,
  parseGitRepo,
  pullRequestChecksRoute,
  PullRequestChecksResponse,
  pullRequestDiffRoute,
  PullRequestDiffResponse,
  pullRequestUrlFor,
  type GitRepo,
} from '@manythreads/shared';
import { getRequest, providerOf, pullRequestDeps, type PullRequestDeps } from './pull-requests.ts';
import { postHandoffCard } from './card.ts';
import { emitCompleted, emitHandedOff, emitUpdated } from './emit.ts';
import { listRequestChecks, listRequestFiles, MAX_PAGE, mergeRequest, submitReview, summarize, type ProviderFail, type ProviderTarget } from './review.ts';
import { actorOf, TASK_SELECT, toHandoff, toTask, type HandoffRow, type TaskRow } from './rows.ts';

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
  /** What the provider says now: still open and not merged (the sync may not have seen a close yet). */
  providerOpen: boolean;
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
  return { target, repo, number: row.number, recordedHead: row.head_sha, headSha: now.pull.headSha, url: pullRequestUrlFor(repo, row.number), state: row.state, providerOpen: now.pull.state === 'open' && !now.pull.merged, team, project: row.project };
}

export function registerReviewRoutes(ctx: PluginContext, depsOf: (ctx: PluginContext) => PullRequestDeps = pullRequestDeps): void {
  // the thread's line "Pull request #24 waits for review": the cards of this thread (that the caller may read) whose pull request is open
  ctx.http.route({
    ...threadPullRequestsRoute,
    schema: { response: ThreadPullRequestsResponse },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { rootId } = req.params as { rootId: string };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rootId)) throw new HttpError(400, 'validation_failed', 'rootId is a message id');
      const rows = (
        await tx.query<{ id: string; board_id: string | null; slug: string; title: string; pull_request_number: number; tested_sha: string | null }>(
          `SELECT t.id, t.board_id, te.slug, t.title, t.pull_request_number, t.tested_sha
             FROM app.tasks t JOIN app.teams te ON te.id = t.team_id
            WHERE t.thread_root_id = $1::uuid AND t.pull_request_state = 'open' AND t.state = 'waiting_on_person'
            ORDER BY t.updated_at DESC LIMIT 5`,
          [rootId],
        )
      ).rows;
      return json(
        ThreadPullRequestsResponse.parse({
          items: rows.map((r) => ({ taskId: r.id, boardId: r.board_id, teamSlug: r.slug, title: r.title, number: r.pull_request_number, testedSha: r.tested_sha })),
        }),
      );
    }),
  });

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

const REVIEW_OUTCOMES: Record<string, (reason: string) => HttpError> = {
  not_found: () => notFound('No such card'),
  not_lead: (r) => forbidden(r),
  not_open: (r) => conflict(r),
  sha_mismatch: (r) => conflict(r),
};

async function cardOf(tx: PluginTx, taskId: string) {
  const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [taskId])).rows[0];
  if (!row) throw notFound('No such card');
  return toTask(row);
}

/**
 * The checks every decision makes before it touches the provider, with no lock taken (a provider call can take seconds, and the card's row must not be
 * held meanwhile): the caller is a lead, the reviewer saw the recorded head (the tested commit), and the provider's request is still open and at it.
 */
async function precheck(deps: PullRequestDeps, tx: PluginTx, team: { id: string; workspace_id: string; archived_at: Date | null }, taskId: string, headSha: string) {
  await requireManage(tx, team as Parameters<typeof requireManage>[1]);
  const r = await openRequest(deps, tx, team.id, taskId);
  const head = headSha.toLowerCase();
  if (r.state !== 'open' || !r.providerOpen) throw conflict('This pull request is no longer open');
  if (head !== r.recordedHead) throw conflict(`You reviewed ${head.slice(0, 12)}, but the card's tested commit is ${r.recordedHead.slice(0, 12)}: reload the review`);
  if (r.headSha !== r.recordedHead) {
    throw conflict(`The ${r.repo.provider === 'github' ? 'pull' : 'merge'} request moved to ${r.headSha?.slice(0, 12) ?? 'another commit'} after it was tested: nothing was decided. It must be tested again (if you just pushed, try again in a moment).`);
  }
  const me = (await actorOf(tx, tx.actor.id))?.name ?? 'a lead';
  return { ...r, head, me };
}

/** The one SQL door of a decision (lead, open request, card waiting on a person, same head), which writes the line in the card's history under the card's lock. */
async function record(tx: PluginTx, taskId: string, head: string, verdict: 'approved' | 'changes_requested' | 'merge_asked'): Promise<void> {
  const out = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_review_pull_request($1::uuid, $2, $3)', [taskId, verdict, head])).rows[0];
  if (!out || out.o_outcome !== 'recorded') throw (REVIEW_OUTCOMES[out?.o_outcome ?? ''] ?? conflict)(out?.o_reason || 'The decision was not recorded');
}

export function registerDecisionRoutes(ctx: PluginContext, depsOf: (ctx: PluginContext) => PullRequestDeps = pullRequestDeps): void {
  ctx.http.route({
    ...approvePullRequestRoute,
    schema: { body: PullRequestDecisionRequest, response: PullRequestDecisionResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const body = PullRequestDecisionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const deps = depsOf(ctx);
      const d = await precheck(deps, tx, team, taskId, body.headSha);
      const done = await submitReview(d.target, d.number, d.head, 'approve', `Approved by ${d.me} in manythreads, at the tested commit ${d.head.slice(0, 12)}.`);
      if (!done.ok) return failWith(deps, d.team, d.project, d.repo, done);
      await record(tx, taskId, d.head, 'approved');
      const card = await cardOf(tx, taskId);
      await emitUpdated(ctx, tx, card, card);
      return json(PullRequestDecisionResponse.parse({ asComment: done.fallback, merged: false, mergeSha: null, handedTo: null }));
    }),
  });

  ctx.http.route({
    ...requestPullRequestChangesRoute,
    schema: { body: PullRequestChangesRequest, response: PullRequestDecisionResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const body = PullRequestChangesRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const deps = depsOf(ctx);
      // the Coder the card goes back to: refused before anything is written when the team has none
      const coder = (await tx.query<{ id: string; name: string }>('SELECT o_actor_id AS id, o_name AS name FROM app.tasks_bot_of($1::uuid, $2)', [team.id, 'coder'])).rows[0];
      if (!coder) throw conflict('This team has no active Coder bot to send the changes to');
      const before = await cardOf(tx, taskId);
      const d = await precheck(deps, tx, team, taskId, body.headSha);
      // the card's side first (the door and the hand-off), the provider last: a refusal anywhere leaves no review on GitHub or GitLab for a card that did not move
      await record(tx, taskId, d.head, 'changes_requested');
      const note = `${d.me} asked for changes on pull request #${d.number} (tested commit ${d.head.slice(0, 12)}): ${body.comment}\nMake them on the card's branch; the chain then runs again and the Committer updates the same pull request.`;
      const res = (
        await tx.query<{ o_outcome: string; o_handoff_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [taskId, coder.id, 'bot', note])
      ).rows[0];
      if (!res || res.o_outcome !== 'moved') throw conflict(res?.o_reason || 'The card could not be handed back to the Coder');
      const handoffRow = (await tx.query<HandoffRow>('SELECT * FROM app.handoffs WHERE id = $1::uuid', [res.o_handoff_id])).rows[0];
      if (!handoffRow) throw conflict('The handoff was not recorded');
      const handoff = toHandoff(handoffRow);
      const after = await cardOf(tx, taskId);
      await emitHandedOff(ctx, tx, after, handoff);
      await postHandoffCard(ctx, tx, { task: after, handoffId: handoff.id, toActorId: coder.id, note, pending: false });
      await emitUpdated(ctx, tx, before, after);
      const done = await submitReview(d.target, d.number, d.head, 'request_changes', `Changes asked by ${d.me} in manythreads:\n\n${body.comment}`);
      if (!done.ok) return failWith(deps, d.team, d.project, d.repo, done);
      return json(PullRequestDecisionResponse.parse({ asComment: done.fallback, merged: false, mergeSha: null, handedTo: coder.name }));
    }),
  });

  ctx.http.route({
    ...mergePullRequestRoute,
    schema: { body: PullRequestDecisionRequest, response: PullRequestDecisionResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const body = PullRequestDecisionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const deps = depsOf(ctx);
      const before = await cardOf(tx, taskId);
      const d = await precheck(deps, tx, team, taskId, body.headSha);
      // a failing check refuses the merge here (owner default, docs/plans/review-in-thread.md), and so does a check list that could not be read; pending or none only warn on the card
      const checks = await listRequestChecks(d.target, d.number, d.head);
      if (!checks.ok) return failWith(deps, d.team, d.project, d.repo, checks);
      if (summarize(checks.checks) === 'failing') throw conflict('A check failed on the tested commit: fix it (Request changes) before merging');
      const merged = await mergeRequest(d.target, d.number, d.head);
      if (!merged.ok) {
        if ('words' in merged && merged.words) throw conflict(merged.words);
        return failWith(deps, d.team, d.project, d.repo, merged);
      }
      // the provider merged at the tested head; the line and the card's end are written now, under the card's lock (if the door refuses, the sync finishes the card)
      await record(tx, taskId, d.head, 'merge_asked');
      const out = (await tx.query<{ out: string }>('SELECT app.tasks_merged_here($1::uuid, $2) AS out', [taskId, merged.mergeSha])).rows[0]?.out;
      const after = await cardOf(tx, taskId);
      if (out === 'merged') {
        await emitCompleted(ctx, tx, after);
        await emitUpdated(ctx, tx, before, after);
      }
      // anything else: the provider merged it, and the sync finishes the card within three minutes
      return json(PullRequestDecisionResponse.parse({ asComment: false, merged: true, mergeSha: merged.mergeSha, handedTo: null }));
    }),
  });
}
