import type { MessageProvider, PluginContext, ProjectCredentialsProvider } from '@manythreads/sdk';
import { isRepoOriginAllowed, parseRepoOriginAllow, ProjectIssueOpenedEvent, type GitRepo } from '@manythreads/shared';
import { apiBaseOf } from './provider-check.ts';
import { repoOf } from './rows.ts';

/*
 * Give an issue to the bots (P35-04, owner 2026-11-20). Every two minutes, for each GitHub project of a team that is tied to a channel and has a working
 * token, the server asks GitHub for the open issues labelled `manythreads`. A new one becomes a thread in the project's channel: the platform posts the
 * issue's title, text and link, and `project.issue.opened` wakes the team's Engineer in that thread (runtime-hermes), on behalf of the person who
 * connected the project. Back on the issue, the server says once when the thread's card opened a pull request, and once when it was merged.
 * Like the plugin's other GitHub calls: the token never leaves this server, a failure is a status code, and the issue's text is untrusted (it is posted as a
 * message's text and nothing else).
 */

export const ISSUE_SYNC_QUEUE = 'projects.issue-sync';
export const ISSUE_LABEL = 'manythreads';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 4_000;
const BATCH = 20;

export type GithubIssue = { number: number; title: string; body: string; url: string };

const headersFor = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'manythreads-issues',
});
const repoPath = (repo: GitRepo): string => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

