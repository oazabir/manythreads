import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId } from '../entities/inbox.ts';
import { TeamId, WorkspaceId } from '../ids.ts';

/** Why a whole bundle was refused. A short code; the plain sentence is on the inbox item. */
export const DigestImportRefusal = z.enum([
  'not_a_bundle',
  'unsafe_path',
  'link_entry',
  'encrypted',
  'too_many_files',
  'too_large',
  'not_utf8',
  'bad_index',
  'bad_concept',
  'link_ended',
  'not_found',
]);
export type DigestImportRefusal = z.infer<typeof DigestImportRefusal>;

/**
 * A received bundle (another team's digest, or an OKF bundle dropped from outside) was checked and either filed under `memory/shared/` or refused as a
 * whole (PLAN P8-25). `fromTeamId` is the sending team for a digest and null for an outside bundle. Ids, counts and a reason code only.
 */
export const MemoryDigestImportedEvent = z.object({
  type: z.literal('memory.digest.imported'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  fromTeamId: TeamId.nullable(),
  outcome: z.enum(['filed', 'refused']),
  reason: DigestImportRefusal.nullable(),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  at: IsoDateTime,
});
export type MemoryDigestImportedEvent = z.infer<typeof MemoryDigestImportedEvent>;
