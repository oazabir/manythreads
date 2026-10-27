import { isRepoOriginAllowed, parseGithubRepo, parseRepoOriginAllow, type GithubRepo } from '@manythreads/shared';
import type { PluginContext, PluginTx, ProjectCredentialsProvider } from '@manythreads/sdk';
import { emitCompleted, emitUpdated } from './emit.ts';
import { getPull, type GithubOptions, type PullInfo } from './github.ts';
import { TASK_SELECT, toTask, type TaskRow } from './rows.ts';

/**
 * Pull requests of cards (PLAN P6-05). Two jobs of one rule: a card finishes only when a person merged **the pull request that was recorded for it**.
 *
 *  - **Recording** (`verifyPullRequest`, called by the `tasks.pull_request` tool): the bot says only which project and which number. The server reads the
 *    project's token and the address it was issued for from the pod's Secret (the `project.credentials` provider), asks GitHub for that pull request and
 *    requires it to be open, to come from this card's own branch (`card-<first 8 characters of the card id>`) of the very repository the token is for, to be at the
 *    commit the bot says it tested, and to be aimed at that same repository. The address stored on the card is made from the origin and the number.
 *  - **Following** (`tasks.pull-request-sync`): every few minutes the job asks the stored origin about each open pull request, least recently asked first. It
 *    re-checks branch, head commit and target before it accepts a merge: a pull request that was merged at another commit than the tested one finishes nothing
 *    (the card goes back to its owner and says so). Merged -> done; closed -> back to the owner with a live claim.
 *
 * The token is read for one request and never logged or stored here: every failure is a status code or an error name.
 * A struggling origin is not hammered: a project whose requests fail waits (in memory) longer after each failure, up to half an hour, or as long as GitHub says.
 * Tasks never reads the projects table: the origin is what the token was issued for, kept on the card at record time.
 */
export const PULL_REQUEST_SYNC_QUEUE = 'tasks.pull-request-sync';

const BATCH = 30;

export interface PullRequestDeps extends GithubOptions {
  credentials: () => ProjectCredentialsProvider | undefined;
  /** Origins a pull request may be read from (the same list that limits what a team's pod clones). Empty: nothing is read. */
  originAllow: readonly string[];
  /** Tests only: ask this API instead of the origin's own (a local double of GitHub). */
  apiBaseOverride?: string;
}

export function pullRequestDeps(ctx: PluginContext): PullRequestDeps {
  return {
    credentials: () => ctx.providers.get<ProjectCredentialsProvider>('project.credentials'),
    originAllow: parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']),
    // Test seam, ignored outside NODE_ENV=test: ask a local double of GitHub instead of the origin's own API.
    ...(process.env['NODE_ENV'] === 'test' && process.env['MANYTHREADS_TEST_GITHUB_API'] ? { apiBaseOverride: process.env['MANYTHREADS_TEST_GITHUB_API'] } : {}),
  };
}

const repoName = (r: GithubRepo): string => `${r.owner}/${r.repo}`.toLowerCase();

/** The address of a pull request, made from the repository's own address and its number. */
export const pullRequestUrl = (origin: string, number: number): string | null => {
  const r = parseGithubRepo(origin);
  return r ? `https://${r.host}/${r.owner}/${r.repo}/pull/${number}` : null;
};

export type Verified = { ok: true; origin: string; headRef: string; headSha: string; baseRef: string; url: string } | { ok: false; code: string; message: string };

