import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** An admin changed the workspace's General settings (audit). `changes` carries only the fields that changed, with their new values. */
export const WorkspaceSettingsUpdatedEvent = z.object({
  type: z.literal('workspace.settings.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** The admin who made the change. */
  personId: PersonId,
  changes: z.object({
    name: z.string().optional(),
    selfSignup: z.boolean().optional(),
    passwordForMembers: z.boolean().optional(),
  }),
});
export type WorkspaceSettingsUpdatedEvent = z.infer<typeof WorkspaceSettingsUpdatedEvent>;
