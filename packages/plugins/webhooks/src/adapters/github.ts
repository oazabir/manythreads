import { LIMITS, clip, compose, escapeInline, inline, link, plural, quote, safeUrl } from './md.ts';
import { dig, isObj, num, str, type Adapted, type Obj } from './types.ts';

// GitHub's own webhook events (https://docs.github.com/webhooks), the ones a team wants in a channel: pushes, pull requests, issues, workflow and
// check runs, releases. Names, titles and messages come from people outside the team, so they are escaped and cut; addresses must be http(s).
// Anything else is left out with a note, never an error: GitHub shows a delivery as failed when it gets one.

const repoOf = (p: Obj): string => inline(dig(p, 'repository', 'full_name') ?? dig(p, 'repository', 'name') ?? 'a repository', 100);
const who = (u: unknown): string => {
  const name = inline(dig(u, 'login') ?? dig(u, 'name') ?? '', 60);
  return name === '' ? 'someone' : `**${name}**`;
};
const sha7 = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^0-9a-f]/gi, '').slice(0, 7) : '');
const refName = (ref: unknown): { kind: 'branch' | 'tag'; name: string } | null => {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('refs/heads/')) return { kind: 'branch', name: ref.slice(11) };
  if (ref.startsWith('refs/tags/')) return { kind: 'tag', name: ref.slice(10) };
  return null;
};
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const ignore = (reason: string): Adapted => ({ kind: 'ignore', reason });

