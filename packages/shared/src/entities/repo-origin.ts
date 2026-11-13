// The one rule for the address of a git repository that a project (or a chart setting) asks the team's pod to copy, and the allowlist that
// guards it. Pure functions, no I/O: the shared schema, the projects plugin, the pod controller and the router all use these, and the SQL CHECK
// of the projects table (migration 0002) says the same thing in Postgres regex.

// https://<host>/<segment>/<segment>... : the host has no "/", "@", "?", "#", "%", "\" or space; every path segment is non-empty (so no "//") and
// has none of "@", "?", "#", "\" or space. A trailing "/" is fine. Segments never overlap, so matching is linear.
const PLAIN_URL = /^https:\/\/[^/@?#\s\\%]+(?:\/[^/@?#\s\\]+)*\/?$/;
// A path segment that is "." or ".." in any spelling of the dots ("%2e", "%2E", ".%2e").
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?:\/|$)/i;

/**
 * True for an https address with no user name or password, query or fragment, and no empty or dot ("." / ".." / "%2e") path segment.
 * Such an address needs no normalising, so two spellings of one place cannot slip past a prefix comparison: anything else is refused, not rewritten.
 */
export function isPlainRepoUrl(value: string): boolean {
  return PLAIN_URL.test(value) && !DOT_SEGMENT.test(value);
}

/**
 * The origin allowlist from its comma-separated setting (`MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW`): plain https prefixes only. A prefix is taken
 * to end at a "/" (one without it gets one), so `https://github.com/oazabir` allows that account's repositories and not `…/oazabir-evil/…`
 * or `https://github.com.evil.example/`.
 */
export function parseRepoOriginAllow(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.startsWith('https://') && isPlainRepoUrl(x))
    .map((x) => (x.endsWith('/') ? x : `${x}/`));
}

/** An address may be cloned when it is plain and starts with one of the allowed prefixes (see `parseRepoOriginAllow`). */
export function isRepoOriginAllowed(origin: string, allow: readonly string[]): boolean {
  return isPlainRepoUrl(origin) && allow.some((p) => origin.startsWith(p));
}

/** A GitHub repository as a project's address names it: `https://<host>/<owner>/<repo>[.git]`, and the REST API that serves it. */
export interface GithubRepo {
  host: string;
  owner: string;
  repo: string;
  /** `https://api.github.com` for github.com, `https://<host>/api/v3` for a GitHub Enterprise host. */
  apiBase: string;
}

const GITHUB_PATH = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** The owner and repository of a plain https address with exactly two path segments, or null (nested paths and other shapes are not pull-request targets). */
export function parseGithubRepo(value: string): GithubRepo | null {
  if (!isPlainRepoUrl(value)) return null;
  const rest = value.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const host = rest.slice(0, slash).toLowerCase();
  const m = GITHUB_PATH.exec(rest.slice(slash));
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { host, owner: m[1]!, repo: m[2]!, apiBase: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3` };
}

/** A repository on GitHub or GitLab, as a project's address names it. GitLab paths nest (`group/subgroup/repo`); GitHub's are `owner/repo`. */
export interface GitRepo {
  provider: 'github' | 'gitlab';
  host: string;
  /** Everything before the repository's own name: `owner` on GitHub, `group[/subgroup...]` on GitLab. */
  owner: string;
  repo: string;
  /** `owner/repo` or `group/subgroup/repo`, no `.git`. */
  path: string;
  /** GitHub: `https://api.github.com` or `https://<host>/api/v3`; GitLab: `https://<host>/api/v4`. */
  apiBase: string;
}

/** The provider an address names by itself: github.com and gitlab.com. Any other host needs the provider chosen by a person (null here). */
export function providerOfHost(host: string): 'github' | 'gitlab' | null {
  const h = host.toLowerCase();
  return h === 'github.com' ? 'github' : h === 'gitlab.com' ? 'gitlab' : null;
}

const GITLAB_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/;

/** The repository a plain https address names on `provider` (GitLab accepts nested groups), or null. */
export function parseGitRepo(value: string, provider: 'github' | 'gitlab'): GitRepo | null {
  if (provider === 'github') {
    const g = parseGithubRepo(value);
    return g ? { provider, host: g.host, owner: g.owner, repo: g.repo, path: `${g.owner}/${g.repo}`, apiBase: g.apiBase } : null;
  }
  if (!isPlainRepoUrl(value)) return null;
  const rest = value.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const host = rest.slice(0, slash).toLowerCase();
  const segments = rest.slice(slash + 1).replace(/\/$/, '').split('/');
  if (segments.length < 2 || segments.length > 20) return null;
  const last = (segments[segments.length - 1] ?? '').replace(/\.git$/, '');
  const parts = [...segments.slice(0, -1), last];
  if (!parts.every((x) => GITLAB_SEGMENT.test(x) && x !== '.' && x !== '..')) return null;
  const repo = parts[parts.length - 1]!;
  const owner = parts.slice(0, -1).join('/');
  return { provider, host, owner, repo, path: `${owner}/${repo}`, apiBase: `https://${host}/api/v4` };
}

/** The address of a pull request (GitHub) or merge request (GitLab) from the repository's address and its number. */
export function pullRequestUrlFor(repo: GitRepo, number: number): string {
  return repo.provider === 'github' ? `https://${repo.host}/${repo.path}/pull/${number}` : `https://${repo.host}/${repo.path}/-/merge_requests/${number}`;
}
