import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin downloaded the audit log (PLAN P10-05). Exporting hands a copy of the history out of the system, so the export is itself an
 * audited act: who, when, how many rows, and which signing key signed it. The console shows it like any other row.
 */
export const AuditExportCreatedEvent = z.object({
  type: z.literal('audit.export.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  exportedBy: ActorId,
  rowCount: z.number().int().nonnegative(),
  /** True when the row cap cut the export short; the file then says where to continue. */
  truncated: z.boolean(),
  /** The date range asked for; null for no bound. */
  from: IsoDateTime.nullable(),
  to: IsoDateTime.nullable(),
  /** The id of the signing key the export was signed with. */
  keyId: z.string().min(1).max(64),
  exportedAt: IsoDateTime,
});
export type AuditExportCreatedEvent = z.infer<typeof AuditExportCreatedEvent>;
