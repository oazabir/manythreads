import type { PluginContext, PluginTx, ProjectCredentialsProvider, RepoProvider } from '@manythreads/sdk';
import { isRepoOriginAllowed, parseGitRepo, parseRepoOriginAllow, type GitRepo } from '@manythreads/shared';
import { maxExtractBytes } from './extract/index.ts';
import { repoFolderOf } from './rows.ts';
import { resyncBase } from './sync.ts';

/*
 * Project docs as knowledge (P35-06, owner 2026-11-20: "the team repo's code, ADRs and docs indexed as a knowledge base"). Every six hours, for each GitHub
 * project of a team that has a working token, the project's own Markdown (README, CONTRIBUTING, the `docs/` and ADR folders) is copied into the team's
 * repository under the base `<project>-docs` (made the first time, named after the project), with each file's path flattened into its name
 * (`docs/deploy/preview.md` becomes `docs--deploy--preview.md`: the base reads one folder). Only what changed is fetched (the git blob id of a file is the
 * same on GitHub and in the team's repository), and a file gone from the project is deleted from the folder. The base's own re-sync then makes the
 * documents and, with an `embed` model, their vectors. The token never leaves this server; the files are the project's, untrusted text.
 */

export const PROJECT_DOCS_QUEUE = 'knowledge.project-docs';
const MAX_FILES = 200;
const MAX_FILE_BYTES = 200_000;
const TIMEOUT_MS = 15_000;

/** The project files that are documentation: Markdown at the root, under a docs or doc folder, and in any ADR or decisions folder. */
export function isDocPath(path: string): boolean {
  if (!/\.(md|markdown)$/i.test(path)) return false;
  if (/(^|\/)(node_modules|vendor|dist|build|\.git)\//i.test(path)) return false;
  if (!path.includes('/')) return true;
  return /^(docs?|documentation)\//i.test(path) || /(^|\/)(adrs?|decisions|architecture)\//i.test(path);
}

/** The flattened file name in the base's folder. */
export const flatName = (path: string): string => path.replace(/\//g, '--').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);

const apiBaseOf = (repo: GitRepo): string => (process.env['NODE_ENV'] === 'test' && process.env['MANYTHREADS_TEST_GITHUB_API']) || repo.apiBase;
const headersFor = (token: string, raw = false): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'manythreads-knowledge',
});

