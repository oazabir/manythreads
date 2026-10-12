import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { parseBotMd } from '@manythreads/shared';

// The model_aliases backfill (review of P5-10, finding 2). Migration 0008 added `bots.model_aliases` with an empty default and
// no way to fill it from SQL: the column is the loader's projection of one *file*, and the file lives in git. A bot loaded
// before 0008 therefore carries `{}` until somebody recommits its BOT.md, and the LLM gateway — which limits a bot's virtual key
// to the aliases the definition names and mints no key for an empty set — leaves it without a key.
//
// This job is the one-time catch-up, and it is also a standing self-heal (a daily cron, like the gateway's own reconcile): for
// each active hermes bot with an empty projection it re-reads `bots/<slug>/BOT.md` at `main` through the repo provider, and —
// only if that is the very file the row was loaded from (same sha) — writes the projection and says `bots.bot.loaded` again,
// which is the event the gateway turns into a key. A bot whose file names no model stays empty and is read again tomorrow (one
// blob read; no event). The loader stays the only writer of every other column.

/** The queue (the kernel wants `<plugin>.<name>`). */
export const BACKFILL_QUEUE = 'bots.backfill-model-aliases';

/** The aliases a definition may ask for, then its own fallbacks: the same list the loader writes on every load. */
export const modelAliasesOf = (model: { aliases?: readonly string[]; fallbacks?: readonly string[] } | undefined): string[] => [
  ...new Set([...(model?.aliases ?? []), ...(model?.fallbacks ?? [])]),
];

type BackfillRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  slug: string;
  definition_sha: string;
  may_tag: string[];
};

/**
 * Fill `model_aliases` for the bots that have none. Answers how many rows it filled. Safe to repeat: a row it filled is no
 * longer selected, and the UPDATE re-checks that it is still empty.
 */
export async function backfillModelAliases(ctx: PluginContext, tx: PluginTx, log?: { warn(message: string): void }): Promise<number> {
  const rows = (
    await tx.query<BackfillRow>(
      `SELECT id, workspace_id, team_id, slug, definition_sha, may_tag
         FROM app.bots
        WHERE runtime = 'hermes' AND status = 'active' AND cardinality(model_aliases) = 0
        ORDER BY created_at, id`,
    )
  ).rows;
  if (rows.length === 0) return 0;
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');

  let filled = 0;
  for (const row of rows) {
    const path = `bots/${row.slug}/BOT.md`;
    let content: Uint8Array;
    try {
      content = (await repo.blob(tx, row.team_id, path, 'main')).content;
    } catch (err) {
      log?.warn(`bots: backfill of ${row.slug}: ${path} is unreadable at main (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    // A newer file than the one the row was built from is the loader's to handle (its event is on the way or failed loudly);
    // projecting a half of it here would leave the row describing two commits.
    if (createHash('sha256').update(content).digest('hex') !== row.definition_sha) continue;
    const parsed = parseBotMd(Buffer.from(content).toString('utf8'));
    if (!parsed.ok) continue;
    const aliases = modelAliasesOf(parsed.frontmatter.model);
    if (aliases.length === 0) continue;

    const updated = await tx.query<{ id: string }>(
      `UPDATE app.bots SET model_aliases = $2::text[], updated_at = now() WHERE id = $1 AND cardinality(model_aliases) = 0 RETURNING id`,
      [row.id, aliases],
    );
    if (updated.rows.length === 0) continue;
    filled += 1;
    await ctx.audit.emit(tx, {
      type: 'bots.bot.loaded',
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      botId: row.id,
      slug: row.slug,
      path,
      definitionSha: row.definition_sha,
      mayTag: row.may_tag,
    });
  }
  return filled;
}

/** Register the daily job. Before the gateway's own reconcile (03:23 UTC), so the key it mints exists when that one looks. */
export function registerBackfillJob(ctx: PluginContext): void {
  ctx.jobs.register(
    BACKFILL_QUEUE,
    async (_payload, tx, job) => {
      const filled = await backfillModelAliases(ctx, tx, job.log);
      if (filled > 0) job.log.info(`bots: backfilled model_aliases for ${filled} bot(s)`);
    },
    { cron: '11 3 * * *' },
  );
}
