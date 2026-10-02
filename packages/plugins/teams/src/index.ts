import { definePlugin } from '@manythreads/sdk';
import { registerInvitationRoutes } from './routes-invitations.ts';
import { registerRosterRoutes } from './routes-roster.ts';
import { registerTagRoutes } from './routes-tags.ts';
import { registerTeamRoutes } from './routes-teams.ts';
import { registerTemplateRoutes } from './routes-templates.ts';
import { registerWorkspaceRoutes } from './routes-workspace.ts';

/**
 * Teams: templates, teams, roster, team roles, role tags and invitations (SPEC section 5, templates and the teams API).
 * Every mutation emits a registry event as the caller; docs/plugins/teams.md lists them.
 */
export default definePlugin({
  manifest: {
    name: 'teams',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    events: {
      emits: [
        'workspace.team.created',
        'workspace.team.renamed',
        'workspace.team.archived',
        'workspace.team.unarchived',
        'team.template.applied',
        'team.member.added',
        'team.member.removed',
        'team.role.changed',
        'team.tag.created',
        'team.tag.deleted',
        'team.tag.assigned',
        'team.tag.removed',
        'workspace.invitation.created',
        'workspace.invitation.accepted',
        'workspace.settings.updated',
        'workspace.member.role_changed',
      ],
      consumes: [],
    },
    migrations: 'migrations',
  },
  async register(ctx) {
    // Templates are read (and validated) at start-up so a broken template file stops the server, not the first request.
    await ctx.templates.list();
    const deps = { templates: ctx.templates, db: ctx.db, emit: ctx.audit.emit };
    registerTemplateRoutes(ctx, deps);
    registerTeamRoutes(ctx, deps);
    registerRosterRoutes(ctx, deps);
    registerTagRoutes(ctx, deps);
    registerInvitationRoutes(ctx, deps);
    registerWorkspaceRoutes(ctx, deps);
  },
});
