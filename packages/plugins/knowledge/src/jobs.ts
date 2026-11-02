import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { backfillEmbeddings, embedderOf } from './embed.ts';
import { GAPS_QUEUE, postGaps } from './gaps.ts';
import { maxExtractBytes } from './extract/index.ts';
import type { BaseRef } from './ingest.ts';
import { SOURCE_COLUMNS, type SourceRow } from './rows.ts';
import { resyncBase } from './sync.ts';
import { syncUrlSource } from './web.ts';

// The knowledge plugin's background work (PLAN P8-07, P8-08), all as the system role:
//  * `knowledge.sync`   every 5 minutes: reads the sources whose rhythm says they are due (`sync_minutes` since `last_synced_at`);
//  * `knowledge.embed`  every 10 minutes: gives passages a vector when the model gateway has an embedding model (nothing happens without one);
//  * `knowledge.gaps`   every 5 minutes: posts the questions no base could answer to the team's #kb-updates.
// Each handler is safe to run twice and does a bounded amount of work, so a slow site or a long backlog cannot hold the queue.

export const SYNC_QUEUE = 'knowledge.sync';
export const EMBED_QUEUE = 'knowledge.embed';
/** Most sources read in one pass; the rest wait for the next. */
const SYNC_BATCH = 5;

type DueRow = SourceRow & {
  team_id: string;
  workspace_id: string;
  base_slug: string;
}

/** Reads the sources that are due. Returns how many it read. Exported for tests and for the Re-sync of a whole workspace. */
export async function syncDueSources(ctx: PluginContext, tx: PluginTx, workspaceId: string, limit = SYNC_BATCH): Promise<number> {
  const due = (
    await tx.query<DueRow>(
      `SELECT ${SOURCE_COLUMNS}, s.team_id, b.workspace_id, b.slug AS base_slug
         FROM app.knowledge_sources s JOIN app.knowledge_bases b ON b.id = s.base_id
        WHERE s.sync_minutes IS NOT NULL AND b.workspace_id = $2
          AND (s.last_synced_at IS NULL OR s.last_synced_at + make_interval(mins => s.sync_minutes) <= now())
        ORDER BY s.last_synced_at NULLS FIRST, s.id
        LIMIT $1 FOR UPDATE OF s SKIP LOCKED`,
      [limit, workspaceId],
    )
  ).rows;
  const maxBytes = maxExtractBytes();
  const readBases = new Set<string>();
  let read = 0;
  for (const source of due) {
    const base: BaseRef = { id: source.base_id, teamId: source.team_id, workspaceId: source.workspace_id, slug: source.base_slug };
    if (source.kind === 'url') {
      await syncUrlSource(ctx, tx, base, source);
    } else {
      // an upload or repo source: the base's folder and its failed documents, once per pass even when both have a rhythm
      if (readBases.has(base.id)) continue;
      readBases.add(base.id);
      await resyncBase(ctx, tx, base, maxBytes, { urls: false });
    }
    read += 1;
  }
  return read;
}

/** The workspaces `listSql` names, then `work` in a short transaction of its own for each (a message, a repo write and an event belong to one workspace). */
async function forWorkspaces(ctx: PluginContext, listSql: string, work: (tx: PluginTx, workspaceId: string) => Promise<void>): Promise<void> {
  const workspaces = (await ctx.db.system(async (tx) => (await tx.query<{ workspace_id: string }>(listSql)).rows)).map((r) => r.workspace_id);
  for (const workspaceId of workspaces) await ctx.db.system((tx) => work(tx, workspaceId), { workspaceId });
}

export function registerJobs(ctx: PluginContext): void {
  // detached: a slow site must not hold a transaction open; every unit of work is a short transaction of its own
  ctx.jobs.register(
    SYNC_QUEUE,
    async (_payload, _unusable, job) => {
      await forWorkspaces(
        ctx,
        `SELECT DISTINCT b.workspace_id FROM app.knowledge_sources s JOIN app.knowledge_bases b ON b.id = s.base_id
          WHERE s.sync_minutes IS NOT NULL AND (s.last_synced_at IS NULL OR s.last_synced_at + make_interval(mins => s.sync_minutes) <= now()) LIMIT 50`,
        async (tx, workspaceId) => {
          const read = await syncDueSources(ctx, tx, workspaceId);
          if (read > 0) job.log.info(`knowledge: ${String(read)} source(s) read`);
        },
      );
    },
    { cron: '*/5 * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
  ctx.jobs.register(
    EMBED_QUEUE,
    async (_payload, _unusable, job) => {
      if (!embedderOf(ctx)) return;
      await forWorkspaces(
        ctx,
        `SELECT DISTINCT b.workspace_id FROM app.knowledge_bases b WHERE EXISTS (SELECT 1 FROM app.knowledge_chunks c WHERE c.base_id = b.id AND c.embedding IS NULL) LIMIT 50`,
        async (tx, workspaceId) => {
          const result = await backfillEmbeddings(ctx, tx, workspaceId);
          if (result.filled > 0) job.log.info(`knowledge: ${String(result.filled)} passage(s) embedded`);
        },
      );
    },
    { cron: '*/10 * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
  ctx.jobs.register(
    GAPS_QUEUE,
    async (_payload, _unusable, job) => {
      await forWorkspaces(ctx, `SELECT DISTINCT workspace_id FROM app.knowledge_gaps WHERE posted_at IS NULL LIMIT 50`, async (tx, workspaceId) => {
        const result = await postGaps(ctx, tx, workspaceId);
        if (result.posted + result.skipped > 0) job.log.info(`knowledge: ${String(result.posted)} unanswered question(s) posted, ${String(result.skipped)} with no #kb-updates`);
      });
    },
    { cron: '*/5 * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}
