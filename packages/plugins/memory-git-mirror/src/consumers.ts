import { ensureMemoryWorkspaceKey, noteMemoryNotConfigured, type MemoryProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { RepoRepoCommittedEvent, isConceptPath } from '@manythreads/shared';
import { mirrorTuning } from './config.ts';
import { DRAIN_QUEUE, ENSURE_QUEUE } from './constants.ts';
import { conceptSourceId } from './render.ts';

// The event subscription. It runs inside the outbox consumer's transaction, next to every other plugin's, so it does cheap things and nothing
// else: it writes "this concept changed" into the work list (one row per concept, a repeat only moves its time), queues the drain, and — the
// first time a team's memory is touched — queues the job that writes the bundle root. It never reads a file, never calls the engine, and never
// throws for anything but a database failure: a bad payload is ignored, an absent engine is one log line a day.

export const CONSUMED_EVENTS = ['repo.repo.committed'] as const;

/**
 * Queues a drain for after the debounce. Changes that land in the same time bucket share one job (its dedupe key is the bucket), and a job that
 * is already running holds a bucket that has passed, so a change that arrives mid-drain always gets a drain of its own: a single fixed key would
 * hand it to the running job, which has already read its list.
 */
export async function queueDrain(ctx: PluginContext, tx: PluginTx): Promise<void> {
  const { debounceMs } = mirrorTuning();
  const bucketMs = Math.max(1_000, debounceMs);
  const due = ctx.runtime.now().getTime() + debounceMs;
  const bucket = Math.floor(due / bucketMs);
  await ctx.jobs.enqueue(tx, DRAIN_QUEUE, {}, { runAt: new Date((bucket + 1) * bucketMs), dedupeKey: `mirror:bucket:${bucket}` });
}

export function registerConsumers(ctx: PluginContext): void {
  ctx.events.subscribe('repo.repo.committed', async (raw, tx) => {
    const parsed = RepoRepoCommittedEvent.safeParse(raw);
    if (!parsed.success) return;
    const { workspaceId, teamId, paths } = parsed.data;
    const underMemory = paths.filter((p) => p.path.startsWith('memory/'));
    if (underMemory.length === 0) return;

    const provider = ctx.providers.get<MemoryProvider>('memory');
    const enabled = provider !== undefined && provider.enabled;

    // First use of a team's memory writes its bundle root, once (not on a deployment with no engine: there the bundle is just files, and nothing of
    // this plugin changes a team's repository).
    if (enabled) {
      const known = await tx.query('SELECT 1 FROM app.memory_mirror_teams WHERE team_id = $1::uuid', [teamId]);
      if (known.rows.length === 0) {
        await ctx.jobs.enqueue(tx, ENSURE_QUEUE, { workspaceId, teamId }, { dedupeKey: `ensure:${teamId}` });
      }
    }

    let wanted = [...new Set(underMemory.map((p) => p.path).filter(isConceptPath))].filter((p) => p.length <= 1_024);
    if (wanted.length === 0) return;
    if (!enabled) {
      // One line per team per day says the mirror is off. The change itself is queued only when the bank holds a document for the concept: a delete
      // or an edit made while the engine is off must still take that document out when it is back.
      const ids = wanted.map((p) => conceptSourceId(teamId, p));
      const held = await noteMemoryNotConfigured(tx, { workspaceId, teamId, kinds: ids.map(() => 'concept'), ids });
      if (held.length === 0) return;
      const heldIds = new Set(held.map((h) => h.id));
      wanted = wanted.filter((p) => heldIds.has(conceptSourceId(teamId, p)));
    }
    // The digest key exists before any drain needs it, committed with the work row (the drain only reads it).
    await ensureMemoryWorkspaceKey(tx, workspaceId);
    const { debounceMs } = mirrorTuning();
    await tx.query(
      `INSERT INTO app.memory_mirror_pending (team_id, path, workspace_id, not_before)
       SELECT $1::uuid, p.path, $2::uuid, now() + $3::float8 * interval '1 millisecond' FROM unnest($4::text[]) AS p(path)
       ON CONFLICT (team_id, path)
         DO UPDATE SET requested_at = now(), not_before = EXCLUDED.not_before, attempts = 0, last_error = ''`,
      [teamId, workspaceId, debounceMs, wanted],
    );
    await queueDrain(ctx, tx);
  });
}
