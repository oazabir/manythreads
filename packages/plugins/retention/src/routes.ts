import { conflict, forbidden, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  PreviewRetentionResponse,
  RetentionSettingsResponse,
  RetentionSweepSummary,
  SetRetentionSettingsRequest,
  getRetentionSettingsRoute,
  previewRetentionRoute,
  setRetentionSettingsRoute,
  type RetentionSettings,
} from '@manythreads/shared';
import { retentionMode } from './config.ts';
import { loadWindows, PRUNE_QUEUE, startSweep } from './sweep.ts';

// Workspace → Retention: read and change how many days of run logs and memory bookkeeping the workspace keeps, and ask for a dry run. Workspace
// owners and admins only (the table's policy says the same; a team lead's team is not the workspace). A change is an audited event.

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can manage retention.');
}

async function loadSettings(tx: PluginTx, workspaceId: string): Promise<RetentionSettings> {
  const windows = await loadWindows(tx, workspaceId);
  const row = (
    await tx.query<{ last_sweep: unknown; updated_at: Date | null }>('SELECT last_sweep, updated_at FROM app.retention_settings WHERE workspace_id = $1::uuid', [workspaceId])
  ).rows[0];
  const last = row?.last_sweep === null || row?.last_sweep === undefined ? null : RetentionSweepSummary.safeParse(row.last_sweep);
  return {
    runLogDays: windows.runLogDays,
    memoryLogDays: windows.memoryLogDays,
    mode: retentionMode(),
    lastSweep: last !== null && last.success ? last.data : null,
    updatedAt: row?.updated_at?.toISOString() ?? null,
  };
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: getRetentionSettingsRoute.method,
    path: getRetentionSettingsRoute.path,
    schema: { response: RetentionSettingsResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      return json({ settings: await loadSettings(tx, tx.actor.workspaceId) });
    }),
  });

  ctx.http.route({
    method: setRetentionSettingsRoute.method,
    path: setRetentionSettingsRoute.path,
    schema: { body: SetRetentionSettingsRequest, response: RetentionSettingsResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = SetRetentionSettingsRequest.parse(req.body);
      const before = await loadWindows(tx, tx.actor.workspaceId);
      const next = { runLogDays: body.runLogDays ?? before.runLogDays, memoryLogDays: body.memoryLogDays ?? before.memoryLogDays };
      await tx.query(
        `INSERT INTO app.retention_settings AS s (workspace_id, run_log_days, memory_log_days, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, now())
         ON CONFLICT (workspace_id) DO UPDATE SET run_log_days = EXCLUDED.run_log_days, memory_log_days = EXCLUDED.memory_log_days,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tx.actor.workspaceId, next.runLogDays, next.memoryLogDays, tx.actor.id],
      );
      if (next.runLogDays !== before.runLogDays || next.memoryLogDays !== before.memoryLogDays) {
        await ctx.audit.emit(tx, {
          type: 'retention.settings.changed',
          workspaceId: tx.actor.workspaceId,
          changedBy: tx.actor.id,
          runLogDays: { from: before.runLogDays, to: next.runLogDays },
          memoryLogDays: { from: before.memoryLogDays, to: next.memoryLogDays },
          changedAt: ctx.runtime.now().toISOString(),
        });
      }
      return json({ settings: await loadSettings(tx, tx.actor.workspaceId) });
    }),
  });

  ctx.http.route({
    method: previewRetentionRoute.method,
    path: previewRetentionRoute.path,
    schema: { response: PreviewRetentionResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      if (retentionMode() === 'off') throw conflict('Retention is switched off in this deployment.');
      // A dry run whatever the deployment's mode: it counts what the window would remove and deletes nothing. Its result is `lastSweep`.
      // The job runs as the system, so the state is made here only to hand it the cutoffs (`startSweep` reads the workspace's windows).
      const state = await startSweep(tx, tx.actor.workspaceId, ctx.runtime.now(), true);
      await ctx.jobs.enqueue(tx, PRUNE_QUEUE, { ...state, workspaceId: tx.actor.workspaceId }, { dedupeKey: `preview:${tx.actor.workspaceId}` });
      return json({ queued: true as const }, 202);
    }),
  });
}
