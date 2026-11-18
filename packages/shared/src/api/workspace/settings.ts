import { z } from 'zod';
import { WorkspaceId, PersonId } from '../../ids.ts';
import { PersonStatus } from '../../entities/person.ts';
import { WorkspaceRole } from '../../entities/workspace.ts';
import type { ApiRoute } from '../client/route.ts';

/** The workspace's General settings (Settings, General). Workspace admins and owners only; everyone else gets 404. */
export const WorkspaceSettings = z.object({
  id: WorkspaceId,
  name: z.string().min(1),
  /** The short name used in addresses (lowercase letters, digits and "-"). */
  slug: z.string().min(1),
  /** The workspace's time zone (an IANA name such as `Europe/Berlin`), or null when none was chosen; digests and schedules read it. */
  timeZone: z.string().nullable().default(null),
  /** Anyone with an allowed email domain may create their own account. Off by default. */
  selfSignup: z.boolean(),
  /** Plain members may use the password form. Admins and owners always can, so a broken provider never locks everyone out. */
  passwordForMembers: z.boolean(),
  /**
   * The server writes the words of voice messages (the first 20 seconds, with the speech model inside this deployment; P32, decision D13). On by default; an admin
   * switches it off in Settings, Workspace. Off: a new voice message has no transcript (`meta.voice.transcript` is `none`). Messages already sent are not changed.
   */
  voiceTranscripts: z.boolean(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const GetWorkspaceResponse = z.object({ workspace: WorkspaceSettings });
export type GetWorkspaceResponse = z.infer<typeof GetWorkspaceResponse>;
export const getWorkspaceRoute = { method: 'GET', path: '/api/workspace' } as const satisfies ApiRoute;

/** Only the fields present change; at least one is required. */
export const UpdateWorkspaceRequest = z
  .strictObject({
    name: z.string().trim().min(1, 'Enter a workspace name.').max(80, 'Workspace name must be at most 80 characters.').optional(),
    /** An IANA time-zone name; checked by the server against the zones it knows. */
    timeZone: z.string().trim().min(1).max(64).optional(),
    selfSignup: z.boolean().optional(),
    passwordForMembers: z.boolean().optional(),
    voiceTranscripts: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change at least one setting.' });
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;
export const UpdateWorkspaceResponse = GetWorkspaceResponse;
export type UpdateWorkspaceResponse = GetWorkspaceResponse;
export const updateWorkspaceRoute = { method: 'PATCH', path: '/api/workspace' } as const satisfies ApiRoute;

/**
 * Change a member's workspace role. The workspace always keeps at least one owner: demoting the last owner is 409.
 * Only an owner grants or changes `owner`.
 *
 * `status: 'suspended'` deactivates the member (P20-13): they cannot sign in, their sessions end, and their Personal space is deleted 30 days later;
 * `status: 'active'` reactivates them and stops that clock. 409 when it would leave the workspace without an active owner, 400 for your own account.
 * Send `role`, `status` or both; the answer carries both as they are now.
 */
export const UpdateWorkspaceMemberRequest = z
  .strictObject({ role: WorkspaceRole.optional(), status: PersonStatus.optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, { message: 'Change the role or the status.' });
export type UpdateWorkspaceMemberRequest = z.infer<typeof UpdateWorkspaceMemberRequest>;
export const UpdateWorkspaceMemberResponse = z.object({ personId: PersonId, role: WorkspaceRole, status: PersonStatus });
export type UpdateWorkspaceMemberResponse = z.infer<typeof UpdateWorkspaceMemberResponse>;
export const updateWorkspaceMemberRoute = { method: 'PATCH', path: '/api/workspace/members/:personId' } as const satisfies ApiRoute;
