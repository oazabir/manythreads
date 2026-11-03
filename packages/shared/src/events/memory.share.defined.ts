import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ShareApproval, ShareMode, ShareSlug, ShareStatus } from '../entities/share.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A share's file (`routines/shares/<slug>.yaml`) was read after a commit (PLAN P8-22): accepted (`active`), refused (`invalid`, with a short code of
 * the first problem, never the file) or removed. Slug, counts and codes only.
 */
export const MemoryShareDefinedEvent = z.object({
  type: z.literal('memory.share.defined'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  slug: ShareSlug,
  status: ShareStatus,
  /** The first problem of an invalid file, as a field name (`to`, `select.paths`, `destination`); null otherwise. */
  problem: z.string().max(200).nullable(),
  destinations: z.number().int().min(0),
  mode: ShareMode.nullable(),
  /** What the platform will really do: `auto` only when a lead or admin wrote the file. */
  approval: ShareApproval.nullable(),
  definedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryShareDefinedEvent = z.infer<typeof MemoryShareDefinedEvent>;
