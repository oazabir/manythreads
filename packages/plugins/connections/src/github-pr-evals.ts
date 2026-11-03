import { evalBotOfPath, loadBotEval, runEvalSet, staticAnswerer, type EvalResult } from '@manythreads/shared';
import { BrokerError, parseServiceUrl, send } from './brokers/http.ts';

// The eval check for a pull request (PLAN P8-05): when a pull request on a team's GitHub repository changes a bot's BOT.md (or a scenario file next to it), read the
// changed files at the pull request's head commit, run the bot's evals on them and write the verdict back on that commit. It is the quick mode (the shared judge with
// no model): a case that REQUIRES a capability the new BOT.md does not grant fails, and a BOT.md that does not load, or a set that cannot be read, fails with the
// reason in plain words. The wording-based assertions need the model and are reported as not checked, the same as `pnpm test:evals`.
//
// Nothing here trusts the pull request: it is read as data through the GitHub API with the connection's token, never checked out and never run.

export interface GithubTarget {
  /** `https://api.github.com` (or an enterprise host's API address). */
  apiBase: string;
  /** The token that reads the repository and writes the result. It is sent only to `apiBase`. */
  token: string;
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_FILE_BYTES = 200_000;
const MAX_PAGES = 10;

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'manythreads-connections',
});

function checked(target: GithubTarget): URL {
  if (!NAME.test(target.owner) || !NAME.test(target.repo)) throw new BrokerError('The repository name is not valid.', 'bad_config');
  return parseServiceUrl(target.apiBase, 'GitHub');
}

export interface ChangedFile {
  filename: string;
  status: string;
}

/** The files a pull request changes (up to 1000), as GitHub lists them. */
export async function listPullFiles(target: GithubTarget, number: number): Promise<{ files: ChangedFile[]; complete: boolean }> {
  const base = checked(target);
  if (!Number.isInteger(number) || number < 1) throw new BrokerError('The pull request number is not valid.', 'bad_config');
  const files: ChangedFile[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await send({ url: `${base.origin}/repos/${target.owner}/${target.repo}/pulls/${number}/files?per_page=100&page=${page}`, method: 'GET', headers: headers(target.token) });
    if (res.status === 401 || res.status === 403) throw new BrokerError('GitHub refused this connection’s token.', 'refused');
    if (res.status !== 200) throw new BrokerError('GitHub could not list the pull request’s files.', 'unreachable');
    let list: unknown;
    try {
      list = JSON.parse(res.body);
    } catch {
      throw new BrokerError('GitHub’s answer was not understood.', 'bad_answer');
    }
    if (!Array.isArray(list)) throw new BrokerError('GitHub’s answer was not understood.', 'bad_answer');
    for (const f of list as Array<{ filename?: unknown; status?: unknown }>) {
      if (typeof f.filename === 'string' && typeof f.status === 'string') files.push({ filename: f.filename, status: f.status });
    }
    if (list.length < 100) return { files, complete: true };
  }
  return { files, complete: false };
}

