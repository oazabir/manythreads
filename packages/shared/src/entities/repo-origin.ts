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
