import { definePlugin, type PluginContext } from '@manythreads/sdk';
import { RetentionSweepSummary } from '@manythreads/shared';
import { retentionMode } from './config.ts';
import { registerRoutes } from './routes.ts';
import { PRUNE_QUEUE, SWEEP_QUEUE, SweepState, startSweep, sweepStep } from './sweep.ts';

export { retentionBatch, retentionMode } from './config.ts';
export { PRUNE_QUEUE, SWEEP_QUEUE, SweepState, emptyCounts, loadWindows, startSweep, sweepStep } from './sweep.ts';

/**
 * retention (PLAN P5-14; SPEC §15): run logs are kept for a window (90 days by default, per workspace within bounds) and then pruned, in small
 * batches, by a daily sweep. It deletes run logs and the memory feed's own bookkeeping and never the audit trail: `events`, approvals and their
 * decisions, the spend ledger, withheld lines and the newest state of any source are outside its reach. The deployment's mode
 * (`MANYTHREADS_RETENTION`) is `dry-run` unless an operator says `on`. docs/plugins/retention.md.
 */
export default definePlugin({
  manifest: {
    name: 'retention',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['retention.sweep.completed', 'retention.settings.changed'], consumes: [] },
    // bot_runs and run_source_log (bots), the memo and the log's pruning door (memory), the approvals a run may still be needed by.
    dependsOn: ['bots', 'memory', 'approvals'],
    migrations: 'migrations',
  },
  register(ctx: PluginContext) {
    registerRoutes(ctx);

    // The daily sweep (03:07 UTC): one chain of `retention.prune` jobs per workspace. Dry run unless the deployment says `on`.
    ctx.jobs.register(
      SWEEP_QUEUE,
      async (_payload, tx, job) => {
        const mode = retentionMode();
        if (mode === 'off') {
          job.log.info('retention: switched off (MANYTHREADS_RETENTION=off)');
          return;
        }
        const now = ctx.runtime.now();
        const day = now.toISOString().slice(0, 10);
        const workspaces = await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id');
        for (const w of workspaces.rows) {
          const state = await startSweep(tx, w.id, now, mode !== 'on');
          await ctx.jobs.enqueue(tx, PRUNE_QUEUE, state, { dedupeKey: `sweep:${w.id}:${day}` });
        }
        job.log.info(`retention: ${workspaces.rows.length} workspace(s) queued (${mode})`);
      },
      { cron: '7 3 * * *', maxAttempts: 1, concurrency: 1 },
    );

    // One step of one workspace's sweep: a batch of one phase in one transaction, then the next step or the end.
    ctx.jobs.register(PRUNE_QUEUE, async (payload, tx, job) => {
      const parsed = SweepState.safeParse(payload);
      if (!parsed.success) {
        job.log.warn('retention: a prune job with a payload it cannot read was dropped');
        return;
      }
      const state = parsed.data;
      const mode = retentionMode();
      // A deployment that switched retention off stops a sweep in the middle; one that left dry-run turns a queued real sweep into a dry run
      // rather than deleting under a mode that did not ask for it.
      if (mode === 'off') return;
      const effective = mode === 'on' ? state : { ...state, dryRun: true };
      const result = await sweepStep(tx, effective);
      if (!result.done) {
        await ctx.jobs.enqueue(tx, PRUNE_QUEUE, result.state, { dedupeKey: `step:${state.sweepId}:${result.state.step}` });
        return;
      }
      const summary = RetentionSweepSummary.parse(result.summary);
      await tx.query(
        `INSERT INTO app.retention_settings (workspace_id, last_sweep) VALUES ($1::uuid, $2::jsonb)
         ON CONFLICT (workspace_id) DO UPDATE SET last_sweep = EXCLUDED.last_sweep`,
        [state.workspaceId, JSON.stringify(summary)],
      );
      await ctx.audit.emit(tx, {
        type: 'retention.sweep.completed',
        workspaceId: state.workspaceId,
        sweepId: summary.sweepId,
        dryRun: summary.dryRun,
        runLogCutoff: summary.runLogCutoff,
        memoryLogCutoff: summary.memoryLogCutoff,
        counts: summary.counts,
        durationMs: result.durationMs,
      });
      const c = summary.counts;
      job.log.info(
        `retention: workspace ${state.workspaceId} ${summary.dryRun ? 'dry run: would prune' : 'pruned'} ${c.runs} run(s) (${c.runSourceLines} source line(s), ${c.runTokens} token(s), ${c.runMemos} memo(s)), ${c.memoryLogLines} log line(s), ${c.memosRemoved} memo(s) of removed bots`,
      );
    });
  },
});
