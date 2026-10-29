import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { WorkspaceId } from '../ids.ts';

/**
 * One of the server's health checks tripped or cleared (PLAN P10-10). The health watcher writes it once when a check passes its limit
 * (`breached`) and once when it has stayed back under it for a few rounds (`recovered`), so the event log answers "when did the queue back
 * up and when did it clear". Workspace admins see the same change as a mail and on the System health panel.
 */
export const OpsHealthChangedEvent = z.object({
  type: z.literal('ops.health.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** The check's name: `outbox_lag`, `job_age`, `run_slots`, `approval_age`, `volume_blobs`, `volume_repos`, `budget_burn`, `db_connections`. */
  check: z.string().min(1).max(60),
  state: z.enum(['breached', 'recovered']),
  /** What the check measured when it changed state, in `unit`. */
  value: z.number(),
  /** The limit it is held against, in `unit`. */
  threshold: z.number(),
  unit: z.enum(['percent', 'seconds']),
  /** When the check first passed its limit in this episode (for `recovered`, the start of the episode that just ended). */
  since: IsoDateTime,
  changedAt: IsoDateTime,
});
export type OpsHealthChangedEvent = z.infer<typeof OpsHealthChangedEvent>;