/** Everything the server insists on before a card may wait on a pull request. */
export async function verifyPullRequest(
  deps: PullRequestDeps,
  input: { team: { id: string; slug: string }; taskId: string; project: string; testedSha: string; number: number },
): Promise<Verified> {
  const provider = deps.credentials();
  if (!provider) return { ok: false, code: 'no_credential', message: 'this server holds no push credentials' };
  let cred: { token: string; origin: string; branch: string } | null;
  try {
    cred = await provider.read(input.team, input.project);
  } catch {
    return { ok: false, code: 'github_unreachable', message: 'the project credential could not be read; try again in a moment' };
  }
  if (!cred) return { ok: false, code: 'no_credential', message: 'this project has no push credential' };
  const repo = isRepoOriginAllowed(cred.origin, deps.originAllow) ? parseGithubRepo(cred.origin) : null;
  if (!repo) return { ok: false, code: 'no_credential', message: "this project's address cannot be published to" };
  const answer = await getPull({ ...deps, apiBase: deps.apiBaseOverride ?? repo.apiBase, token: cred.token, owner: repo.owner, repo: repo.repo, number: input.number, failures: 0 });
  if (answer.kind === 'retry') return { ok: false, code: 'github_unreachable', message: `GitHub could not be asked about the pull request (${answer.why}); try again in a moment` };
  const p = answer.pull;
  const branch = `card-${input.taskId.slice(0, 8)}`;
  const mine = repoName(repo);
  if (p.state !== 'open' || p.merged) return { ok: false, code: 'not_open', message: `pull request #${input.number} is not open` };
  if (p.headRef !== branch) return { ok: false, code: 'wrong_branch', message: `pull request #${input.number} does not come from this card's branch ${branch}` };
  if (p.baseRef !== cred.branch) return { ok: false, code: 'wrong_base', message: `pull request #${input.number} is aimed at ${p.baseRef ?? 'an unknown branch'}, not at the project's main branch ${cred.branch}` };
  if (p.baseRepo !== mine || p.headRepo !== mine) return { ok: false, code: 'wrong_repository', message: `pull request #${input.number} is not between branches of ${mine}` };
  if (p.headSha === null || !p.headSha.startsWith(input.testedSha.toLowerCase())) {
    return { ok: false, code: 'sha_mismatch', message: `pull request #${input.number} is at ${p.headSha?.slice(0, 12) ?? 'an unknown commit'}, not at the tested commit ${input.testedSha.slice(0, 12)}` };
  }
  const url = pullRequestUrl(cred.origin, input.number);
  if (!url) return { ok: false, code: 'no_credential', message: "this project's address cannot be published to" };
  return { ok: true, origin: cred.origin, headRef: branch, headSha: p.headSha, baseRef: cred.branch, url };
}

interface Due extends Record<string, unknown> {
  task_id: string;
  number: number;
  project: string;
  origin: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  team_id: string;
  team_slug: string;
}

export type Backoff = Map<string, { until: number; failures: number }>;

/** What a pass did, for the job's log line and for tests. */
export interface SyncResult {
  checked: number;
  merged: number;
  closed: number;
  skipped: number;
  failed: number;
}

async function dueList(ctx: PluginContext): Promise<Due[]> {
  return ctx.db.system(async (tx) => {
    const res = await tx.query<Due>(
      `SELECT t.id AS task_id, t.pull_request_number AS number, t.pull_request_project AS project, t.pull_request_origin AS origin,
              t.pull_request_head_ref AS head_ref, t.pull_request_head_sha AS head_sha, t.pull_request_base_ref AS base_ref, te.id AS team_id, te.slug AS team_slug
         FROM app.tasks t
         JOIN app.teams te ON te.id = t.team_id
        WHERE t.pull_request_state = 'open'
        ORDER BY t.pull_request_checked_at NULLS FIRST, t.id
        LIMIT ${BATCH}`,
    );
    return res.rows;
  });
}

async function markChecked(tx: PluginTx, taskId: string): Promise<void> {
  await tx.query('UPDATE app.tasks SET pull_request_checked_at = now() WHERE id = $1::uuid AND pull_request_state = $2', [taskId, 'open']);
}

/** Why a merged pull request is not a merge of what was recorded; null when it is. */
function divergence(d: Due, repo: GithubRepo, p: PullInfo): string | null {
  if (p.headRef !== d.head_ref || p.baseRef !== d.base_ref || p.baseRepo !== repoName(repo) || p.headRepo !== repoName(repo)) return `Pull request #${d.number} is no longer the one recorded for this card (branch, target branch or repository changed)`;
  if (p.headSha !== d.head_sha) return `Pull request #${d.number} was merged at ${p.headSha?.slice(0, 12) ?? 'another commit'}, not at the tested commit ${d.head_sha.slice(0, 12)}: test it again`;
  return null;
}

