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
  type ProjectCredentialsProvider,
} from '@manythreads/sdk';
import {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  Project,
  RemovePushCredentialResponse,
  SetPushCredentialRequest,
  SetPushCredentialResponse,
  TestPushCredentialResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  createProjectRoute,
  deleteProjectRoute,
  isRepoOriginAllowed,
  listProjectsRoute,
  parseGithubRepo,
  parseRepoOriginAllow,
  removePushCredentialRoute,
  setPushCredentialRoute,
  testPushCredentialRoute,
  updateProjectRoute,
} from '@manythreads/shared';

import { PROBLEM_MESSAGE, checkGithubToken } from './github-check.ts';

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
  push_credential_set_at: Date | null;
  push_username: string | null;
  push_credential_expires_at: Date | null;
  push_credential_status: 'ok' | 'needs_replacing' | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, workspace_id, team_id, name, repo_url, default_branch, channel_id, created_by, push_credential_set_at, push_username, push_credential_expires_at, push_credential_status, created_at, updated_at';

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
    pushCredentialSetAt: r.push_credential_set_at ? r.push_credential_set_at.toISOString() : null,
    pushUsername: r.push_username,
    pushCredentialExpiresAt: r.push_credential_expires_at ? r.push_credential_expires_at.toISOString() : null,
    pushCredentialStatus: r.push_credential_status,
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

/** Tests point GitHub at a local double; nothing else ever changes where the check goes. */
const apiBaseFor = (real: string): string => (process.env['NODE_ENV'] === 'test' && process.env['MANYTHREADS_TEST_GITHUB_API']) || real;

