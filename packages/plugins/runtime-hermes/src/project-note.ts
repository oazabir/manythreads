import type { PluginTx } from '@manythreads/sdk';
import { isRepoOriginAllowed, parseRepoOriginAllow } from '@manythreads/shared';
import type { ProjectNote } from './match.ts';

/** The project the channel is tied to, if any (the projects plugin's table; read in the outbox's system transaction). */
export async function projectOfChannel(tx: PluginTx, channelId: string): Promise<ProjectNote | null> {
  const row = (
    await tx.query<{ name: string; repo_url: string; default_branch: string }>(
      'SELECT name, repo_url, default_branch FROM app.projects WHERE channel_id = $1::uuid',
      [channelId],
    )
  ).rows[0];
  if (!row) return null;
  // the same allowlist the pod controller applies (the server's own setting), so the note never promises a copy the pod does not hold
  const allow = parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
  return { name: row.name, repoUrl: row.repo_url, defaultBranch: row.default_branch, cloned: isRepoOriginAllowed(row.repo_url, allow) };
}
