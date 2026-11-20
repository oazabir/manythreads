import type { DriverJob } from './drivers/types.ts';

// Full access (P26-06, P35-01; conventions.md "Full access for Claude Code and Codex"): the agent runs commands and edits files without asking. Shared by the ACP adapter and the
// stream-json drivers, so both read one rule.

/** codex-acp's start mode with no sandbox and no command questions (the `codex --yolo` equivalent; the name is the adapter's and the version is pinned). */
export const CODEX_FULL_ACCESS_MODE = 'agent-full-access';
/**
 * claude-agent-acp's mode with no questions (`--dangerously-skip-permissions`). The adapter offers it only when it does not run as root (or runs with `IS_SANDBOX`, which the bridge never
 * sets): as root it quietly leaves the mode out, and the run then fails on "the agent has no such mode" (acp/session.ts) instead of asking about every command.
 */
export const CLAUDE_FULL_ACCESS_MODE = 'bypassPermissions';

/** What a run says when Claude Code does not offer `bypassPermissions` (it runs as root: the bridge never sets IS_SANDBOX to get round that). */
export const FULL_ACCESS_NOT_OFFERED =
  'Claude Code did not offer full access (it refuses it when it runs as root). Run the agent as its own user, or switch full access off for this runner on the Runners page.';

/** A server with no team users runs every team as the bridge's one user: it never gets full access (conventions.md "Full access"). */
export const NO_TEAM_USERS_FULL_ACCESS =
  'Full access is off on this server: it runs every team as one user (no team users), so commands still ask. Reinstall the server with the current installer to give each team its own user.';

/**
 * Whether this run's agent (Claude Code or Codex) runs with full access: the profile allows it (`fullAccess`) and the run does not take it back (P26-06, P35-01). `true` follows the run
 * unless it says no; `"allowed"` (an enrolled server) needs the run to say yes, so the machine's key and the site's key are both turned. A run with no file or shell grant has no commands
 * to bypass and keeps its narrow mode.
 */
export function fullAccessOn(job: Pick<DriverJob, 'profile' | 'request'>): boolean {
  if (job.profile.agent !== 'codex' && job.profile.agent !== 'claude-code') return false;
  const tools = job.request.manythreads.tools;
  if (!(tools.includes('files') || tools.includes('shell'))) return false;
  const asked = job.request.manythreads.fullAccess;
  if (job.profile.fullAccess === true) return asked !== false;
  if (job.profile.fullAccess === 'allowed') return asked === true;
  return false;
}
