import {
  conflict,
  forbidden,
  invalid,
  json,
  notFound,
  requireManage,
  requireTeam,
  route,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  Project,
  UpdateProjectRequest,
  UpdateProjectResponse,
  createProjectRoute,
  deleteProjectRoute,
  listProjectsRoute,
  updateProjectRoute,
} from '@manythreads/shared';

// Projects: a team's git repositories, each tied to at most one channel of the team. The team reads; a lead or workspace admin writes.

interface ProjectRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  channel_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, workspace_id, team_id, name, repo_url, default_branch, channel_id, created_by, created_at, updated_at';

/** The one mapper of `app.projects`: a row to the shared type. */
export function toProject(r: ProjectRow): Project {
  return Project.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    channelId: r.channel_id,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}

/** The channel must be an ordinary channel of this team that the caller can see; anything else is a 400 that does not say which. */
async function requireTeamChannel(tx: PluginTx, teamId: string, channelId: string): Promise<void> {
  const res = await tx.query(`SELECT 1 FROM app.channels WHERE id = $1::uuid AND team_id = $2::uuid AND kind = 'channel' AND archived_at IS NULL`, [channelId, teamId]);
  if (res.rows.length === 0) throw invalid('That channel is not a channel of this team');
}

/** A channel serves one project: a second project on it is a conflict that names the first. */
async function requireFreeChannel(tx: PluginTx, channelId: string, exceptProjectId: string | null): Promise<void> {
  const res = await tx.query<{ name: string }>(
    'SELECT name FROM app.projects WHERE channel_id = $1::uuid AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [channelId, exceptProjectId],
  );
  const other = res.rows[0];
  if (other) throw conflict(`That channel already belongs to the project ${other.name}`);
}

export function registerProjectRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listProjectsRoute.method,
    path: listProjectsRoute.path,
    schema: { response: ListProjectsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE team_id = $1::uuid ORDER BY name`, [team.id]);
      return json(ListProjectsResponse.parse({ items: rows.rows.map(toProject) }));
    }),
  });

  ctx.http.route({
    method: createProjectRoute.method,
    path: createProjectRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: CreateProjectRequest, response: CreateProjectResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const body = CreateProjectRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      if (team.archived_at) throw conflict('This team is archived; unarchive it first');
      const channelId = body.channelId ?? null;
      if (channelId !== null) {
        await requireTeamChannel(tx, team.id, channelId);
        await requireFreeChannel(tx, channelId, null);
      }
      const inserted = await tx.query<ProjectRow>(
        `INSERT INTO app.projects (workspace_id, team_id, name, repo_url, default_branch, channel_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid) RETURNING ${COLUMNS}`,
        [team.workspace_id, team.id, body.name, body.repoUrl, body.defaultBranch ?? 'main', channelId, tx.actor.id],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('the project insert answered no row');
      await ctx.audit.emit(tx, {
        type: 'project.project.created',
        workspaceId: team.workspace_id,
        teamId: team.id,
        projectId: row.id,
        name: row.name,
        repoUrl: row.repo_url,
        defaultBranch: row.default_branch,
        channelId: row.channel_id,
      });
      return json(CreateProjectResponse.parse({ project: toProject(row) }), 201);
    }),
  });

  ctx.http.route({
    method: updateProjectRoute.method,
    path: updateProjectRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: UpdateProjectRequest, response: UpdateProjectResponse },
    handler: route(async (req, tx) => {
      const { slug, projectId } = req.params as { slug: string; projectId: string };
      const body = UpdateProjectRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      if (body.repoUrl === undefined && body.defaultBranch === undefined && body.channelId === undefined) throw invalid('Nothing to change');
      const current = (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid`, [projectId, team.id])).rows[0];
      if (!current) throw notFound('No such project');
      // A channel left as it was is not checked again: a project may keep a channel that has since been archived.
      if (body.channelId !== undefined && body.channelId !== null && body.channelId !== current.channel_id) {
        await requireTeamChannel(tx, team.id, body.channelId);
        await requireFreeChannel(tx, body.channelId, projectId);
      }
      const channelGiven = body.channelId !== undefined;
      const updated = await tx.query<ProjectRow>(
        `UPDATE app.projects SET
           repo_url = coalesce($3, repo_url), default_branch = coalesce($4, default_branch),
           channel_id = CASE WHEN $5::boolean THEN $6::uuid ELSE channel_id END, updated_at = now()
         WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${COLUMNS}`,
        [projectId, team.id, body.repoUrl ?? null, body.defaultBranch ?? null, channelGiven, body.channelId ?? null],
      );
      const row = updated.rows[0];
      if (!row) throw forbidden('You do not have permission to do that');
      await ctx.audit.emit(tx, {
        type: 'project.project.updated',
        workspaceId: team.workspace_id,
        teamId: team.id,
        projectId,
        name: row.name,
        repoUrl: row.repo_url,
        defaultBranch: row.default_branch,
        channelId: row.channel_id,
      });
      return json(UpdateProjectResponse.parse({ project: toProject(row) }));
    }),
  });

  ctx.http.route({
    method: deleteProjectRoute.method,
    path: deleteProjectRoute.path,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: DeleteProjectResponse },
    handler: route(async (req, tx) => {
      const { slug, projectId } = req.params as { slug: string; projectId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const gone = await tx.query<{ name: string }>('DELETE FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid RETURNING name', [projectId, team.id]);
      const row = gone.rows[0];
      if (!row) throw notFound('No such project');
      await ctx.audit.emit(tx, { type: 'project.project.deleted', workspaceId: team.workspace_id, teamId: team.id, projectId, name: row.name });
      return json(DeleteProjectResponse.parse({ deleted: true }));
    }),
  });
}
