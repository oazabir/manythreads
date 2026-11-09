import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The list of repositories a pod's repo-sync step clones (PLAN Bundle E, decision E4, docs/plugins/claude-pods.md). The pod's controller sends the list to
// `PUT /internal/repos` whenever it changes; the bridge checks every line and writes the file the repo-sync container reads every few seconds. A ConfigMap volume would
// reach the pod only after about a minute; this reaches it in a moment. One line per clone: <team> <bot> <project> <branch or -> <https address>.

export interface RepoLine {
  team: string;
  bot: string;
  project: string;
  branch: string | null;
  origin: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
// eslint-disable-next-line no-control-regex -- refusing control characters in an address is the point
const ORIGIN = /^https:\/\/[^\s\u0000-\u001f\u007f'"`$\\<>|;&()*]{1,500}$/;
export const MAX_REPOS = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body `{ repos: [{ team, bot, project, branch, origin }] }`, or why it is refused. One bad line refuses the whole list: the file is never half-written. */
export function parseRepoList(body: unknown): { ok: true; repos: RepoLine[] } | { ok: false; error: string } {
  if (!isRecord(body) || !Array.isArray(body['repos'])) return { ok: false, error: 'the body must be { "repos": [ ... ] }' };
  if (body['repos'].length > MAX_REPOS) return { ok: false, error: `at most ${MAX_REPOS} repositories` };
  const repos: RepoLine[] = [];
  for (const [i, r] of body['repos'].entries()) {
    if (!isRecord(r)) return { ok: false, error: `repos[${i}] must be an object` };
    const { team, bot, project, branch, origin } = r;
    for (const [what, value] of [['team', team], ['bot', bot], ['project', project]] as const) {
      // a name made only of dots would climb out of its folder; the first character rule already refuses a leading dot
      if (typeof value !== 'string' || !NAME.test(value) || value.includes('..')) return { ok: false, error: `repos[${i}].${what} is not a plain name` };
    }
    if (branch !== null && branch !== undefined && (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..'))) return { ok: false, error: `repos[${i}].branch is not a plain branch name` };
    if (typeof origin !== 'string' || !ORIGIN.test(origin)) return { ok: false, error: `repos[${i}].origin is not a plain https address` };
    repos.push({ team: team as string, bot: bot as string, project: project as string, branch: (branch as string | null | undefined) ?? null, origin });
  }
  return { ok: true, repos };
}

export const toLines = (repos: readonly RepoLine[]): string => repos.map((r) => `${r.team} ${r.bot} ${r.project} ${r.branch ?? '-'} ${r.origin}`).join('\n') + (repos.length > 0 ? '\n' : '');

/** Writes the list the way the sync step reads it: the whole file in one step (a temporary file, then a rename), so the step never sees half a list. */
export function writeRepoList(file: string, repos: readonly RepoLine[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.repos.${process.pid}.tmp`);
  writeFileSync(tmp, toLines(repos), { mode: 0o644 });
  renameSync(tmp, file);
}
