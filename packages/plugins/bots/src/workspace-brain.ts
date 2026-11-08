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

/**
 * The sha256 of every earlier shipped `templates/_workspace/bots/brain/BOT.md`. A workspace whose newest stored version is one of these was never edited by an admin: it is
 * only behind (a new shipped file never overwrites a stored version, so a Brain made on 2026-11-07 kept the first text and missed `meetings.search`), so the next ensure
 * stores the shipped file as its next version. A text an admin edited has another sha and is left alone. Add the sha of the old file whenever the shipped one changes.
 */
export const SUPERSEDED_BRAIN_SHAS: ReadonlySet<string> = new Set([
  '03b1f76d88960e83126ceddbc04b0bb6fba1fc2cc1beb44bb11849fc3923b011', // P20-07
  '960e781c34b10f9c317c8ba027fde8581e758ff9a0b5aaaae46353554b8ed2c8', // P20-LV
  'c4386ca01c4de726b803920ad682b45663ce2f02eeb885c1e1ad422fbdf70371', // P21-F
]);

/** Make sure the workspace has its Brain: store the shipped definition when none is stored yet (or the stored one is a superseded shipped text), load it, retire the team Brains. Idempotent. Returns the bot's id, or null. */
export async function ensureWorkspaceBrain(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
  log: PluginLogger,
  superseded: ReadonlySet<string> = SUPERSEDED_BRAIN_SHAS,
): Promise<string | null> {
  const stored = (
    await tx.query<{ content: string; sha: string }>(
      'SELECT content, sha FROM app.workspace_bot_definitions WHERE workspace_id = $1 AND slug = $2 ORDER BY version DESC LIMIT 1',
      [workspaceId, WORKSPACE_BRAIN_SLUG],
    )
  ).rows[0];
  const behind = stored !== undefined && superseded.has(stored.sha);
  const shipped = stored === undefined || behind ? await shippedBrainDefinition() : null;
  const content = (behind ? shipped : null) ?? stored?.content ?? shipped;
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

/**
 * The same ensure, once, when the plugin starts (after every migration, which runs before any plugin registers): a fresh deploy has its Brain at once instead of at the
 * next 15-minute slot. It never throws and never holds the start up: a failure is logged and the cron below stays the net. Two replicas starting together take a database
 * lock, so one does the work and the other skips (the unique index `bots_workspace_slug` still guards a race that gets past it, and the per-workspace savepoint absorbs it).
 */
export async function ensureWorkspaceBrainAtStart(ctx: PluginContext, log: PluginLogger = console): Promise<boolean> {
  try {
    return await ctx.db.system(async (tx) => {
      const got = (await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [ENSURE_BRAIN_QUEUE])).rows[0]?.locked;
      if (got !== true) return false;
      await ensureEveryWorkspaceBrain(ctx, tx, log);
      return true;
    });
  } catch (err) {
    log.warn(`bots: the workspace Brain was not ensured at start (the 15-minute job tries again): ${err instanceof Error ? err.message.slice(0, 300) : 'unknown'}`);
    return false;
  }
}

export function registerWorkspaceBrain(ctx: PluginContext): void {
  // At start: not awaited (the server need not wait for it), and tolerant of every failure.
  void ensureWorkspaceBrainAtStart(ctx);
  // A fallback for a workspace made later, and for a start that could not ensure it: every 15 minutes, a no-op once the Brain is there.
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