/** The doc files of the branch with their blob ids; null when GitHub could not be asked. */
export async function docTree(repo: GitRepo, token: string, branch: string, doFetch: typeof fetch = fetch): Promise<Array<{ path: string; sha: string; size: number }> | null> {
  try {
    const res = await doFetch(`${apiBaseOf(repo)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
      headers: headersFor(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await res.json()) as { tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown; size?: unknown }> };
    return (body.tree ?? [])
      .filter((e) => e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string' && isDocPath(e.path))
      .map((e) => ({ path: e.path as string, sha: (e.sha as string).toLowerCase(), size: typeof e.size === 'number' ? e.size : 0 }))
      .filter((e) => e.size <= MAX_FILE_BYTES)
      .slice(0, MAX_FILES);
  } catch {
    return null;
  }
}

async function fileOf(repo: GitRepo, token: string, branch: string, path: string, doFetch: typeof fetch): Promise<Uint8Array | null> {
  try {
    const res = await doFetch(
      `${apiBaseOf(repo)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
      { headers: headersFor(token, true), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' },
    );
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength <= MAX_FILE_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

interface ProjectRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  team_slug: string;
  name: string;
  repo_url: string;
  provider: 'github' | 'gitlab';
  default_branch: string;
  created_by: string | null;
}

/** The project's base `<name>-docs`, made the first time as a lead would make it (an upload source and the repo folder). */
async function ensureBase(ctx: PluginContext, tx: PluginTx, p: ProjectRow): Promise<{ id: string; slug: string }> {
  const slug = `${p.name}-docs`.slice(0, 60);
  const found = (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_bases WHERE team_id = $1 AND slug = $2', [p.team_id, slug])).rows[0];
  if (found) return { id: found.id, slug };
  const made = (
    await tx.query<{ id: string }>('INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      p.workspace_id,
      p.team_id,
      slug,
      `${p.name} docs`,
      p.created_by,
    ])
  ).rows[0]!;
  await tx.query(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload'), ($1, $2, 'repo')`, [made.id, p.team_id]);
  await ctx.audit.emit(tx, { type: 'knowledge.base.created', workspaceId: p.workspace_id, teamId: p.team_id, baseId: made.id, slug, createdBy: p.created_by, at: new Date().toISOString() });
  return { id: made.id, slug };
}

export interface MirrorResult {
  projects: number;
  written: number;
  removed: number;
}

export async function mirrorProjectDocs(ctx: PluginContext, log: (line: string) => void, doFetch: typeof fetch = fetch): Promise<MirrorResult> {
  const out: MirrorResult = { projects: 0, written: 0, removed: 0 };
  const credentials = ctx.providers.get<ProjectCredentialsProvider>('project.credentials');
  const repoStore = ctx.providers.get<RepoProvider>('repo');
  if (!credentials || !repoStore) return out;
  const allow = parseRepoOriginAllow([process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'], process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW']].filter(Boolean).join(','));
  const projects = await ctx.db.system(async (tx) =>
    (
      await tx.query<ProjectRow>(
        `SELECT p.id, p.workspace_id, p.team_id, t.slug AS team_slug, p.name, p.repo_url, p.provider, p.default_branch, p.created_by
           FROM app.projects p JOIN app.teams t ON t.id = p.team_id
          WHERE p.provider = 'github' AND p.push_credential_set_at IS NOT NULL AND p.push_credential_status = 'ok' AND t.archived_at IS NULL
          ORDER BY p.id LIMIT 20`,
      )
    ).rows,
  );
  for (const p of projects) {
    const repo = parseGitRepo(p.repo_url, 'github');
    if (!repo || !isRepoOriginAllowed(p.repo_url, allow) || !p.created_by) continue;
    let cred: Awaited<ReturnType<ProjectCredentialsProvider['read']>>;
    try {
      cred = await credentials.read({ id: p.team_id, slug: p.team_slug }, p.name);
    } catch {
      continue;
    }
    if (!cred || cred.refused || cred.origin !== p.repo_url) continue;
    const tree = await docTree(repo, cred.token, p.default_branch, doFetch);
    if (tree === null) {
      log(`knowledge project docs: ${p.name}: GitHub could not be asked for the tree; tried again next pass`);
      continue;
    }
    out.projects++;
    const base = await ctx.db.system((tx) => ensureBase(ctx, tx, p), { workspaceId: p.workspace_id });
    const folder = repoFolderOf(base.slug);
    // the base reads its folder now (a repo source has no rhythm of its own; unchanged files cost one hash comparison)
    const reread = (): Promise<unknown> =>
      ctx.db
        .system((tx) => resyncBase(ctx, tx, { id: base.id, slug: base.slug, teamId: p.team_id, workspaceId: p.workspace_id }, maxExtractBytes(), { urls: false }), { workspaceId: p.workspace_id })
        .catch((err: unknown) => log(`knowledge project docs: ${p.name}: the base could not be read again: ${err instanceof Error ? err.message : String(err)}`));
    const have = await ctx.db.system(async (tx) => {
      try {
        return await repoStore.list(tx, p.team_id, folder);
      } catch {
        return [];
      }
    }, { workspaceId: p.workspace_id });
    const haveSha = new Map(have.filter((e) => e.kind === 'file').map((e) => [e.name, e.blobSha]));
    const wanted = new Map(tree.map((t) => [flatName(t.path), t]));
    const changes: Array<{ path: string; op: 'put'; content: Uint8Array } | { path: string; op: 'delete' }> = [];
    for (const [name, t] of wanted) {
      if (haveSha.get(name) === t.sha) continue;
      const bytes = await fileOf(repo, cred.token, p.default_branch, t.path, doFetch);
      if (bytes) changes.push({ path: `${folder}/${name}`, op: 'put', content: bytes });
    }
    for (const [name] of haveSha) if (!wanted.has(name) && /\.(md|markdown)$/i.test(name)) changes.push({ path: `${folder}/${name}`, op: 'delete' });
    if (changes.length === 0) {
      await reread();
      continue;
    }
    await ctx.db.system(
      (tx) => repoStore.write(tx, p.team_id, { id: tx.actor.id, kind: 'system', name: 'manythreads' }, changes, `knowledge: ${p.name} docs from ${p.repo_url} (${p.default_branch})`),
      { workspaceId: p.workspace_id },
    );
    out.written += changes.filter((c) => c.op === 'put').length;
    out.removed += changes.filter((c) => c.op === 'delete').length;
    log(`knowledge project docs: ${p.name}: ${changes.length} file(s) brought up to date in ${folder}`);
    await reread();
  }
  return out;
}

export function registerProjectDocs(ctx: PluginContext): void {
  ctx.jobs.register(
    PROJECT_DOCS_QUEUE,
    async (_payload, _tx, job) => {
      const r = await mirrorProjectDocs(ctx, (line) => job.log.info(line));
      if (r.written + r.removed > 0) job.log.info(`knowledge project docs: ${r.projects} project(s), ${r.written} written, ${r.removed} removed`);
    },
    { cron: '17 */6 * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}
