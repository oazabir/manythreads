import { createHash } from 'node:crypto';
import type { PluginContext, ProjectCredentialsProvider } from '@manythreads/sdk';
import { isRepoOriginAllowed, parseRepoOriginAllow } from '@manythreads/shared';
import { recordCheck } from './credential-status.ts';
import type { TokenUser } from './github-check.ts';
import { apiBaseOf, checkTokenFor, fetchUserOf } from './provider-check.ts';
import { COLUMNS, repoOf, type ProjectRow } from './rows.ts';

/**
 * `projects.credential-check`: every fifteen minutes the server asks GitHub about the tokens it holds, a few at a time, least recently asked first, so a
 * token that was revoked or has expired shows up on the Projects page ("token needs replacing") and in the team pod (which then stops pushing) soon after
 * it happens, not at the next publish. A project already marked needs-replacing is left alone until a new token is saved. GitHub not answering changes
 * nothing. The token is read for one request and never logged: log lines name the project and a verdict only.
 *
 * It also looks at a refusal someone else saw first: the pull-request sync marks the token in the pod after a 401, and this job asks GitHub about that
 * token before it turns anything into "needs replacing". If GitHub accepts the token after all (a 401 can be a passing fault) the mark is cleared and the
 * projects stay good, so one stray answer can never switch an owner's projects off for good.
 *
 * A token is only sent to an address this server may call (the allow-list that limits what a pod clones), and GitHub is asked who a token belongs to once per
 * run however many projects share it.
 */
export const CREDENTIAL_CHECK_QUEUE = 'projects.credential-check';

const BATCH = 60;

export interface CheckResult {
  asked: number;
  refused: number;
  skipped: number;
}

interface Due extends ProjectRow {
  team_slug: string;
}

export async function checkStoredTokens(ctx: PluginContext, log: (line: string) => void): Promise<CheckResult> {
  const out: CheckResult = { asked: 0, refused: 0, skipped: 0 };
  const allow = parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
  const users = new Map<string, Promise<TokenUser>>();
  const provider = ctx.providers.get<ProjectCredentialsProvider>('project.credentials');
  if (!provider) return out;
  // the ones looked at longest ago first; marked as looked at now, so the next run goes on with the next ones whatever the answer
  const due = await ctx.db.system(async (tx) => {
    const rows = (
      await tx.query<Due>(
        `SELECT ${COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}, t.slug AS team_slug
           FROM app.projects p JOIN app.teams t ON t.id = p.team_id
          WHERE p.push_credential_set_at IS NOT NULL AND p.push_credential_status = 'ok' AND t.archived_at IS NULL
          ORDER BY p.push_credential_checked_at NULLS FIRST, p.id LIMIT ${BATCH} FOR UPDATE OF p`,
      )
    ).rows;
    if (rows.length > 0) await tx.query('UPDATE app.projects SET push_credential_checked_at = now() WHERE id = ANY ($1::uuid[])', [rows.map((r) => r.id)]);
    return rows;
  });
  for (const row of due) {
    const team = { id: row.team_id, slug: row.team_slug };
    try {
      const github = repoOf(row);
      if (!github || !isRepoOriginAllowed(row.repo_url, allow) || !row.push_username) {
        out.skipped++;
        continue;
      }
      const cred = await provider.read(team, row.name);
      // a token issued for another address than the project's is not sent anywhere
      if (!cred || cred.origin !== row.repo_url) {
        out.skipped++;
        continue;
      }
      const apiBase = apiBaseOf(github);
      const key = `${apiBase}|${createHash('sha256').update(cred.token).digest('hex')}`;
      let user = users.get(key);
      if (!user) {
        user = fetchUserOf(github, cred.token);
        users.set(key, user);
      }
      const checked = await checkTokenFor(github, { token: cred.token, username: row.push_username, user: await user });
      if (!checked.ok && checked.problem === 'unreachable') {
        out.skipped++;
        continue;
      }
      out.asked++;
      const changed = await ctx.db.system(async (tx) => {
        // the verdict of an earlier project in this run may already have covered this one (a token shared by an owner)
        const fresh = (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1::uuid FOR UPDATE`, [row.id])).rows[0];
        if (!fresh || fresh.push_credential_set_at === null || fresh.push_credential_status !== 'ok') return false;
        const after = await recordCheck(tx, provider, team, fresh, checked, { podRefused: cred.refused === true });
        if (!after || after.push_credential_status === 'ok') return false;
        await ctx.audit.emit(tx, {
          type: 'project.project.updated',
          workspaceId: after.workspace_id,
          teamId: after.team_id,
          projectId: after.id,
          name: after.name,
          repoUrl: after.repo_url,
          defaultBranch: after.default_branch,
          channelId: after.channel_id,
        });
        return true;
      });
      if (changed) {
        out.refused++;
        log(`projects credential check: ${row.name}: GitHub no longer accepts the token (${checked.ok ? 'ok' : checked.problem})`);
      }
    } catch (err) {
      out.skipped++;
      log(`projects credential check: ${row.name}: not checked (${err instanceof Error ? err.name : 'error'})`);
    }
  }
  return out;
}

export function registerCredentialCheck(ctx: PluginContext): void {
  ctx.jobs.register(
    CREDENTIAL_CHECK_QUEUE,
    async (_payload, _tx, job) => {
      const r = await checkStoredTokens(ctx, (line) => job.log.info(line));
      if (r.asked + r.skipped > 0) job.log.info(`projects credential check: ${r.asked} asked, ${r.refused} refused, ${r.skipped} skipped`);
    },
    // detached: the job waits on GitHub, so it must not hold a transaction while it does
    { cron: '*/15 * * * *', detached: true },
  );
}
