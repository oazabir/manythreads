import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** The first workspace was created through the one-time bootstrap link; `personId` is its owner. */
export const IdentityWorkspaceBootstrappedEvent = z.object({
  type: z.literal('identity.workspace.bootstrapped'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  workspaceName: z.string().min(1),
});
export type IdentityWorkspaceBootstrappedEvent = z.infer<typeof IdentityWorkspaceBootstrappedEvent>;
