// One entry for "ask the project's provider about this token", so the save, the Test button and the background check never differ by provider.
import type { GitRepo } from '@manythreads/shared';
import { apiBaseFor, checkGithubToken, fetchTokenUser, type TokenCheck, type TokenUser } from './github-check.ts';
import { checkGitlabToken, fetchGitlabTokenUser } from './gitlab-check.ts';

/** The address the provider's API is reached at (tests point GitHub at a double; GitLab's double is `MANYTHREADS_TEST_GITLAB_API`). */
export const apiBaseOf = (repo: GitRepo): string =>
  repo.provider === 'github' ? apiBaseFor(repo.apiBase) : (process.env['NODE_ENV'] === 'test' && process.env['MANYTHREADS_TEST_GITLAB_API']) || repo.apiBase;

export const fetchUserOf = (repo: GitRepo, token: string, doFetch?: typeof fetch): Promise<TokenUser> =>
  repo.provider === 'github' ? fetchTokenUser({ apiBase: apiBaseOf(repo), token, ...(doFetch ? { fetch: doFetch } : {}) }) : fetchGitlabTokenUser({ apiBase: apiBaseOf(repo), token, ...(doFetch ? { fetch: doFetch } : {}) });

export const checkTokenFor = (repo: GitRepo, opts: { token: string; username: string; user?: TokenUser; fetch?: typeof fetch }): Promise<TokenCheck> =>
  repo.provider === 'github'
    ? checkGithubToken({ apiBase: apiBaseOf(repo), token: opts.token, username: opts.username, owner: repo.owner, repo: repo.repo, ...(opts.user ? { user: opts.user } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) })
    : checkGitlabToken({ apiBase: apiBaseOf(repo), token: opts.token, username: opts.username, path: repo.path, ...(opts.user ? { user: opts.user } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });

const NAME = { github: 'GitHub', gitlab: 'GitLab' } as const;

/** What the page tells the person for each problem, by provider. */
export const problemMessage = (provider: 'github' | 'gitlab', problem: 'rejected' | 'wrong_owner' | 'no_write' | 'unreachable'): string => {
  const n = NAME[provider];
  switch (problem) {
    case 'rejected':
      return `${n} refused this token. Check that it was copied whole and has not expired or been revoked.`;
    case 'wrong_owner':
      return `This token belongs to a different ${n} account than the username you entered.`;
    case 'no_write':
      return provider === 'github'
        ? 'This token cannot write to this repository. It needs contents and pull requests write access to it.'
        : 'This token cannot push to this project. The bot account needs the Developer role (or higher) on it, and the token the `api` scope.';
    case 'unreachable':
      return `${n} could not be reached just now, so the token was not checked. Try again in a moment.`;
  }
};
