import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin changed which sites get a link preview (PLAN P14-08): the switch, the allow list or the deny list. What a rule says is a place the
 * server will or will not read, so a change of it is an audited act: who, when, and how much changed. The event carries counts and the switch, never a
 * host name. Written only when something really changed.
 */
export const LinkPreviewSettingsUpdatedEvent = z.object({
  type: z.literal('linkpreview.settings.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  changedBy: ActorId,
  enabled: z.object({ from: z.boolean(), to: z.boolean() }),
  allowCount: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
  denyCount: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
  at: IsoDateTime,
});
export type LinkPreviewSettingsUpdatedEvent = z.infer<typeof LinkPreviewSettingsUpdatedEvent>;
