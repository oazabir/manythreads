import type { PluginContext } from '@manythreads/sdk';
import { ListWorkspaceMembersResponse, listWorkspaceMembersRoute } from '@manythreads/shared';
import { json, notFound, route } from './http.ts';
import { isWorkspaceAdmin } from './teams.ts';

interface MemberRow extends Record<string, unknown> {
  person_id: string;
  display_name: string;
  primary_email: string;
  status: string;
  role: string;
  tags: string[];
  created_at: Date;
}

export function registerWorkspaceRoutes(ctx: PluginContext): void {
  // Workspace settings do not exist for anyone below admin: 404, not 403.
  ctx.http.route({
    ...listWorkspaceMembersRoute,
    schema: { response: ListWorkspaceMembersResponse },
    handler: route(async (_req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const res = await tx.query<MemberRow>(
        `SELECT p.id AS person_id, p.display_name, p.primary_email, p.status, wm.role, wm.created_at,
                coalesce((SELECT array_agg(r.name ORDER BY r.name) FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id
                          WHERE rm.person_id = p.id), '{}'::text[]) AS tags
         FROM app.workspace_members wm JOIN app.people p ON p.id = wm.person_id
         WHERE wm.workspace_id = app.workspace_id()
         ORDER BY lower(p.display_name), p.id`,
      );
      return json(
        ListWorkspaceMembersResponse.parse({
          members: res.rows.map((r) => ({
            personId: r.person_id,
            displayName: r.display_name,
            email: r.primary_email,
            status: r.status,
            role: r.role,
            tags: r.tags,
            joinedAt: r.created_at.toISOString(),
          })),
        }),
      );
    }),
  });
}
