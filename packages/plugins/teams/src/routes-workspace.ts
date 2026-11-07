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
import { HttpError, conflict, forbidden, json, notFound, route } from './http.ts';
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
  suspended_at: Date | null;
  role: string;
  tags: string[];
  created_at: Date;
  last_active_at: Date | null;
}

/**
 * 409 unless some other owner is active. Deactivating or demoting the last active owner would leave the workspace with nobody who can run it. Two owners
 * doing it to each other at the same moment would both pass the count, so these checks take turns (the count is a fresh statement after the lock).
 */
async function requireAnotherActiveOwner(tx: PluginTx, personId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 13))', ['workspace-owners']);
  const others = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.workspace_members wm JOIN app.people p ON p.id = wm.person_id
      WHERE wm.workspace_id = app.workspace_id() AND wm.role = 'owner' AND p.status = 'active' AND wm.person_id <> $1`,
    [personId],
  );
  if ((others.rows[0]?.n ?? 0) === 0) throw conflict('A workspace must keep at least one owner who is active; make someone else an owner first');
}

export function registerWorkspaceRoutes(ctx: PluginContext, { emit }: Deps): void {
  // Workspace settings do not exist for anyone below admin: 404, not 403.
  ctx.http.route({
    ...listWorkspaceMembersRoute,
    schema: { response: ListWorkspaceMembersResponse },
    handler: route(async (_req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const res = await tx.query<MemberRow>(
        `SELECT p.id AS person_id, p.display_name, p.primary_email, p.status, p.suspended_at, wm.role, wm.created_at,
                (SELECT max(s.last_seen_at) FROM app.sessions s WHERE s.person_id = p.id AND s.workspace_id = wm.workspace_id) AS last_active_at,
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
            suspendedAt: r.suspended_at ? r.suspended_at.toISOString() : null,
            role: r.role,
            tags: r.tags,
            joinedAt: r.created_at.toISOString(),
            lastActiveAt: r.last_active_at ? r.last_active_at.toISOString() : null,
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
      if (changes.passwordForMembers === false) {
        // Break-glass: members can only be sent to single sign-on when there is one that works (identity-password enforces the same rule).
        const sso = await tx.query(
          "SELECT 1 FROM app.auth_providers WHERE workspace_id = app.workspace_id() AND kind <> 'password' AND enabled LIMIT 1",
        );
        if (sso.rows.length === 0) {
          throw conflict('Turn on a single sign-on provider first, so members still have a way to sign in.');
        }
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

  // Role and status changes. Role: admins manage member/guest/admin, only an owner grants or touches owner (row level security), and the
  // workspace_owner_guard trigger refuses to demote the last owner (a 409 with the trigger's message).
  // Status (P20-13): `suspended` deactivates a member, `active` reactivates. A deactivated person cannot sign in and their sessions end on the
  // next request (the session service treats a non-active person as signed out); their Personal space is deleted by the retention sweep 30 days
  // after `people.suspended_at` (which the database sets from the status, never this route). Refused: your own account (400), the last active
  // owner (409), an owner by a non-owner admin (403, the people guard).
  ctx.http.route({
    ...updateWorkspaceMemberRoute,
    schema: { body: UpdateWorkspaceMemberRequest, response: UpdateWorkspaceMemberResponse },
    handler: route(async (req, tx) => {
      if (!(await isWorkspaceAdmin(tx))) throw notFound('Not found');
      const { personId } = MemberParams.parse(req.params);
      const { role, status } = UpdateWorkspaceMemberRequest.parse(req.body);
      const current = await tx.query<{ role: string; status: string }>(
        `SELECT wm.role, p.status FROM app.workspace_members wm JOIN app.people p ON p.id = wm.person_id
          WHERE wm.workspace_id = app.workspace_id() AND wm.person_id = $1`,
        [personId],
      );
      const previousRole = current.rows[0]?.role;
      const previousStatus = current.rows[0]?.status;
      if (!previousRole || !previousStatus) throw notFound('No such member');
      const me = await currentPersonId(tx);
      let nowRole = previousRole;
      let nowStatus = previousStatus;

      if (status !== undefined && status !== previousStatus) {
        if (personId === me) throw new HttpError(400, 'You cannot deactivate your own account');
        if (previousRole === 'owner' && (await tx.query<{ r: string | null }>('SELECT app.workspace_role() AS r')).rows[0]?.r !== 'owner') {
          throw forbidden('Only an owner can change an owner');
        }
        if (status === 'suspended' && previousRole === 'owner') await requireAnotherActiveOwner(tx, personId);
        const res = await tx.query(
          'UPDATE app.people SET (status) = ROW($2) WHERE id = $1 AND workspace_id = app.workspace_id() RETURNING id',
          [personId, status],
        );
        if (res.rows.length === 0) throw forbidden('You cannot change this account');
        nowStatus = status;
        await emit(tx, { type: 'workspace.member.status_changed', personId, previousStatus, status, changedBy: me });
      }

      if (role !== undefined && role !== previousRole) {
        // `SET (role) = ...`: the plugin SQL guard rejects the text `SET role` (it cannot tell a column from SET ROLE).
        const res = await tx.query(
          'UPDATE app.workspace_members SET (role) = ROW($2) WHERE workspace_id = app.workspace_id() AND person_id = $1 RETURNING person_id',
          [personId, role],
        );
        // Row level security hides an owner row from a non-owner admin: nothing was updated.
        if (res.rows.length === 0) throw forbidden('Only an owner can change an owner');
        // The same rule as for deactivating, after the update has passed the row guard (a refusal rolls it back): the database guard counts owners of
        // any status, so with one owner deactivated the only active owner could otherwise step down and leave nobody who can run, or reactivate anyone
        // in, the workspace.
        if (previousRole === 'owner' && nowStatus === 'active' && role !== 'owner') await requireAnotherActiveOwner(tx, personId);
        nowRole = role;
        await emit(tx, { type: 'workspace.member.role_changed', personId, previousRole, role, changedBy: me });
      }
      return json(UpdateWorkspaceMemberResponse.parse({ personId, role: nowRole, status: nowStatus }));
    }),
  });
}
