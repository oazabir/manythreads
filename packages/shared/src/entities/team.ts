import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, AclEntryId, PersonId, RoleId, TeamId, WorkspaceId } from '../ids.ts';
import { JsonObject } from './kernel.ts';

// PLAN.md A.2 team tables. Enums match the SQL CHECKs in 0006_teams_acl.sql exactly.

/** Team roles (SPEC §5); role tags such as `role:on-call` are `Role`s, not team roles. */
export const TeamRole = z.enum(['lead', 'member']);
export type TeamRole = z.infer<typeof TeamRole>;

export const Team = z.object({
  id: TeamId,
  workspaceId: WorkspaceId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase slug'),
  name: z.string().min(1),
  /** The template id the team was created from (`engineering`), or null. */
  template: z.string().nullable(),
  /** The stored template definition (a `TeamTemplate`), kept as the team record's copy; null without a template. */
  templateDefinition: JsonObject.nullable(),
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Team = z.infer<typeof Team>;

/** A roster row: a person's or a bot's actor. A workspace guest is never a team member. */
export const TeamMember = z.object({
  teamId: TeamId,
  actorId: ActorId,
  workspaceId: WorkspaceId,
  role: TeamRole,
  createdAt: IsoDateTime,
});
export type TeamMember = z.infer<typeof TeamMember>;

/** A role tag mirrored from TEAM.md, named with its prefix (`role:on-call`). */
export const Role = z.object({
  id: RoleId,
  workspaceId: WorkspaceId,
  name: z.string().regex(/^role:[a-z][a-z0-9-]*$/, "role tag like 'role:on-call'"),
  createdAt: IsoDateTime,
});
export type Role = z.infer<typeof Role>;

export const RoleMember = z.object({
  roleId: RoleId,
  personId: PersonId,
  workspaceId: WorkspaceId,
  createdAt: IsoDateTime,
});
export type RoleMember = z.infer<typeof RoleMember>;

export const AclSubjectType = z.enum(['person', 'team', 'role']);
export type AclSubjectType = z.infer<typeof AclSubjectType>;

/** Ordered: `manage` implies `post` implies `read`. */
export const AclPermission = z.enum(['read', 'post', 'manage']);
export type AclPermission = z.infer<typeof AclPermission>;

/** A grant outside team membership: subject (person, team or role) may do `permission` on a resource. */
export const AclEntry = z.object({
  id: AclEntryId,
  workspaceId: WorkspaceId,
  resourceType: z.string().min(1),
  resourceId: z.uuid(),
  subjectType: AclSubjectType,
  subjectId: z.uuid(),
  permission: AclPermission,
  createdAt: IsoDateTime,
});
export type AclEntry = z.infer<typeof AclEntry>;

/** TEAM.md (and other files) held until the team repo exists; `files` maps a repo path to its text. */
export const TeamPendingFile = z.object({
  teamId: TeamId,
  files: z.record(z.string(), z.string()),
  appliedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type TeamPendingFile = z.infer<typeof TeamPendingFile>;
