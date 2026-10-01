import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { PersonId } from '../../ids.ts';
import { PersonStatus } from '../../entities/person.ts';
import { WorkspaceRole } from '../../entities/workspace.ts';
import { RoleTagName } from './common.ts';

/** A workspace member with their workspace role and every role tag they hold. */
export const WorkspaceMemberSummary = z.object({
  personId: PersonId,
  displayName: z.string(),
  email: z.string(),
  status: PersonStatus,
  role: WorkspaceRole,
  tags: z.array(RoleTagName),
  joinedAt: IsoDateTime,
});
export type WorkspaceMemberSummary = z.infer<typeof WorkspaceMemberSummary>;

/** Workspace admins only; everyone else gets 404 (workspace settings do not exist for them). */
export const ListWorkspaceMembersResponse = z.object({ members: z.array(WorkspaceMemberSummary) });
export type ListWorkspaceMembersResponse = z.infer<typeof ListWorkspaceMembersResponse>;
export const listWorkspaceMembersRoute = { method: 'GET', path: '/api/workspace/members' } as const;
