import { z } from 'zod';
import { Team, TeamRole } from '../../entities/team.ts';
import { reservedTagReason } from '../../markup/role-handles.ts';

/** A team's URL slug (`engineering`); the same rule as the `teams.slug` CHECK. */
export const TeamSlug = Team.shape.slug;
export type TeamSlug = z.infer<typeof TeamSlug>;

/** A role tag with its prefix, e.g. `role:on-call`. */
export const RoleTagName = z.string().regex(/^role:[a-z][a-z0-9-]*$/, "role tag like 'role:on-call'");
export type RoleTagName = z.infer<typeof RoleTagName>;

/**
 * A role tag a team may newly define: `RoleTagName` without the reserved words (`role:admin`, `role:here`, ...; `reservedTagReason` is the one list). Used where a
 * tag is created; reading, assigning-by-name of existing tags and deleting keep `RoleTagName`, so an old tag with such a word can still be cleaned up.
 */
export const DefinableRoleTagName = RoleTagName.superRefine((tag, ctx) => {
  const reason = reservedTagReason(tag);
  if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
});

/** A channel a guest invitation will grant, by team and name (applied when the invitation is accepted, if the channel exists). */
export const GuestChannelGrant = z.strictObject({
  teamSlug: TeamSlug,
  channel: z.string().regex(/^#[a-z0-9][a-z0-9-]{0,62}$/, "channel name like '#releases'"),
  /** `read` (the default when absent) or `post`: a guest posts only where the grant says so. */
  permission: z.enum(['read', 'post']).optional(),
});
export type GuestChannelGrant = z.infer<typeof GuestChannelGrant>;

/** What the team list shows: the team without its stored template definition. */
export const TeamSummary = Team.omit({ templateDefinition: true }).extend({
  /** The caller's role in the team; null for a workspace admin who is not a member. */
  myRole: TeamRole.nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type TeamSummary = z.infer<typeof TeamSummary>;

/** One team with the stored template definition, as `GET /api/teams/:slug` returns it. */
export const TeamDetail = Team.extend({
  myRole: TeamRole.nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type TeamDetail = z.infer<typeof TeamDetail>;