/** The open issues carrying the label (pull requests, which GitHub lists as issues too, left out). Null when GitHub could not be asked. */
export async function labelledIssues(repo: GitRepo, token: string, doFetch: typeof fetch = fetch): Promise<GithubIssue[] | null> {
  let res: Response;
  try {
    res = await doFetch(`${apiBaseOf(repo)}${repoPath(repo)}/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=30&sort=created&direction=asc`, {
      headers: headersFor(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) return null;
  const out: GithubIssue[] = [];
  for (const raw of body) {
    const i = raw as { number?: unknown; title?: unknown; body?: unknown; html_url?: unknown; pull_request?: unknown };
    if (i.pull_request !== undefined || typeof i.number !== 'number' || typeof i.title !== 'string') continue;
    const url = typeof i.html_url === 'string' && /^https:\/\/\S+$/.test(i.html_url) ? i.html_url.slice(0, 300) : '';
    if (url === '') continue;
    out.push({ number: i.number, title: i.title.slice(0, 300), body: typeof i.body === 'string' ? i.body : '', url });
  }
  return out;
}

/** A comment on the issue; false when GitHub refused it (the token may lack the Issues permission: said in the log, tried again next pass). */
export async function commentOnIssue(repo: GitRepo, token: string, number: number, text: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch(`${apiBaseOf(repo)}${repoPath(repo)}/issues/${number}/comments`, {
      method: 'POST',
      headers: { ...headersFor(token), 'content-type': 'application/json' },
      body: JSON.stringify({ body: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    void res.body?.cancel().catch(() => undefined);
    return res.status === 201;
  } catch {
    return false;
  }
}

/** The thread's first message: the issue as GitHub has it, cut, with its link. The text is the issue author's: posted as text, never as an instruction. */
export function issueMessage(project: string, issue: GithubIssue): string {
  const text = issue.body.trim().length > MAX_BODY ? `${issue.body.trim().slice(0, MAX_BODY)}…` : issue.body.trim();
  return [`**GitHub issue #${issue.number} of ${project}: ${issue.title}**`, '', text === '' ? '_(no description)_' : text, '', `Issue: ${issue.url}`].join('\n');
}

interface Due extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  team_slug: string;
  name: string;
  repo_url: string;
  provider: 'github' | 'gitlab';
  channel_id: string;
  created_by: string | null;
}

export interface SyncResult {
  projects: number;
  opened: number;
  said: number;
  skipped: number;
}

export async function syncIssues(ctx: PluginContext, log: (line: string) => void, doFetch: typeof fetch = fetch): Promise<SyncResult> {
  const out: SyncResult = { projects: 0, opened: 0, said: 0, skipped: 0 };
  const credentials = ctx.providers.get<ProjectCredentialsProvider>('project.credentials');
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!credentials || !messages) return out;
  const allow = parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
  const due = await ctx.db.system(async (tx) =>
    (
      await tx.query<Due>(
        `SELECT p.id, p.workspace_id, p.team_id, t.slug AS team_slug, p.name, p.repo_url, p.provider, p.channel_id, p.created_by
           FROM app.projects p JOIN app.teams t ON t.id = p.team_id
          WHERE p.provider = 'github' AND p.channel_id IS NOT NULL AND p.push_credential_set_at IS NOT NULL AND p.push_credential_status = 'ok'
            AND t.archived_at IS NULL
          ORDER BY p.id LIMIT ${BATCH}`,
      )
    ).rows,
  );
  for (const p of due) {
    const repo = repoOf(p);
    if (!repo || !isRepoOriginAllowed(p.repo_url, allow)) {
      out.skipped++;
      continue;
    }
    let cred: Awaited<ReturnType<ProjectCredentialsProvider['read']>>;
    try {
      cred = await credentials.read({ id: p.team_id, slug: p.team_slug }, p.name);
    } catch {
      out.skipped++;
      continue;
    }
    // a token issued for another address than the project's is never used against this one
    if (!cred || cred.refused || cred.origin !== p.repo_url) {
      out.skipped++;
      continue;
    }
    out.projects++;

    // 1. new labelled issues: a thread each, and the Engineer woken in it
    const issues = await labelledIssues(repo, cred.token, doFetch);
    if (issues === null) log(`projects issues: ${p.name}: GitHub could not be asked for issues; tried again next pass`);
    // the issue is posted by the team's Engineer, the bot it is given to (a platform message needs an author; a bot's post wakes nobody by itself)
    const engineer = (issues ?? []).length === 0 ? undefined : await ctx.db.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `SELECT a.id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE b.team_id = $1::uuid AND b.slug = 'engineer' AND b.status = 'active' LIMIT 1`,
          [p.team_id],
        )
      ).rows[0],
    );
    if ((issues ?? []).length > 0 && !engineer) log(`projects issues: ${p.name}: the team has no active Engineer to give issues to`);
    for (const issue of engineer ? (issues ?? []) : []) {
      const claimed = await ctx.db.system(
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              `INSERT INTO app.project_issues (workspace_id, team_id, project_id, number, url, title) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
               ON CONFLICT (project_id, number) DO NOTHING RETURNING id`,
              [p.workspace_id, p.team_id, p.id, issue.number, issue.url, issue.title],
            )
          ).rows[0],
        { workspaceId: p.workspace_id },
      );
      if (!claimed) continue;
      let rootId: string;
      try {
        const posted = await ctx.db.as({ actorId: engineer!.id, kind: 'bot', workspaceId: p.workspace_id, personId: null, sessionId: null }, (tx) =>
          messages.post(tx, { channelId: p.channel_id, body: issueMessage(p.name, issue), threadRootId: null, skipRefs: true }),
        );
        rootId = posted.id;
      } catch (err) {
        // not posted: the claim goes, and the next pass tries again
        await ctx.db.system((tx) => tx.query('DELETE FROM app.project_issues WHERE id = $1::uuid', [claimed.id]), { workspaceId: p.workspace_id });
        log(`projects issues: ${p.name}: issue #${issue.number} could not be posted (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
        continue;
      }
      await ctx.db.system(
        async (tx) => {
          await tx.query('UPDATE app.project_issues SET root_message_id = $2::uuid, updated_at = now() WHERE id = $1::uuid', [claimed.id, rootId]);
          await ctx.audit.emit(
            tx,
            ProjectIssueOpenedEvent.parse({
              type: 'project.issue.opened',
              schemaVersion: 1,
              workspaceId: p.workspace_id,
              teamId: p.team_id,
              projectId: p.id,
              channelId: p.channel_id,
              rootMessageId: rootId,
              number: issue.number,
              url: issue.url,
              askerActorId: p.created_by,
            }),
          );
        },
        { workspaceId: p.workspace_id },
      );
      out.opened++;
      log(`projects issues: ${p.name}: issue #${issue.number} became a thread`);
    }

    // 2. what the thread's cards did, said once on the issue: the pull request opened, then its merge
    const open = await ctx.db.system(async (tx) =>
      (
        await tx.query<{ id: string; number: number; said_pr: number | null; said_merged: boolean; pr: number | null; pr_url: string | null; pr_state: string | null }>(
          `SELECT i.id, i.number, i.said_pr, i.said_merged, t.pull_request_number AS pr, t.pull_request_url AS pr_url, t.pull_request_state AS pr_state
             FROM app.project_issues i
             LEFT JOIN LATERAL (
               SELECT t.pull_request_number, t.pull_request_url, t.pull_request_state FROM app.tasks t
                WHERE t.thread_root_id = i.root_message_id AND t.pull_request_number IS NOT NULL
                ORDER BY (t.pull_request_state = 'merged') DESC, t.updated_at DESC LIMIT 1
             ) t ON true
            WHERE i.project_id = $1::uuid AND i.state = 'open' AND i.root_message_id IS NOT NULL`,
          [p.id],
        )
      ).rows,
    );
    for (const row of open) {
      if (row.pr === null || row.pr_url === null) continue;
      if (row.pr_state === 'merged' && !row.said_merged) {
        if (await commentOnIssue(repo, cred.token, row.number, `The change for this issue was merged in pull request #${row.pr} (${row.pr_url}), built and tested by the team's bots in manythreads.`, doFetch)) {
          await ctx.db.system((tx) => tx.query(`UPDATE app.project_issues SET said_pr = $2, said_merged = true, state = 'done', updated_at = now() WHERE id = $1::uuid`, [row.id, row.pr]));
          out.said++;
        } else log(`projects issues: ${p.name}: GitHub refused a comment on issue #${row.number} (the token may need the Issues permission)`);
      } else if (row.said_pr !== row.pr && row.pr_state !== 'merged') {
        if (await commentOnIssue(repo, cred.token, row.number, `Pull request #${row.pr} (${row.pr_url}) holds the change for this issue: built and tested by the team's bots in manythreads, waiting for a person to merge it.`, doFetch)) {
          await ctx.db.system((tx) => tx.query('UPDATE app.project_issues SET said_pr = $2, updated_at = now() WHERE id = $1::uuid', [row.id, row.pr]));
          out.said++;
        } else log(`projects issues: ${p.name}: GitHub refused a comment on issue #${row.number} (the token may need the Issues permission)`);
      }
    }
  }
  return out;
}

export function registerIssueSync(ctx: PluginContext): void {
  ctx.jobs.register(
    ISSUE_SYNC_QUEUE,
    async (_payload, _tx, job) => {
      const r = await syncIssues(ctx, (line) => job.log.info(line));
      if (r.opened + r.said > 0) job.log.info(`projects issues: ${r.projects} projects asked, ${r.opened} issues opened, ${r.said} said back`);
    },
    // detached: the job waits on GitHub, so it must not hold a transaction while it does
    { cron: '*/2 * * * *', detached: true },
  );
}