export function registerProjectRoutes(ctx: PluginContext): void {
  const credentialsProvider = (): ProjectCredentialsProvider | undefined => ctx.providers.get<ProjectCredentialsProvider>('project.credentials');
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
      // A new project starts with no token: one left under this name by an earlier project (a removal that never reached the pod) is removed first.
      const leftover = credentialsProvider();
      if (leftover) {
        try {
          await leftover.remove({ id: team.id, slug }, body.name);
        } catch {
          throw conflict('The team pod could not be reached to clear an old token of that name; try again in a moment');
        }
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
      // A token is for one repository and its main branch: pointing the project at another address or branch drops it (set it again for the new one).
      const addressChanged = (body.repoUrl !== undefined && body.repoUrl !== current.repo_url) || (body.defaultBranch !== undefined && body.defaultBranch !== current.default_branch);
      const dropToken = addressChanged && current.push_credential_set_at !== null;
      if (dropToken) {
        try {
          await credentialsProvider()?.remove({ id: team.id, slug }, current.name);
        } catch {
          throw conflict('The project\'s token could not be removed from the team pod, so its address was not changed; try again in a moment');
        }
      }
      const updated = await tx.query<ProjectRow>(
        `UPDATE app.projects SET
           repo_url = coalesce($3, repo_url), default_branch = coalesce($4, default_branch),
           channel_id = CASE WHEN $5::boolean THEN $6::uuid ELSE channel_id END,
           push_credential_set_at = CASE WHEN $7::boolean THEN NULL ELSE push_credential_set_at END,
           push_username = CASE WHEN $7::boolean THEN NULL ELSE push_username END,
           push_credential_expires_at = CASE WHEN $7::boolean THEN NULL ELSE push_credential_expires_at END,
           push_credential_status = CASE WHEN $7::boolean THEN NULL ELSE push_credential_status END, updated_at = now()
         WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${COLUMNS}`,
        [projectId, team.id, body.repoUrl ?? null, body.defaultBranch ?? null, channelGiven, body.channelId ?? null, dropToken],
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
      const gone = await tx.query<{ name: string; push_credential_set_at: Date | null }>(
        'DELETE FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid RETURNING name, push_credential_set_at',
        [projectId, team.id],
      );
      const row = gone.rows[0];
      if (!row) throw notFound('No such project');
      // A removed project leaves no token behind: if the token cannot be removed the project is not removed either (the request is rolled back).
      if (row.push_credential_set_at) {
        try {
          await credentialsProvider()?.remove({ id: team.id, slug }, row.name);
        } catch {
          throw conflict('The project\'s token could not be removed from the team pod, so the project was not removed; try again in a moment');
        }
      }
      await ctx.audit.emit(tx, { type: 'project.project.deleted', workspaceId: team.workspace_id, teamId: team.id, projectId, name: row.name });
      return json(DeleteProjectResponse.parse({ deleted: true }));
    }),
  });

  // The push credential: a team lead or admin sets a GitHub token the team's pod uses to publish a tested branch as a pull request. The token goes
  // to the pod's Secret through the `project.credentials` provider and nowhere else; the row only learns that one is set, and when. No route returns it.
  ctx.http.route({
    method: setPushCredentialRoute.method,
    path: setPushCredentialRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: SetPushCredentialRequest, response: SetPushCredentialResponse },
    handler: route(async (req, tx) => {
      const { slug, projectId } = req.params as { slug: string; projectId: string };
      const body = SetPushCredentialRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid`, [projectId, team.id])).rows[0];
      if (!current) throw notFound('No such project');
      // Publishing needs a GitHub address this server may call (the same allowlist that limits what a pod clones).
      const allow = parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
      if (!parseGithubRepo(current.repo_url) || !isRepoOriginAllowed(current.repo_url, allow)) {
        throw invalid('Publishing needs a GitHub repository address (https://<host>/<owner>/<repo>) that this server is allowed to use');
      }
      const provider = credentialsProvider();
      if (!provider) throw conflict('This server keeps no team pods, so it has nowhere to keep a token');
      // GitHub is asked before anything is kept: a token of another account, one that cannot write here and one GitHub refuses are each told apart.
      const github = parseGithubRepo(current.repo_url)!;
      const checked = await checkGithubToken({ apiBase: apiBaseFor(github.apiBase), token: body.token, username: body.username, owner: github.owner, repo: github.repo });
      if (!checked.ok) throw checked.problem === 'unreachable' ? conflict(PROBLEM_MESSAGE.unreachable) : invalid(PROBLEM_MESSAGE[checked.problem]);
      // The row first, the pod's Secret last: the Secret is the final step before the request commits, so a failure anywhere earlier leaves no token behind.
      const updated = (
        await tx.query<ProjectRow>(
          `UPDATE app.projects SET push_credential_set_at = now(), push_username = $3, push_credential_expires_at = $4::timestamptz, push_credential_status = 'ok', updated_at = now()
           WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${COLUMNS}`,
          [projectId, team.id, checked.login, checked.expiresAt],
        )
      ).rows[0];
      if (!updated) throw forbidden('You do not have permission to do that');
      await ctx.audit.emit(tx, {
        type: 'project.project.updated',
        workspaceId: team.workspace_id,
        teamId: team.id,
        projectId,
        name: updated.name,
        repoUrl: updated.repo_url,
        defaultBranch: updated.default_branch,
        channelId: updated.channel_id,
      });
      try {
        await provider.put({ id: team.id, slug }, current.name, body.token, current.repo_url, current.default_branch);
      } catch {
        // the reason is not echoed: it could name the Secret, and must never hold the token; throwing rolls the row back
        throw conflict('The token could not be stored in the team pod; try again in a moment');
      }
      return json(SetPushCredentialResponse.parse({ project: toProject(updated) }));
    }),
  });

  // Ask GitHub again about the stored token (who it belongs to, whether it still writes here, when it expires). A refusal marks the project
  // `needs_replacing`; a GitHub that cannot be reached changes nothing.
  ctx.http.route({
    method: testPushCredentialRoute.method,
    path: testPushCredentialRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: TestPushCredentialResponse },
    handler: route(async (req, tx) => {
      const { slug, projectId } = req.params as { slug: string; projectId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid`, [projectId, team.id])).rows[0];
      if (!current) throw notFound('No such project');
      const provider = credentialsProvider();
      const github = parseGithubRepo(current.repo_url);
      if (!provider || !github || !current.push_credential_set_at || !current.push_username) throw conflict('This project has no token to test');
      const cred = await provider.read({ id: team.id, slug }, current.name).catch(() => null);
      if (!cred) throw conflict('The token could not be read from the team pod; save it again');
      const checked = await checkGithubToken({ apiBase: apiBaseFor(github.apiBase), token: cred.token, username: current.push_username, owner: github.owner, repo: github.repo });
      if (!checked.ok && checked.problem === 'unreachable') throw conflict(PROBLEM_MESSAGE.unreachable);
      const updated = (
        await tx.query<ProjectRow>(
          `UPDATE app.projects SET push_credential_status = $3, push_credential_expires_at = COALESCE($4::timestamptz, push_credential_expires_at), updated_at = now()
           WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${COLUMNS}`,
          [projectId, team.id, checked.ok ? 'ok' : 'needs_replacing', checked.ok ? checked.expiresAt : null],
        )
      ).rows[0];
      if (!updated) throw forbidden('You do not have permission to do that');
      // Answered 200 either way: a refusal has to be kept (the status above), which a thrown error would roll back.
      return json(TestPushCredentialResponse.parse({ project: toProject(updated), ok: checked.ok, login: checked.ok ? checked.login : null, expiresAt: checked.ok ? checked.expiresAt : updated.push_credential_expires_at?.toISOString() ?? null, message: checked.ok ? null : PROBLEM_MESSAGE[checked.problem] }));
    }),
  });

  ctx.http.route({
    method: removePushCredentialRoute.method,
    path: removePushCredentialRoute.path,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: RemovePushCredentialResponse },
    handler: route(async (req, tx) => {
      const { slug, projectId } = req.params as { slug: string; projectId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const current = (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE id = $1::uuid AND team_id = $2::uuid`, [projectId, team.id])).rows[0];
      if (!current) throw notFound('No such project');
      const provider = credentialsProvider();
      if (provider) {
        try {
          await provider.remove({ id: team.id, slug }, current.name);
        } catch {
          throw conflict('The token could not be removed from the team pod; try again in a moment');
        }
      } else if (current.push_credential_set_at) {
        throw conflict('This server keeps no team pods, so it cannot remove the token');
      }
      const updated = (
        await tx.query<ProjectRow>(
          `UPDATE app.projects SET push_credential_set_at = NULL, push_username = NULL, push_credential_expires_at = NULL, push_credential_status = NULL, updated_at = now() WHERE id = $1::uuid AND team_id = $2::uuid RETURNING ${COLUMNS}`,
          [projectId, team.id],
        )
      ).rows[0];
      if (!updated) throw forbidden('You do not have permission to do that');
      await ctx.audit.emit(tx, {
        type: 'project.project.updated',
        workspaceId: team.workspace_id,
        teamId: team.id,
        projectId,
        name: updated.name,
        repoUrl: updated.repo_url,
        defaultBranch: updated.default_branch,
        channelId: updated.channel_id,
      });
      return json(RemovePushCredentialResponse.parse({ project: toProject(updated) }));
    }),
  });
}