export async function syncPullRequests(ctx: PluginContext, deps: PullRequestDeps, backoff: Backoff, log: (line: string) => void): Promise<SyncResult> {
  const out: SyncResult = { checked: 0, merged: 0, closed: 0, skipped: 0, failed: 0 };
  const now = deps.now ?? Date.now;
  const due = await dueList(ctx);
  const tokens = new Map<string, { token: string; origin: string; branch: string } | null>();
  for (const d of due) {
    const key = `${d.team_id}/${d.project}`;
    const wait = backoff.get(key);
    if (wait && wait.until > now()) {
      out.skipped++;
      continue;
    }
    const repo = isRepoOriginAllowed(d.origin, deps.originAllow) ? parseGithubRepo(d.origin) : null;
    const provider = deps.credentials();
    if (!repo || !provider) {
      // An address this server may not call, or no credentials held here: nothing to ask.
      out.skipped++;
      await ctx.db.system((tx) => markChecked(tx, d.task_id));
      continue;
    }
    let cred = tokens.get(key);
    if (cred === undefined) {
      try {
        cred = await provider.read({ id: d.team_id, slug: d.team_slug }, d.project);
      } catch (err) {
        log(`pull request sync: cannot read the credential of ${d.project} (${err instanceof Error ? err.name : 'error'})`);
        out.failed++;
        continue;
      }
      tokens.set(key, cred);
    }
    // A token now issued for another address (the project moved) is never used against the address recorded on the card.
    if (cred === null || cred.origin !== d.origin) {
      out.skipped++;
      await ctx.db.system((tx) => markChecked(tx, d.task_id));
      continue;
    }
    const answer = await getPull({ ...deps, apiBase: deps.apiBaseOverride ?? repo.apiBase, token: cred.token, owner: repo.owner, repo: repo.repo, number: d.number, failures: backoff.get(key)?.failures ?? 0 });
    out.checked++;
    if (answer.kind === 'retry') {
      const failures = (backoff.get(key)?.failures ?? 0) + 1;
      backoff.set(key, { until: now() + answer.waitMs, failures });
      log(`pull request sync: ${d.project} #${d.number}: ${answer.why}; next try in ${Math.round(answer.waitMs / 1000)} s`);
      out.failed++;
      continue;
    }
    backoff.delete(key);
    const p = answer.pull;
    if (p.state === 'open') {
      await ctx.db.system((tx) => markChecked(tx, d.task_id));
      continue;
    }
    // closed: merged or not. A merge counts only for the recorded branch at the recorded commit.
    const bad = p.merged ? divergence(d, repo, p) : null;
    const outcome: 'merged' | 'closed' = p.merged && bad === null ? 'merged' : 'closed';
    const reason = outcome === 'closed' ? (bad ?? `Pull request #${d.number} was closed without being merged`) : '';
    await ctx.db.system(async (tx) => {
      const before = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [d.task_id])).rows[0];
      const done = (await tx.query<{ o_outcome: string }>('SELECT * FROM app.tasks_resolve_pull_request($1::uuid, $2, $3, $4)', [d.task_id, outcome, outcome === 'merged' ? p.mergeSha : null, reason])).rows[0];
      if (!before || done?.o_outcome !== outcome) return; // recorded_only / not_open: the card is left as it is
      const after = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [d.task_id])).rows[0];
      if (!after) return;
      const was = toTask(before);
      const now2 = toTask(after);
      if (outcome === 'merged') {
        await emitCompleted(ctx, tx, now2);
        // A done card keeps no private notes.
        await tx.query('SELECT app.tasks_drop_private_notes($1::uuid)', [d.task_id]);
        out.merged++;
      } else out.closed++;
      await emitUpdated(ctx, tx, was, now2);
    });
  }
  return out;
}

export function registerPullRequestSync(ctx: PluginContext): void {
  const backoff: Backoff = new Map();
  ctx.jobs.register(
    PULL_REQUEST_SYNC_QUEUE,
    async (_payload, _tx, job) => {
      const r = await syncPullRequests(ctx, pullRequestDeps(ctx), backoff, (line) => job.log.info(line));
      if (r.checked + r.skipped + r.failed > 0) job.log.info(`pull request sync: ${r.checked} asked, ${r.merged} merged, ${r.closed} closed, ${r.failed} failed, ${r.skipped} skipped`);
    },
    // detached: the job waits on another server, so it must not hold a transaction while it does
    { cron: '*/3 * * * *', detached: true },
  );
}