function push(p: Obj): Adapted {
  const ref = refName(p['ref']);
  if (ref === null) return ignore('A push to a ref that is not a branch or a tag is not shown.');
  const repo = repoOf(p);
  const pusher = who(p['sender'] ?? p['pusher']);
  const label = `${ref.kind} ${code(clip(ref.name, 100))}`;
  if (p['deleted'] === true) return { kind: 'post', text: `🗑️ ${link(`**${repo}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${pusher} deleted ${label}` };
  const commits = Array.isArray(p['commits']) ? (p['commits'] as unknown[]) : [];
  const total = num(dig(p, 'size')) ?? commits.length;
  if (commits.length === 0 && p['created'] !== true) return ignore('A push with no new commits is not shown.');
  const head = `${link(`**${repo}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${pusher} ${p['forced'] === true ? 'force-pushed' : 'pushed'} ${commits.length === 0 ? '' : `${plural(Math.max(total, commits.length), 'commit')} to `}${label}${commits.length === 0 ? ' (created)' : ''}`;
  const lines = commits.slice(0, 5).map((c) => {
    const sha = sha7(dig(c, 'id'));
    const url = safeUrl(dig(c, 'url'));
    const first = inline(String(dig(c, 'message') ?? '').split('\n')[0] ?? '', 120);
    const author = inline(dig(c, 'author', 'name') ?? dig(c, 'author', 'username') ?? '', 40);
    return `- ${sha === '' ? '' : `${url ? link(code(sha), url) : code(sha)} `}${first}${author ? ` — ${author}` : ''}`;
  });
  if (commits.length > 5) lines.push(`- … and ${commits.length - 5} more`);
  const compare = safeUrl(p['compare']);
  return { kind: 'post', text: compose([head, lines.join('\n'), compare ? link('Compare changes', compare) : null]) };
}

function pullRequest(p: Obj): Adapted {
  const action = str(p['action']);
  const pr = p['pull_request'];
  if (!isObj(pr) || action === undefined) return ignore('A pull request event without a pull request is not shown.');
  const merged = pr['merged'] === true;
  const draft = pr['draft'] === true;
  let verb: string;
  let mark = '';
  switch (action) {
    case 'opened':
      verb = draft ? 'opened a draft pull request' : 'opened a pull request';
      mark = '🔀';
      break;
    case 'reopened':
      verb = 'reopened a pull request';
      mark = '🔀';
      break;
    case 'ready_for_review':
      verb = 'marked a pull request ready for review';
      mark = '🔀';
      break;
    case 'closed':
      verb = merged ? 'merged a pull request' : 'closed a pull request without merging';
      mark = merged ? '🟣' : '⚪';
      break;
    case 'review_requested': {
      const reviewer = who(p['requested_reviewer']) !== 'someone' ? who(p['requested_reviewer']) : `team **${inline(dig(p, 'requested_team', 'name') ?? 'a team', 60)}**`;
      verb = `asked ${reviewer} to review a pull request`;
      mark = '👀';
      break;
    }
    default:
      return ignore(`Pull request action "${inline(action, 40)}" is not shown.`);
  }
  const num_ = num(pr['number']) ?? num(p['number']);
  const title = inline(pr['title'], LIMITS.title);
  const head = `${mark} ${link(`**${repoOf(p)}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${who(action === 'closed' && merged ? (pr['merged_by'] ?? p['sender']) : p['sender'])} ${verb}`;
  const line = `${link(`#${num_ ?? '?'} ${title}`, safeUrl(pr['html_url']))}`;
  const branches = `${code(clip(String(dig(pr, 'head', 'ref') ?? '?'), 60))} → ${code(clip(String(dig(pr, 'base', 'ref') ?? '?'), 60))}`;
  const detail = action === 'opened' || action === 'ready_for_review' ? quote(pr['body'], 400, 6) : '';
  return { kind: 'post', text: compose([head, `${line}\n${branches}`, detail]) };
}

function pullRequestReview(p: Obj): Adapted {
  if (str(p['action']) !== 'submitted') return ignore('Only submitted reviews are shown.');
  const review = p['review'];
  const pr = p['pull_request'];
  if (!isObj(review) || !isObj(pr)) return ignore('A review event without a review is not shown.');
  const state = str(review['state'])?.toLowerCase();
  const verb = state === 'approved' ? '✅ approved' : state === 'changes_requested' ? '❌ requested changes on' : state === 'commented' ? '💬 reviewed' : null;
  if (verb === null) return ignore('Only approvals, change requests and review comments are shown.');
  const head = `${link(`**${repoOf(p)}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${who(review['user'] ?? p['sender'])} ${verb} a pull request`;
  return { kind: 'post', text: compose([head, link(`#${num(pr['number']) ?? '?'} ${inline(pr['title'], LIMITS.title)}`, safeUrl(review['html_url'] ?? pr['html_url'])), state === 'commented' ? null : quote(review['body'], 400, 6)]) };
}

function issues(p: Obj): Adapted {
  const action = str(p['action']);
  const issue = p['issue'];
  if (!isObj(issue)) return ignore('An issue event without an issue is not shown.');
  const verbs: Record<string, [string, string]> = { opened: ['opened an issue', '🐛'], closed: ['closed an issue', '✅'], reopened: ['reopened an issue', '🐛'] };
  const found = action === undefined ? undefined : verbs[action];
  if (!found) return ignore(`Issue action "${inline(action ?? '', 40)}" is not shown.`);
  const head = `${found[1]} ${link(`**${repoOf(p)}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${who(p['sender'])} ${found[0]}`;
  return { kind: 'post', text: compose([head, link(`#${num(issue['number']) ?? '?'} ${inline(issue['title'], LIMITS.title)}`, safeUrl(issue['html_url'])), action === 'opened' ? quote(issue['body'], 400, 6) : null]) };
}

/** workflow_run and check_run share one wording: what ran, how it ended, on which branch. */
function runOutcome(kind: 'workflow' | 'check', p: Obj): Adapted {
  const run = p[kind === 'workflow' ? 'workflow_run' : 'check_run'];
  if (!isObj(run)) return ignore('A run event without a run is not shown.');
  if (str(p['action']) !== 'completed') return ignore('Only finished runs are shown.');
  const conclusion = str(run['conclusion']);
  const outcome = conclusion === 'success' ? ['✅', 'succeeded'] : conclusion === 'cancelled' ? ['⚪', 'was cancelled'] : conclusion === 'neutral' || conclusion === 'skipped' ? null : conclusion === 'action_required' ? ['⚠️', 'needs attention'] : ['❌', 'failed'];
  if (outcome === null) return ignore('A skipped or neutral run is not shown.');
  const name = inline(run['name'] ?? (kind === 'workflow' ? 'A workflow' : 'A check'), 100);
  const branch = str(kind === 'workflow' ? run['head_branch'] : dig(run, 'check_suite', 'head_branch'));
  const sha = sha7(run['head_sha']);
  const url = safeUrl(run['html_url']);
  const runNo = kind === 'workflow' ? num(run['run_number']) : undefined;
  const head = `${outcome[0]} ${link(`**${repoOf(p)}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${kind === 'workflow' ? 'workflow' : 'check'} ${link(`**${name}**`, url)} ${outcome[1]}`;
  const where = [branch ? `branch ${code(clip(branch, 60))}` : null, sha ? `commit ${code(sha)}` : null, runNo ? `run #${runNo}` : null].filter((x) => x !== null).join(' · ');
  const title = kind === 'check' ? inline(dig(run, 'output', 'title') ?? '', 200) : inline(dig(run, 'display_title') ?? '', 200);
  return { kind: 'post', text: compose([head, where || null, title || null]) };
}

function release(p: Obj): Adapted {
  if (str(p['action']) !== 'published' && str(p['action']) !== 'released') return ignore('Only published releases are shown.');
  const rel = p['release'];
  if (!isObj(rel)) return ignore('A release event without a release is not shown.');
  if (rel['draft'] === true) return ignore('A draft release is not shown.');
  const name = inline(rel['name'] ?? rel['tag_name'] ?? 'a release', 100);
  const head = `🚀 ${link(`**${repoOf(p)}**`, safeUrl(dig(p, 'repository', 'html_url')))}: ${who(rel['author'] ?? p['sender'])} published ${rel['prerelease'] === true ? 'a pre-release' : 'a release'}`;
  return { kind: 'post', text: compose([head, link(`${name}${rel['tag_name'] && rel['tag_name'] !== rel['name'] ? ` (${escapeInline(String(rel['tag_name']).slice(0, 60))})` : ''}`, safeUrl(rel['html_url'])), quote(rel['body'], 600, 10)]) };
}

export function adaptGithub(event: string, p: unknown): Adapted {
  if (event === 'ping') return ignore('Connected. GitHub sent its test ping; nothing was posted.');
  if (!isObj(p)) return { kind: 'reject', reason: 'The GitHub payload is not a JSON object.' };
  switch (event) {
    case 'push':
      return push(p);
    case 'pull_request':
      return pullRequest(p);
    case 'pull_request_review':
      return pullRequestReview(p);
    case 'issues':
      return issues(p);
    case 'workflow_run':
      return runOutcome('workflow', p);
    case 'check_run':
      return runOutcome('check', p);
    case 'release':
      return release(p);
    default:
      return ignore(`GitHub event "${inline(event, 40)}" is not shown by this webhook.`);
  }
}
