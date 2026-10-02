import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonId, WorkspaceId } from '../ids.ts';
import { JsonObject } from './kernel.ts';

// PLAN.md A.2 `workspaces` and `workspace_members`. WorkspaceRole matches the SQL CHECK in 0004_identity.sql.

/** Workspace roles (SPEC §5). `owner` implies `admin`; a `guest` reads only what an ACL entry grants. */
export const WorkspaceRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/** The tenant. */
export const Workspace = z.object({
  id: WorkspaceId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase slug'),
  name: z.string().min(1),
  selfSignup: z.boolean(),
  settings: JsonObject,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceMember = z.object({
  workspaceId: WorkspaceId,
  personId: PersonId,
  role: WorkspaceRole,
  createdAt: IsoDateTime,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;
