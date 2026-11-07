import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginContext, PluginEvent, PluginLogger, PluginTx } from '@manythreads/sdk';
import { WorkspaceTeamCreatedEvent } from '@manythreads/shared';
import { WORKSPACE_BRAIN_SLUG, joinNewTeam, loadWorkspaceBot, retireTeamBrains } from './loader.ts';

export { WORKSPACE_BRAIN_SLUG, retireTeamBrains };

// The one Brain of the workspace (P20-07): a bot of scope `workspace`, with no team of its own. Its BOT.md ships in `templates/_workspace/bots/brain/BOT.md` (the folder
// name starts with an underscore, so the team-template loader skips it). The first time a workspace is seen the file is stored as version 1 of its definition and the bot is
// loaded; after that the stored versions are the workspace's (a later edit adds a version, a new shipped file never overwrites it). The old per-team Brains are then retired:
// switched off and left out of the roster, with every run, conversation and memory they have kept readable.

export const ENSURE_BRAIN_QUEUE = 'bots.ensure-workspace-brain';

/** `templates/` at the repository root unless `MANYTHREADS_TEMPLATES_DIR` says otherwise (the same place the team templates are read from). */
const templatesDir = (): string => process.env['MANYTHREADS_TEMPLATES_DIR'] ?? fileURLToPath(new URL('../../../../templates/', import.meta.url));

export async function shippedBrainDefinition(): Promise<string | null> {
  const file = path.join(templatesDir(), '_workspace', 'bots', WORKSPACE_BRAIN_SLUG, 'BOT.md');
  return existsSync(file) ? readFile(file, 'utf8') : null;
}

/** Make sure the workspace has its Brain: store the shipped definition when none is stored yet, load it, retire the team Brains. Idempotent. Returns the bot's id, or null. */
export async function ensureWorkspaceBrain(ctx: PluginContext, tx: PluginTx, workspaceId: string, log: PluginLogger): Promise<string | null> {
  const stored = (
    await tx.query<{ content: string }>(
      'SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = $1 AND slug = $2 ORDER BY version DESC LIMIT 1',
      [workspaceId, WORKSPACE_BRAIN_SLUG],
    )
  ).rows[0];
  const content = stored?.content ?? (await shippedBrainDefinition());
  if (content === null) {
    log.warn('bots: templates/_workspace/bots/brain/BOT.md is not there, so the workspace has no Brain yet');
    return null;
  }
  const botId = await loadWorkspaceBot(ctx, tx, { workspaceId, slug: WORKSPACE_BRAIN_SLUG, content });
  if (botId === null) {
    log.warn('bots: the workspace Brain definition is invalid; the team Brains stay as they are');
    return null;
  }
  const retired = await retireTeamBrains(tx, workspaceId);
  if (retired > 0) log.info(`bots: the workspace Brain replaced ${retired} team Brain(s)`);
  return botId;
}

/** Every workspace, as the system: the Brain is ensured in each. A failure in one workspace is logged and does not stop the others. */
export async function ensureEveryWorkspaceBrain(ctx: PluginContext, tx: PluginTx, log: PluginLogger): Promise<void> {
  const workspaces = (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id')).rows;
  for (const w of workspaces) {
    await tx.query('SAVEPOINT ensure_brain');
    try {
      await ensureWorkspaceBrain(ctx, tx, w.id, log);
      await tx.query('RELEASE SAVEPOINT ensure_brain');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT ensure_brain');
      await tx.query('RELEASE SAVEPOINT ensure_brain');
      log.warn(`bots: the workspace Brain of ${w.id} could not be ensured: ${err instanceof Error ? err.message.slice(0, 300) : 'unknown'}`);
    }
  }
}

export function registerWorkspaceBrain(ctx: PluginContext): void {
  // A fallback for the first start (and for a workspace made later): every 15 minutes, a no-op once the Brain is there.
  ctx.jobs.register(
    ENSURE_BRAIN_QUEUE,
    async (_payload, tx, job) => {
      await ensureEveryWorkspaceBrain(ctx, tx, job.log);
    },
    { cron: '*/15 * * * *', maxAttempts: 1, concurrency: 1 },
  );
  // A new team: the workspace Brain joins it at once, so it can post in the team's channels.
  ctx.events.subscribe('workspace.team.created', async (raw: PluginEvent, tx: PluginTx) => {
    const event = WorkspaceTeamCreatedEvent.parse(raw);
    await joinNewTeam(tx, event.workspaceId, event.teamId);
  });
}
