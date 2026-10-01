import {
  Invitation,
  RosterMember,
  Team,
  TeamDetail,
  TeamSummary,
  TemplateSummary,
  type TeamTemplate,
} from '@manythreads/shared';

// Plugins may not import the kernel's mappers, so the rows this plugin reads are turned into shared types here.
// Each function is the only place its row becomes that type.

export type TeamRow = {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  template: string | null;
  template_definition: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  my_role?: string | null;
  member_count?: number;
}

export const TEAM_COLUMNS =
  't.id, t.workspace_id, t.slug, t.name, t.template, t.template_definition, t.archived_at, t.created_at, t.updated_at';
/** Columns plus the caller's role and the roster size, for the detail and list shapes. */
export const TEAM_WITH_COUNTS = `${TEAM_COLUMNS}, app.team_role(t.id) AS my_role,
  (SELECT count(*)::int FROM app.team_members tm WHERE tm.team_id = t.id) AS member_count`;

const teamFields = (row: TeamRow) => ({
  id: row.id,
  workspaceId: row.workspace_id,
  slug: row.slug,
  name: row.name,
  template: row.template,
  templateDefinition: row.template_definition,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

// app.team_role() answers 'system' for the system actor; a person's request never sees it, and a client gets null.
const myRole = (row: TeamRow): 'lead' | 'member' | null => (row.my_role === 'lead' || row.my_role === 'member' ? row.my_role : null);

export const toTeam = (row: TeamRow): Team => Team.parse(teamFields(row));
export const toTeamDetail = (row: TeamRow): TeamDetail =>
  TeamDetail.parse({ ...teamFields(row), myRole: myRole(row), memberCount: row.member_count ?? 0 });
export const toTeamSummary = (row: TeamRow): TeamSummary =>
  TeamSummary.parse({ ...teamFields(row), myRole: myRole(row), memberCount: row.member_count ?? 0 });

export type RosterRow = {
  actor_id: string;
  person_id: string;
  display_name: string;
  email: string;
  workspace_role: string;
  team_role: string;
  tags: string[];
  joined_at: Date;
}

export const toRosterMember = (row: RosterRow): RosterMember =>
  RosterMember.parse({
    personId: row.person_id,
    actorId: row.actor_id,
    displayName: row.display_name,
    email: row.email,
    workspaceRole: row.workspace_role,
    role: row.team_role,
    tags: row.tags,
    joinedAt: row.joined_at.toISOString(),
  });

export type InvitationRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  email: string;
  role: string;
  grant_spec: unknown;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

export const INVITATION_COLUMNS =
  'id, workspace_id, team_id, email, role, grant_spec, invited_by, expires_at, accepted_at, created_at';

/** `token_hash` is never selected: the token exists once, in the create response. */
export const toInvitation = (row: InvitationRow): Invitation =>
  Invitation.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    email: row.email,
    role: row.role,
    grant: row.grant_spec,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });

export const toTemplateSummary = (t: TeamTemplate): TemplateSummary =>
  TemplateSummary.parse({
    id: t.id,
    name: t.name,
    description: t.description,
    version: t.version,
    channels: t.channels.map((c) => c.name),
    board: t.board.name,
    bots: t.bots.map((b) => ({ slug: b.slug, name: b.name, role: b.role, automation: b.automation ?? false })),
    roleTags: t.roleTags,
  });
