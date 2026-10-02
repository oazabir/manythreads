import { z } from 'zod';
import { RepoFolderPath } from '../api/repo/repo.ts';

// Embedded apps over the real route (SPEC 5.2, PLAN P4-10): a sandboxed frame (`sandbox="allow-scripts"`, opaque origin) does not send the
// SameSite session cookie with its sub-resource requests, so the app content route also accepts a short-lived signed token that names the team
// and the app folder. The token is a path segment, not a query parameter, so the app's relative URLs (`__manythreads.js`, `app.js`) keep it.
//
//   POST /api/teams/:slug/repo/app-token      { path: "apps/release-checklist" }   (signed in, can read the team)
//   GET  /api/teams/:slug/repo/app/~mta.<token>/apps/release-checklist/index.html
//
// The server signs and checks tokens (packages/server/src/app-token.ts); this file holds what both sides must agree on.

/** Prefix of the path segment that carries a token, right after `/repo/app/`. A repo folder cannot be told apart from it by the writer's rules, so the server treats a first segment with this prefix as a token and refuses it when it is not a valid one. */
export const APP_TOKEN_PREFIX = '~mta.';

/** How long a token opens its app (seconds). One open: reopening the app asks for another. */
export const APP_TOKEN_TTL_SECONDS = 300;

export const issueAppTokenRoute = { method: 'POST', path: '/api/teams/:slug/repo/app-token' } as const;

export const IssueAppTokenRequest = z.strictObject({
  /** The app's folder, relative to the repo root (the folder that holds `index.html`). */
  path: RepoFolderPath.refine((p) => p !== '', 'name the app folder, not the repo root'),
});
export type IssueAppTokenRequest = z.infer<typeof IssueAppTokenRequest>;

export const IssueAppTokenResponse = z.strictObject({
  /** Opaque. Never log it; it opens one app of one team until `expiresAt`. */
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  /** The app's folder, as asked. */
  path: z.string().min(1),
  /** The address to put in the iframe: the content route with the token in its path (`index.html` of the folder). */
  url: z.string().min(1),
});
export type IssueAppTokenResponse = z.infer<typeof IssueAppTokenResponse>;

/** The content route for an app opened with a token: `/api/teams/<slug>/repo/app/<prefix><token>/<folder>/<file>`. */
export const repoAppTokenPath = (slug: string, token: string, folder: string, file = 'index.html'): string => {
  const enc = (s: string): string => s.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..').map(encodeURIComponent).join('/');
  return `/api/teams/${encodeURIComponent(slug)}/repo/app/${APP_TOKEN_PREFIX}${encodeURIComponent(token)}/${enc(folder)}/${enc(file)}`;
};

/**
 * Splits what follows `/repo/app/` (decoded) into the optional token and the repo path: a first segment that starts with the token prefix is
 * the token (everything after the prefix), the rest is the path. Pure: no check of either.
 */
export function splitRepoAppRest(rest: string): { token: string | null; path: string } {
  const slash = rest.indexOf('/');
  const first = slash < 0 ? rest : rest.slice(0, slash);
  if (!first.startsWith(APP_TOKEN_PREFIX)) return { token: null, path: rest };
  return { token: first.slice(APP_TOKEN_PREFIX.length), path: slash < 0 ? '' : rest.slice(slash + 1) };
}

/**
 * True when `path` is `folder` or lies below it, with no empty, `.` or `..` segment anywhere (a token for `apps/a` must never open
 * `apps/a/../b` or `apps/ab`). Both are repo paths without a leading slash.
 */
export function isPathInsideFolder(path: string, folder: string): boolean {
  if (folder === '' || path === '') return false;
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return path === folder || path.startsWith(`${folder}/`);
}