/** One file's text at a commit, or null when it is not there (or is too large to be a bot's file). */
export async function readFileAt(target: GithubTarget, sha: string, path: string): Promise<string | null> {
  const base = checked(target);
  if (!SHA.test(sha)) throw new BrokerError('The commit is not valid.', 'bad_config');
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await send({
    url: `${base.origin}/repos/${target.owner}/${target.repo}/contents/${encoded}?ref=${sha}`,
    method: 'GET',
    headers: { ...headers(target.token), accept: 'application/vnd.github.raw+json' },
    maxBytes: MAX_FILE_BYTES,
  }).catch((e: unknown) => {
    // a file larger than a bot's file may be is "not usable", which the caller reports as a missing file
    if (e instanceof BrokerError && e.code === 'bad_answer') return null;
    throw e;
  });
  if (res === null || res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new BrokerError('GitHub refused this connection’s token.', 'refused');
  if (res.status !== 200) throw new BrokerError('GitHub could not read a file of the pull request.', 'unreachable');
  return res.body;
}

export type BotVerdict =
  | { slug: string; state: 'passed' | 'failed' | 'not_judged' | 'no_evals' | 'problem'; line: string; failures: string[] };

export interface PullReport {
  /** False when the pull request changes no bot's files: nothing is written to GitHub. */
  touched: boolean;
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
  bots: BotVerdict[];
}

const failedCases = (results: readonly EvalResult[]): string[] => results.filter((r) => r.judged && !r.passed).map((r) => `${r.caseId}: ${r.reasons.join('; ') || 'did not pass'}`.slice(0, 300)).slice(0, 10);

/** Reads the pull request and judges every bot it touches. Never runs anything the pull request contains. */
export async function evaluatePull(target: GithubTarget, pull: { number: number; headSha: string }): Promise<PullReport> {
  const listing = await listPullFiles(target, pull.number);
  const slugs = new Set<string>();
  const removed = new Set<string>();
  for (const f of listing.files) {
    const slug = evalBotOfPath(f.filename);
    if (slug === null) continue;
    if (f.status === 'removed' && f.filename === `bots/${slug}/BOT.md`) removed.add(slug);
    else slugs.add(slug);
  }
  for (const slug of removed) slugs.delete(slug);
  if (slugs.size === 0 && removed.size === 0) return { touched: false, conclusion: 'neutral', title: '', summary: '', bots: [] };

  const bots: BotVerdict[] = [];
  for (const slug of [...slugs].sort().slice(0, 25)) {
    const loaded = await loadBotEval(slug, (path) => readFileAt(target, pull.headSha, path));
    if (!loaded.ok) {
      if (loaded.kind === 'no_evals') bots.push({ slug, state: 'no_evals', line: `${slug}: no scenario set is named, so there is nothing to check.`, failures: [] });
      else bots.push({ slug, state: 'problem', line: `${slug}: ${loaded.message}`, failures: [] });
      continue;
    }
    const { results, summary } = await runEvalSet(staticAnswerer, loaded.loaded.definition, loaded.loaded.set.cases, loaded.loaded.minScore);
    if (summary.score === null || summary.ok === null) {
      bots.push({ slug, state: 'not_judged', line: `${slug}: none of the ${summary.total} cases can be judged without the model.`, failures: [] });
    } else if (summary.ok) {
      bots.push({ slug, state: 'passed', line: `${slug}: ${summary.passed} of ${summary.judged} checked cases pass (score ${summary.score}, minimum ${loaded.loaded.minScore}).`, failures: [] });
    } else {
      bots.push({ slug, state: 'failed', line: `${slug}: ${summary.passed} of ${summary.judged} checked cases pass (score ${summary.score}, below the minimum ${loaded.loaded.minScore}).`, failures: failedCases(results) });
    }
  }
  const bad = bots.some((b) => b.state === 'failed' || b.state === 'problem');
  const lines = bots.map((b) => `- ${b.line}`);
  if (removed.size > 0) lines.push(...[...removed].sort().map((s) => `- ${s}: removed by this pull request; nothing to check.`));
  if (slugs.size > 25) lines.push(`- ${slugs.size - 25} more bots are changed than one check reads; the first 25 were checked.`);
  if (!listing.complete) lines.push('- This pull request changes more files than GitHub lists in one go; later files were not read.');
  const body = ['Quick check, no model: a case fails when the bot’s new BOT.md lacks a capability the case requires; wording checks are left to the full run on the bot’s page.', '', ...lines];
  for (const b of bots) for (const f of b.failures) body.push(`  - ${b.slug} / ${f}`);
  return {
    touched: true,
    conclusion: bad ? 'failure' : bots.some((b) => b.state === 'passed') ? 'success' : 'neutral',
    title: bad ? 'A bot in this pull request does not pass its checks' : 'Bot checks',
    summary: body.join('\n').slice(0, 60_000),
    bots,
  };
}

/** The name the result carries on GitHub. */
export const CHECK_NAME = 'manythreads / bot evals';

/**
 * Writes the verdict on the pull request's head commit. A GitHub App's token can make a check run; a personal token cannot (GitHub allows apps only), so
 * `via: 'status'` writes a commit status instead, which every token may.
 */
export async function publishReport(target: GithubTarget, headSha: string, report: PullReport, via: 'check' | 'status'): Promise<void> {
  const base = checked(target);
  if (!SHA.test(headSha)) throw new BrokerError('The commit is not valid.', 'bad_config');
  const repoPath = `${base.origin}/repos/${target.owner}/${target.repo}`;
  const res =
    via === 'check'
      ? await send({
          url: `${repoPath}/check-runs`,
          method: 'POST',
          headers: { ...headers(target.token), 'content-type': 'application/json' },
          body: JSON.stringify({ name: CHECK_NAME, head_sha: headSha, status: 'completed', conclusion: report.conclusion, completed_at: new Date().toISOString(), output: { title: report.title, summary: report.summary.slice(0, 60_000) } }),
        })
      : await send({
          url: `${repoPath}/statuses/${headSha}`,
          method: 'POST',
          headers: { ...headers(target.token), 'content-type': 'application/json' },
          body: JSON.stringify({ state: report.conclusion === 'failure' ? 'failure' : 'success', context: CHECK_NAME, description: report.title.slice(0, 140) }),
        });
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new BrokerError('GitHub did not let this connection write the result (a check needs a GitHub App with permission to write checks).', 'refused');
  if (res.status !== 201) throw new BrokerError('GitHub could not take the result.', 'unreachable');
}
