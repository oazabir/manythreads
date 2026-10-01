# teams

Team templates, teams, roster, team roles, role tags and invitations (SPEC section 5, PLAN P2-08 and P2-09).
Code: `packages/plugins/teams`. Request and response schemas: `packages/shared/src/api/teams`. Events:
`packages/shared/src/events/{team,workspace}.*`.

## Who may do what

| Action | Who | Otherwise |
|---|---|---|
| List teams | anyone signed in; row level security returns only the teams the caller sees (members, and workspace admins see all) | empty list (a guest) |
| Read a team, roster, tags | members of the team, workspace admins | 403 (never 404, so existence is not revealed); a missing slug is 404 only for an admin |
| Create a team or apply a template | workspace owner or admin; the creator becomes `lead` | 403 |
| Rename, archive, unarchive, add or remove members, set a team role, define or give role tags, invite to the team | team `lead` or workspace admin | 403 |
| Leave a team | the member themself | |
| Invite an admin, a member without a team, or a guest | workspace admin | 403 |
| `GET /api/workspace/members` | workspace admin | 404 (workspace settings do not exist for anyone else) |

An archived team is read-only (409 on changes) until unarchived.

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/templates`, `GET /api/templates/:id` | The five shipped templates (summaries, then one with its `TEAM.md`). Read from `templates/` at the repo root, or `MANYTHREADS_TEMPLATES_DIR`. |
| `POST /api/teams/from-template` `{templateId, name?, slug?}` | Creates the team (template id and the full definition stored, creator `lead`, role tags defined, `TEAM.md` held with `app.put_team_pending_files`) and emits `workspace.team.created` and `team.template.applied`. 201 `created: true`. **Idempotent:** the same template for the same slug again returns the existing team (200, `created: false`) and writes nothing; a slug taken by another template or a hand-made team is 409. The get-or-create is one `INSERT ... ON CONFLICT (workspace_id, slug) DO SELECT`. |
| `POST /api/teams` `{name, slug?}` | A blank team. 409 when the slug exists. |
| `GET /api/teams?includeArchived=true`, `GET /api/teams/:slug` | List (team without its definition, caller's `myRole`, `memberCount`) and detail (with the stored definition). |
| `PATCH /api/teams/:slug` `{name}`, `POST .../archive`, `POST .../unarchive` | Rename (the slug never changes), archive, restore. |
| `GET /api/teams/:slug/roster` | People with team role, workspace role and the team's role tags they hold. |
| `POST /api/teams/:slug/members` `{personId, role?}`, `PATCH .../members/:personId` `{role}`, `DELETE .../members/:personId` | Add (a guest is refused, 409), set `lead` or `member`, remove. Removing a member also removes the tags that team gave them, unless another team of theirs defines the same tag. |
| `GET/POST /api/teams/:slug/tags`, `DELETE .../tags/:tag` | The team's role tags (`role:on-call`): list with holders, define, delete (removes it from every holder on the team, and the workspace role when no other team defines it). |
| `PUT/DELETE /api/teams/:slug/members/:personId/tags/:tag` | Give or take a tag. Giving a tag the team never defined defines it first. |
| `POST /api/teams/:slug/invitations` `{email, teamRole?}`, `GET` the same path | Invite to the team (workspace role `member`). The response carries the one-time `token`; only its sha256 is stored. Also mailed with the `invite` template (best effort). |
| `POST /api/invitations` `{email, role, channels?}` | Admin only. `admin` or `member` without a team, or `guest` with `channels: [{teamSlug, channel}]`, which are recorded in `grant.channels` (with the team id) for the channels plugin to apply; a guest invitation never has a team. |
| `GET /api/invitations/:token`, `POST /api/invitations/:token/accept` `{name?}` | Public (the token is the credential; rate limited). Accept finds or creates the person and their actor, grants the workspace role (never lowers one; a guest invited as a member is promoted), seats them on the team, and marks the invitation used. A used or expired token is **410** `gone`, an unknown one 404, a suspended person 403. Setting a password and starting a session is the sign-in plugin's step after accepting. |
| `GET /api/workspace/members` | Admin only: everyone with workspace role and all role tags they hold. |

## Role tags

`roles` and `role_members` stay workspace-wide because an ACL entry may name a role. The plugin adds `team_role_tags`
(which team defines which tag, the mirror of `TEAM.md` `roleTags`). A roster shows the tags a person holds that the team
defines. Assigning a tag someone already holds elsewhere still counts as an assignment for the roster and emits the event.

## Events

All schema version 1, registered in `packages/shared/src/events/registry.ts`, written as the acting person in the same
transaction as the change. Names follow `domain.noun.verb`, so team lifecycle and invitations live under `workspace.`.

| Type | Payload (besides `workspaceId`) |
|---|---|
| `workspace.team.created` | `teamId, slug, name, template` |
| `team.template.applied` | `teamId, slug, templateId, templateVersion` (the channels plugin creates channels from it) |
| `workspace.team.renamed` | `teamId, previousName, name` |
| `workspace.team.archived`, `workspace.team.unarchived` | `teamId` |
| `team.member.added` | `teamId, personId, role` |
| `team.member.removed` | `teamId, personId, role, tags` |
| `team.role.changed` | `teamId, personId, previousRole, role` |
| `team.tag.created` | `teamId, tag, roleId` |
| `team.tag.deleted` | `teamId, tag, removedFrom` |
| `team.tag.assigned`, `team.tag.removed` | `teamId, personId, tag` |
| `workspace.invitation.created` | `teamId` (null for workspace and guest invitations), `invitationId, email, role, teamRole` |
| `workspace.invitation.accepted` | `teamId, invitationId, personId, role, teamRole, createdPerson` (written by the accept function as the new person) |

Tokens never appear in an event.

## Database

Migration `0001_teams_api.sql`: table `team_role_tags` (`rls: team`; members and admins read, system writes) and
`SECURITY DEFINER` functions owned by `manythreads_system`, each checking the caller itself with `app.lookup_can`:
`teams_roster`, `teams_add_member`, `teams_set_member_role`, `teams_remove_member`, `teams_tag_define|drop|assign|unassign`,
`teams_invitation_info`, `teams_invitation_accept`. They exist because `app.actors` is own-row only (a roster cannot join
it), roles and role members are admin-write, and the person accepting an invitation has no actor yet.

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `teams` / `0.1.0` / `server` |
| extends | `event.emit` |
| events | emits the fourteen types above, consumes nothing |
| migrations | `migrations` |

## Tests

`packages/plugins/teams/test/teams-api.test.ts` (apply, idempotency, criterion 6, roster, roles, tags, invitations),
`test/events/teams-events.test.ts` (`pnpm test:events`, every event parses against its registered schema),
`test/rls/teams-plugin.test.ts` (`pnpm test:rls`), and `e2e/api/identity/rls.spec.ts` (`pnpm e2e --project=api`).
