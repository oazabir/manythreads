import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  GetWorkspaceResponse,
  ListWorkspaceMembersResponse,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceMemberResponse,
  UpdateWorkspaceRequest,
  UpdateWorkspaceResponse,
  getWorkspaceRoute,
  listWorkspaceMembersRoute,
  updateWorkspaceMemberRoute,
  updateWorkspaceRoute,
  type WorkspaceSettings,
} from '@manythreads/shared';
import { z } from 'zod';
import { forbidden, json, notFound, route } from './http.ts';
import { isWorkspaceAdmin, type Deps } from './teams.ts';

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  self_signup: boolean;
  /** `settings.passwordForMembers` as text: only the literal `false` turns the password form off for members. */
  pfm: string | null;
}

const WORKSPACE_SQL = `SELECT w.id, w.name, w.self_signup, w.settings ->> 'passwordForMembers' AS pfm FROM app.workspaces w WHERE w.id = app.workspace_id()`;

const toSettings = (r: WorkspaceRow): WorkspaceSettings =>
  ({ id: r.id, name: r.name, selfSignup: r.self_signup, passwordForMembers: r.pfm !== 'false' }) as WorkspaceSettings;

async function currentPersonId(tx: PluginTx): Promise<string> {
  const res = await tx.query<{ id: string | null }>('SELECT app.person_id() AS id');
  const id = res.rows[0]?.id;
  if (!id) throw forbidden();
  return id;
}

const MemberParams = z.object({ personId: z.uuid() });

interface MemberRow extends Record<string, unknown> {
  person_id: string;
  display_name: string;
  primary_email: string;
  status: string;
  role: string;
  tags: string[];
  created_at: Date;
}

export function registerWorkspaceRoutes(ctx: PluginContext, { emit }: Deps): void {
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
  ctx.http.route({
    ...getWorkspaceRoute,
    schema: { response: GetWorkspaceResponse },
    handler: route(async (_req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const res = await tx.query<WorkspaceRow>(WORKSPACE_SQL);
      const row = res.rows[0];
      if (!row) throw notFound('Not found');
      return json(GetWorkspaceResponse.parse({ workspace: toSettings(row) }));
    }),
  });

  ctx.http.route({
    ...updateWorkspaceRoute,
    schema: { body: UpdateWorkspaceRequest, response: UpdateWorkspaceResponse },
    handler: route(async (req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const body = UpdateWorkspaceRequest.parse(req.body);
      const before = (await tx.query<WorkspaceRow>(`${WORKSPACE_SQL} FOR UPDATE OF w`)).rows[0];
      if (!before) throw notFound('Not found');
      const was = toSettings(before);
      const changes: { name?: string; selfSignup?: boolean; passwordForMembers?: boolean } = {};
      if (body.name !== undefined && body.name !== was.name) changes.name = body.name;
      if (body.selfSignup !== undefined && body.selfSignup !== was.selfSignup) changes.selfSignup = body.selfSignup;
      if (body.passwordForMembers !== undefined && body.passwordForMembers !== was.passwordForMembers) {
        changes.passwordForMembers = body.passwordForMembers;
      }
      if (Object.keys(changes).length === 0) return json(UpdateWorkspaceResponse.parse({ workspace: was }));
      const res = await tx.query<WorkspaceRow>(
        `UPDATE app.workspaces w
         SET name = coalesce($1::text, w.name),
             self_signup = coalesce($2::boolean, w.self_signup),
             settings = CASE WHEN $3::boolean IS NULL THEN w.settings
                             ELSE jsonb_set(w.settings, '{passwordForMembers}', to_jsonb($3::boolean)) END,
             updated_at = now()
         WHERE w.id = app.workspace_id()
         RETURNING w.id, w.name, w.self_signup, w.settings ->> 'passwordForMembers' AS pfm`,
        [changes.name ?? null, changes.selfSignup ?? null, changes.passwordForMembers ?? null],
      );
      const after = res.rows[0];
      if (!after) throw forbidden();
      await emit(tx, { type: 'workspace.settings.updated', personId: await currentPersonId(tx), changes });
      return json(UpdateWorkspaceResponse.parse({ workspace: toSettings(after) }));
    }),
  });

  // Role changes: admins manage member/guest/admin, only an owner grants or touches owner (row level security), and the
  // workspace_owner_guard trigger refuses to demote the last owner (a 409 with the trigger's message).
  ctx.http.route({
    ...updateWorkspaceMemberRoute,
    schema: { body: UpdateWorkspaceMemberRequest, response: UpdateWorkspaceMemberResponse },
    handler: route(async (req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const { personId } = MemberParams.parse(req.params);
      const { role } = UpdateWorkspaceMemberRequest.parse(req.body);
      const current = await tx.query<{ role: string }>(
        'SELECT role FROM app.workspace_members WHERE workspace_id = app.workspace_id() AND person_id = $1',
        [personId],
      );
      const previousRole = current.rows[0]?.role;
      if (!previousRole) throw notFound('No such member');
      if (previousRole === role) return json(UpdateWorkspaceMemberResponse.parse({ personId, role }));
      // `SET (role) = ...`: the plugin SQL guard rejects the text `SET role` (it cannot tell a column from SET ROLE).
      const res = await tx.query(
        'UPDATE app.workspace_members SET (role) = ROW($2) WHERE workspace_id = app.workspace_id() AND person_id = $1 RETURNING person_id',
        [personId, role],
      );
      // Row level security hides an owner row from a non-owner admin: nothing was updated.
      if (res.rows.length === 0) throw forbidden('Only an owner can change an owner');
      await emit(tx, { type: 'workspace.member.role_changed', personId, previousRole, role, changedBy: await currentPersonId(tx) });
      return json(UpdateWorkspaceMemberResponse.parse({ personId, role }));
    }),
  });
}
