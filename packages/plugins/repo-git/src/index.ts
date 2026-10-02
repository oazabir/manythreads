import { resolve } from 'node:path';
import { definePlugin, type RepoProvider } from '@manythreads/sdk';
import { TeamTemplateAppliedEvent, WorkspaceTeamCreatedEvent } from '@manythreads/shared';
import { createGitLayer } from './git/index.ts';
import { createRepoService, repoLimitsFromEnv } from './repo.ts';
import { registerRepoAppRoute } from './app-routes.ts';
import { registerRepoRoutes } from './routes.ts';

export { createRepoService, repoLimitsFromEnv, DEFAULT_REPO_MAX_BYTES, DEFAULT_REPO_MAX_FILES, REPO_LIST_MAX_ENTRIES, ACTOR_EMAIL_DOMAIN, type RepoService, type RepoActor, type RepoWriteChange, type RepoWriteResult, type CommitIdentity } from './repo.ts';
export { createGitLayer, createGitRunner, GitError, type GitLayer } from './git/index.ts';
export { RepoError } from './errors.ts';

/** `MANYTHREADS_REPO_DIR` (absolute), else `./data/repos`. */
export const DEFAULT_REPO_DIR = './data/repos';
export const repoDirFromEnv = (env: Record<string, string | undefined> = process.env): string => resolve(env['MANYTHREADS_REPO_DIR']?.trim() || DEFAULT_REPO_DIR);

const INIT_QUEUE = 'repo-git.init';
/** Weekly (Sunday 04:41 UTC): `git gc --auto` per team repository packs loose objects once a repository has about a thousand of them. */
export const GC_QUEUE = 'repo-git.gc';
export const GC_CRON = '41 4 * * 0';

/**
 * repo-git: the team repo (SPEC section 5.1, PLAN P4-01 to P4-05). One bare git repository per team under `MANYTHREADS_REPO_DIR`, one writer
 * per team (`createRepoService().write`), an index in Postgres for search and history, and the writer rules (text only, guarded paths).
 * docs/plugins/repo-git.md has the layout, the write contract and the HTTP routes.
 */
export default definePlugin({
  manifest: {
    name: 'repo-git',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register', 'provider.repo'],
    // `files.write` and `files.delete` are the names the broker's path guard knows: a bot's write to bots/, TEAM.md, skills/ or routines/ is
    // denied under them. Deleting is never grantable to a bot (destructive).
    capabilities: [
      { name: 'files.write', destructive: false },
      { name: 'files.delete', destructive: true },
    ],
    events: { emits: ['repo.repo.committed'], consumes: ['workspace.team.created', 'team.template.applied'] },
    migrations: 'migrations',
  },
  register(ctx) {
    const repo = createRepoService({
      repoDir: repoDirFromEnv(),
      git: createGitLayer(),
      ...repoLimitsFromEnv(),
      authorize: (tx, capability, context) => ctx.capabilities.authorize(tx, capability, context),
      emit: (tx, event) => ctx.audit.emit(tx, event),
    });
    registerRepoRoutes(ctx, repo);
    registerRepoAppRoute(ctx, repo);
    // What other plugins (pages, bots, memory) call: `ctx.providers.get<RepoProvider>('repo')`.
    const provider: RepoProvider = {
      id: 'repo-git',
      write: (tx, teamId, actor, changes, message, coAuthors, options) => repo.write(tx, teamId, actor, changes, message, coAuthors, options),
      restore: (tx, teamId, actor, path, sha, coAuthors, message) => repo.restore(tx, teamId, actor, path, sha, coAuthors, message),
      list: (tx, teamId, path) => repo.list(tx, teamId, path),
      blob: (tx, teamId, path, ref, maxBytes) => repo.blob(tx, teamId, path, ref, maxBytes),
      tree: (tx, teamId, path, ref) => repo.tree(tx, teamId, path, ref),
    };
    ctx.providers.register('repo', provider);

    // A team's repository is created by a job (retried with backoff, one per team at a time) when the team is created or a template is
    // applied; the first request for a team without one (seeded straight into the database) creates it the same way, so both are idempotent.
    ctx.jobs.register(
      INIT_QUEUE,
      async (payload, tx) => {
        const teamId = typeof payload['teamId'] === 'string' ? payload['teamId'] : '';
        await repo.ensure(tx, teamId);
      },
      { concurrency: 2 },
    );
    ctx.jobs.register(
      GC_QUEUE,
      async (_payload, tx, job) => {
        const done = await repo.gcAll(tx, (teamId, err) => job.log.warn(`${GC_QUEUE} ${teamId}: ${err instanceof Error ? err.message : String(err)}`));
        job.log.info(`${GC_QUEUE} ${JSON.stringify(done)}`);
      },
      { cron: GC_CRON, maxAttempts: 2, concurrency: 1 },
    );
    ctx.events.subscribe('workspace.team.created', async (raw, tx) => {
      const e = WorkspaceTeamCreatedEvent.parse(raw);
      await ctx.jobs.enqueue(tx, INIT_QUEUE, { workspaceId: e.workspaceId, teamId: e.teamId }, { dedupeKey: `${INIT_QUEUE}:${e.teamId}` });
    });
    ctx.events.subscribe('team.template.applied', async (raw, tx) => {
      const e = TeamTemplateAppliedEvent.parse(raw);
      await ctx.jobs.enqueue(tx, INIT_QUEUE, { workspaceId: e.workspaceId, teamId: e.teamId }, { dedupeKey: `${INIT_QUEUE}:${e.teamId}` });
    });
  },
});
