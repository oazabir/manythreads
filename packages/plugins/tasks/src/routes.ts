import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ClaimTaskResponse,
  CompleteTaskRequest,
  CompleteTaskResponse,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateEnvironmentRequest,
  CreateEnvironmentResponse,
  CreateGoalRequest,
  CreateGoalResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DeployRequest,
  DeployResponse,
  GetBoardResponse,
  GetTaskResponse,
  HandoffTaskRequest,
  HandoffTaskResponse,
  ListBoardsResponse,
  ListEnvironmentsResponse,
  ListGoalsQuery,
  ListGoalsResponse,
  ListRunnersResponse,
  ListTaskEventsResponse,
  ListTasksQuery,
  ListTasksResponse,
  MoveTaskRequest,
  MoveTaskResponse,
  RegisterRunnerRequest,
  RegisterRunnerResponse,
  ReleaseTaskResponse,
  ReworkTaskRequest,
  ReworkTaskResponse,
  TasksTaskClaimedEvent,
  UpdateEnvironmentRequest,
  UpdateEnvironmentResponse,
  UpdateGoalRequest,
  UpdateGoalResponse,
  UpdateRunnerRequest,
  UpdateRunnerResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
  claimTaskRoute,
  completeTaskRoute,
  createBoardRoute,
  createEnvironmentRoute,
  createGoalRoute,
  createTaskRoute,
  deployEnvironmentRoute,
  getBoardRoute,
  getTaskRoute,
  handoffTaskRoute,
  listBoardsRoute,
  listEnvironmentsRoute,
  listGoalsRoute,
  listRunnersRoute,
  listTaskEventsRoute,
  listTasksRoute,
  moveTaskRoute,
  registerRunnerRoute,
  releaseTaskRoute,
  reworkTaskRoute,
  updateEnvironmentRoute,
  updateGoalRoute,
  updateRunnerRoute,
  updateTaskRoute,
  Handoff,
  Task,
} from '@manythreads/shared';
import { conflict, forbidden, json, notFound, requireManage, requireTeam, route } from '@manythreads/sdk';
import { insertCard } from './create.ts';
import { postHandoffCard } from './card.ts';
import { emitCompleted, emitHandedOff, emitUpdated } from './emit.ts';
import { handoverAllowlist, mayHandoffToActor } from './handoff.ts';
import { TASK_SELECT, actorOf, toBoard, toEnvironment, toGoal, toHandoff, toRunner, toTask, toTaskEvent, type BoardRow, type EnvironmentRow, type GoalRow, type HandoffRow, type RunnerRow, type TaskEventRow, type TaskRow } from './rows.ts';

/** The card of this team, or 404 (a card of another team and a missing one answer the same). */
async function taskOf(tx: PluginTx, teamId: string, taskId: string): Promise<Task> {
  const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid AND t.team_id = $2::uuid`, [taskId, teamId])).rows[0];
  if (!row) throw notFound('No such card');
  return toTask(row);
}

/** The actor's name, for a refusal a person can read ("Already owned by Reviewer"). */
async function nameOf(tx: PluginTx, actorId: string): Promise<string> {
  return (await actorOf(tx, actorId))?.name ?? 'someone';
}

export function registerRoutes(ctx: PluginContext): void {
  // List --------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listTasksRoute,
    schema: { query: ListTasksQuery, response: ListTasksResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const q = ListTasksQuery.parse(req.query);
      const where: string[] = ['t.team_id = $1::uuid'];
      const values: unknown[] = [team.id];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        where.push(sql.replace('?', `$${values.length}`));
      };
      if (q.state) add('t.state = ?', q.state);
      if (q.kind) add('t.kind = ?', q.kind);
      if (q.priority) add('t.priority = ?', q.priority);
      if (q.goalId) add('t.goal_id = ?::uuid', q.goalId);
      if (q.ownerId) add('t.owner_id = ?::uuid', q.ownerId);
      const filter = where.join(' AND ');
      values.push(q.limit);
      const rows = (
        await tx.query<TaskRow>(`${TASK_SELECT} WHERE ${filter} ORDER BY t.updated_at DESC, t.id DESC LIMIT $${values.length}`, values)
      ).rows;
      const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.tasks t WHERE ${filter}`, values.slice(0, -1))).rows[0]?.n ?? 0;
      return json(ListTasksResponse.parse({ items: rows.map(toTask), total }));
    }),
  });

  // Create ------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...createTaskRoute,
    schema: { body: CreateTaskRequest, response: CreateTaskResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const body = CreateTaskRequest.parse(req.body);
      if (body.goalId) {
        const goal = await tx.query('SELECT 1 FROM app.goals WHERE id = $1::uuid AND team_id = $2::uuid', [body.goalId, team.id]);
        if (goal.rows.length === 0) throw notFound('No such goal in this team');
      }
      if (body.environmentId) {
        const env = await tx.query('SELECT 1 FROM app.environments WHERE id = $1::uuid AND team_id = $2::uuid', [body.environmentId, team.id]);
        if (env.rows.length === 0) throw notFound('No such environment in this team');
      }
      // One door writes the card and its `created` history (as the system: `task_events` takes no request writes), so the card and its
      // timeline cannot disagree, and the caller cannot create a card in someone else's name. The `tasks.create` tool comes through it too.
      const task = await insertCard(ctx, tx, {
        workspaceId: team.workspace_id,
        teamId: team.id,
        goalId: body.goalId ?? null,
        title: body.title,
        description: body.description,
        kind: body.kind,
        priority: body.priority,
        branch: body.branch,
        environmentId: body.environmentId ?? null,
        actorId: tx.actor.id,
      });
      return json(CreateTaskResponse.parse({ task }), 201);
    }),
  });

  // Read --------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...getTaskRoute,
    schema: { response: GetTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      return json(GetTaskResponse.parse({ task: await taskOf(tx, team.id, taskId) }));
    }),
  });

  // Edit (a direct edit, and the board's drag through the same rules) ------------------------------------------
  ctx.http.route({
    ...updateTaskRoute,
    schema: { body: UpdateTaskRequest, response: UpdateTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const body = UpdateTaskRequest.parse(req.body ?? {});
      const before = await taskOf(tx, team.id, taskId);
      if (body.testedSha !== undefined) {
        const res = await tx.query(
          `UPDATE app.tasks SET tested_sha = $3, updated_at = now()
            WHERE id = $1::uuid AND team_id = $2::uuid
              AND (owner_id = $4::uuid OR (SELECT app.lookup_can('team', $2::uuid, 'manage')))
            RETURNING id`,
          [taskId, team.id, body.testedSha, tx.actor.id],
        );
        if (res.rows.length === 0) throw forbidden('Only the owner or a lead can set the tested commit');
      }
      if (body.state !== undefined) {
        const moved = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT o_outcome, o_reason FROM app.tasks_move($1::uuid, $2)', [taskId, body.state])).rows[0];
        if (!moved || moved.o_outcome === 'not_found') throw notFound('No such card');
        if (moved.o_outcome !== 'moved') throw conflict(moved.o_reason || moved.o_outcome);
      }
      if (body.priority !== undefined || body.blockerReason !== undefined) {
        await tx.query(
          `UPDATE app.tasks SET priority = coalesce($3, priority), blocker_reason = coalesce($4, blocker_reason), updated_at = now()
            WHERE id = $1::uuid AND team_id = $2::uuid`,
          [taskId, team.id, body.priority ?? null, body.blockerReason ?? null],
        );
      }
      const after = await taskOf(tx, team.id, taskId);
      await emitUpdated(ctx, tx, before, after);
      return json(UpdateTaskResponse.parse({ task: after }));
    }),
  });

  // Claim --------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...claimTaskRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ClaimTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      await taskOf(tx, team.id, taskId); // 404 for another team before any write
      const res = (
        await tx.query<{ o_outcome: string; o_owner_id: string | null; o_expires_at: Date | null }>('SELECT * FROM app.tasks_claim($1::uuid)', [taskId])
      ).rows[0];
      if (!res || res.o_outcome === 'not_found') throw notFound('No such card');
      if (res.o_outcome === 'already_owned' && res.o_owner_id === tx.actor.id) {
        // The holder asking again: succeed, change nothing, emit nothing.
        const live = await tx.query<{ expires_at: Date }>('SELECT expires_at FROM app.task_claims WHERE task_id = $1::uuid AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1', [taskId]);
        return json(ClaimTaskResponse.parse({ task: await taskOf(tx, team.id, taskId), expiresAt: (live.rows[0]?.expires_at ?? new Date()).toISOString() }));
      }
      if (res.o_outcome === 'already_owned') throw conflict(`already_owned: already owned by ${await nameOf(tx, res.o_owner_id ?? '')}`);
      if (res.o_outcome === 'not_claimable') throw conflict('not_claimable: this card cannot be claimed in its current state');
      const task = await taskOf(tx, team.id, taskId);
      await ctx.audit.emit(
        tx,
        TasksTaskClaimedEvent.parse({
          type: 'tasks.task.claimed',
          schemaVersion: 1,
          workspaceId: task.workspaceId,
          teamId: task.teamId,
          taskId: task.id,
          actorId: tx.actor.id,
          actorKind: tx.actor.kind,
          expiresAt: (res.o_expires_at ?? new Date()).toISOString(),
        }),
      );
      return json(ClaimTaskResponse.parse({ task, expiresAt: (res.o_expires_at ?? new Date()).toISOString() }));
    }),
  });

  // Release ------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...releaseTaskRoute,
    schema: { response: ReleaseTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const before = await taskOf(tx, team.id, taskId);
      const outcome = (await tx.query<{ outcome: string }>('SELECT app.tasks_release($1::uuid) AS outcome', [taskId])).rows[0]?.outcome;
      if (outcome === 'not_found') throw notFound('No such card');
      if (outcome === 'not_owner') throw forbidden('Only the owner or a lead can release this card');
      if (outcome !== 'released') throw conflict(outcome ?? 'the release was not recorded');
      const after = await taskOf(tx, team.id, taskId);
      await emitUpdated(ctx, tx, before, after);
      return json(ReleaseTaskResponse.parse({ task: after }));
    }),
  });

  // Complete -----------------------------------------------------------------------------------------------
  ctx.http.route({
    ...completeTaskRoute,
    schema: { body: CompleteTaskRequest, response: CompleteTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const body = CompleteTaskRequest.parse(req.body ?? {});
      const before = await taskOf(tx, team.id, taskId);
      const res = (
        await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_complete($1::uuid, $2, $3)', [
          taskId,
          body.testedSha ?? null,
          body.branchHeadSha ?? null,
        ])
      ).rows[0];
      if (!res || res.o_outcome === 'not_found') throw notFound('No such card');
      if (res.o_outcome !== 'done') {
        // A refusal is an answer, not a thrown error: the door wrote the reason on the card in this transaction, and throwing would roll it
        // back, so the caller returns the 409 itself and the reason survives (PLAN P6-04: the board can show it without re-running the check).
        return { status: 409, body: { error: { code: 'conflict', message: res.o_reason || res.o_outcome } } };
      }
      const after = await taskOf(tx, team.id, taskId);
      await emitCompleted(ctx, tx, after);
      await emitUpdated(ctx, tx, before, after);
      await tx.query('SELECT app.tasks_drop_private_notes($1::uuid)', [taskId]);
      return json(CompleteTaskResponse.parse({ task: after }));
    }),
  });

  // Rework -------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...reworkTaskRoute,
    schema: { body: ReworkTaskRequest, response: ReworkTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const body = ReworkTaskRequest.parse(req.body ?? {});
      const before = await taskOf(tx, team.id, taskId);
      const res = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_rework($1::uuid, $2)', [taskId, body.reason])).rows[0];
      if (!res || res.o_outcome === 'not_found') throw notFound('No such card');
      if (res.o_outcome !== 'reworked') throw conflict(res.o_reason || res.o_outcome);
      const after = await taskOf(tx, team.id, taskId);
      await emitUpdated(ctx, tx, before, after);
      return json(ReworkTaskResponse.parse({ task: after }));
    }),
  });

  // Handoff ------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...handoffTaskRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { body: HandoffTaskRequest, response: HandoffTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      const body = HandoffTaskRequest.parse(req.body);
      const before = await taskOf(tx, team.id, taskId);

      // The target: a bot by slug (what a BOT.md's mayTag names) or an actor id.
      let toActorId: string | null = null;
      let targetName = 'someone';
      if (body.toBotSlug !== undefined) {
        const target = (
          await tx.query<{ id: string; name: string }>('SELECT o_actor_id AS id, o_name AS name FROM app.tasks_bot_of($1::uuid, $2)', [team.id, body.toBotSlug])
        ).rows[0];
        if (!target) throw notFound(`No active bot "${body.toBotSlug}" in this team`);
        toActorId = target.id;
        targetName = target.name;
      } else {
        const target = await actorOf(tx, body.toActorId as string);
        if (!target) throw notFound('No such actor');
        toActorId = body.toActorId as string;
        targetName = target.name;
      }

      // A bot hands off only to the people and bots its BOT.md `handover.mayTag` names (P6-03): refused before any effect.
      const caller = await actorOf(tx, tx.actor.id);
      const mayTag = await handoverAllowlist(tx, tx.actor.id);
      if (caller?.kind === 'bot' && !(await mayHandoffToActor(tx, mayTag ?? [], toActorId))) {
        throw forbidden(`${caller.name} may not hand a card to ${targetName}: the target is not in its handover.mayTag`);
      }

      if (body.strict) {
        // A scalar function's column is named after the function, not the schema-qualified path: alias it, or the row is read as undefined.
        const handoffId = (await tx.query<{ handoff_id: string }>('SELECT app.tasks_handoff_pending($1::uuid, $2::uuid, $3, $4) AS handoff_id', [taskId, toActorId, body.mode, body.note])).rows[0]
          ?.handoff_id;
        if (!handoffId) throw conflict('Could not file the handoff');
        const approvalId = (
          await tx.query<{ approval_id: string }>(
            `SELECT app.approvals_request_task($1::uuid, $2::uuid, $3::uuid, 'dispatch', 'tasks.handoff', $4, $5::jsonb, $6) AS approval_id`,
            [
              before.workspaceId,
              before.teamId,
              tx.actor.id,
              `Hand off “${before.title}” to ${targetName}`,
              JSON.stringify({ kind: 'handoff', op: 'task_handoff', handoffId, taskId, toActorId, mode: body.mode }),
              `task:${taskId}:handoff:${handoffId}`,
            ],
          )
        ).rows[0]?.approval_id;
        if (!approvalId) throw conflict('Could not file the approval');
        await tx.query('SELECT app.tasks_attach_approval($1::uuid, $2::uuid)', [handoffId, approvalId]);
        await postHandoffCard(ctx, tx, { task: before, handoffId, toActorId, note: body.note, pending: true, origin: { channelId: body.channelId, threadRootId: body.threadRootId } });
        const handoffRow = (await tx.query<HandoffRow>('SELECT * FROM app.handoffs WHERE id = $1::uuid', [handoffId])).rows[0];
        return json(
          HandoffTaskResponse.parse({
            task: await taskOf(tx, team.id, taskId),
            handoff: toHandoff(handoffRow as HandoffRow),
            pendingApproval: true,
            approvalId,
          }),
          202,
        );
      }

      const res = (
        await tx.query<{ o_outcome: string; o_handoff_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [
          taskId,
          toActorId,
          body.mode,
          body.note,
        ])
      ).rows[0];
      if (!res || res.o_outcome === 'not_found') throw notFound('No such card');
      if (res.o_outcome !== 'moved') throw conflict(res.o_reason || res.o_outcome);
      const handoffRow = (await tx.query<HandoffRow>('SELECT * FROM app.handoffs WHERE id = $1::uuid', [res.o_handoff_id])).rows[0];
      if (!handoffRow) throw conflict('The handoff was not recorded');
      const handoff: Handoff = toHandoff(handoffRow);
      const after = await taskOf(tx, team.id, taskId);
      await emitHandedOff(ctx, tx, after, handoff);
      await postHandoffCard(ctx, tx, { task: after, handoffId: handoff.id, toActorId, note: body.note, pending: false, origin: { channelId: body.channelId, threadRootId: body.threadRootId } });
      await emitUpdated(ctx, tx, before, after);
      return json(HandoffTaskResponse.parse({ task: await taskOf(tx, team.id, taskId), handoff, pendingApproval: false, approvalId: null }));
    }),
  });

  // Events -------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listTaskEventsRoute,
    schema: { response: ListTaskEventsResponse },
    handler: route(async (req, tx) => {
      const { slug, taskId } = req.params as { slug: string; taskId: string };
      const team = await requireTeam(tx, slug);
      await taskOf(tx, team.id, taskId);
      const rows = (
        await tx.query<TaskEventRow>('SELECT id, task_id, team_id, actor_id, type, data, created_at FROM app.task_events WHERE task_id = $1::uuid ORDER BY id ASC LIMIT 200', [taskId])
      ).rows;
      return json(ListTaskEventsResponse.parse({ items: rows.map(toTaskEvent) }));
    }),
  });

  // Goals --------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listGoalsRoute,
    schema: { query: ListGoalsQuery, response: ListGoalsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const q = ListGoalsQuery.parse(req.query);
      const rows = (
        await tx.query<GoalRow>(
          `SELECT id, workspace_id, team_id, title, description, status, created_by, created_at, updated_at
             FROM app.goals WHERE team_id = $1::uuid AND ($2::text IS NULL OR status = $2::text)
             ORDER BY created_at DESC LIMIT $3`,
          [team.id, q.status ?? null, q.limit],
        )
      ).rows;
      return json(ListGoalsResponse.parse({ items: rows.map(toGoal) }));
    }),
  });

  ctx.http.route({
    ...createGoalRoute,
    schema: { body: CreateGoalRequest, response: CreateGoalResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const body = CreateGoalRequest.parse(req.body);
      const row = (
        await tx.query<GoalRow>(
          `INSERT INTO app.goals (workspace_id, team_id, title, description, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
           RETURNING id, workspace_id, team_id, title, description, status, created_by, created_at, updated_at`,
          [team.workspace_id, team.id, body.title, body.description, tx.actor.id],
        )
      ).rows[0];
      if (!row) throw conflict('Could not create the goal');
      return json(CreateGoalResponse.parse({ goal: toGoal(row) }), 201);
    }),
  });

  ctx.http.route({
    ...updateGoalRoute,
    schema: { body: UpdateGoalRequest, response: UpdateGoalResponse },
    handler: route(async (req, tx) => {
      const { slug, goalId } = req.params as { slug: string; goalId: string };
      const team = await requireTeam(tx, slug);
      const body = UpdateGoalRequest.parse(req.body ?? {});
      const row = (
        await tx.query<GoalRow>(
          `UPDATE app.goals SET status = coalesce($3, status), updated_at = now()
            WHERE id = $1::uuid AND team_id = $2::uuid
            RETURNING id, workspace_id, team_id, title, description, status, created_by, created_at, updated_at`,
          [goalId, team.id, body.status ?? null],
        )
      ).rows[0];
      if (!row) throw notFound('No such goal');
      return json(UpdateGoalResponse.parse({ goal: toGoal(row) }));
    }),
  });

  // Environments -------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listEnvironmentsRoute,
    schema: { response: ListEnvironmentsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = (
        await tx.query<EnvironmentRow>('SELECT * FROM app.environments WHERE team_id = $1::uuid ORDER BY name', [team.id])
      ).rows;
      return json(ListEnvironmentsResponse.parse({ items: rows.map(toEnvironment) }));
    }),
  });

  ctx.http.route({
    ...createEnvironmentRoute,
    schema: { body: CreateEnvironmentRequest, response: CreateEnvironmentResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = CreateEnvironmentRequest.parse(req.body);
      const row = (
        await tx.query<EnvironmentRow>(
          `INSERT INTO app.environments (workspace_id, team_id, name, protected, needs_approval, windows, deploy_cap, auto_rollback, credential_ref, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::uuid)
           RETURNING *`,
          [team.workspace_id, team.id, body.name, body.protected, body.needsApproval, JSON.stringify(body.windows), body.deployCap, body.autoRollback, body.credentialRef, tx.actor.id],
        )
      ).rows[0];
      if (!row) throw conflict('Could not create the environment');
      return json(CreateEnvironmentResponse.parse({ environment: toEnvironment(row) }), 201);
    }),
  });

  ctx.http.route({
    ...updateEnvironmentRoute,
    schema: { body: UpdateEnvironmentRequest, response: UpdateEnvironmentResponse },
    handler: route(async (req, tx) => {
      const { slug, environmentId } = req.params as { slug: string; environmentId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = UpdateEnvironmentRequest.parse(req.body ?? {});
      const sets: string[] = [];
      const values: unknown[] = [environmentId, team.id];
      const set = (column: string, value: unknown, cast = '') => {
        values.push(value);
        sets.push(`${column} = $${values.length}${cast}`);
      };
      if (body.protected !== undefined) set('protected', body.protected);
      if (body.needsApproval !== undefined) set('needs_approval', body.needsApproval);
      if (body.windows !== undefined) set('windows', JSON.stringify(body.windows), '::jsonb');
      if (body.deployCap !== undefined) set('deploy_cap', body.deployCap);
      if (body.autoRollback !== undefined) set('auto_rollback', body.autoRollback);
      if (body.credentialRef !== undefined) set('credential_ref', body.credentialRef);
      if (sets.length === 0) {
        const current = (await tx.query<EnvironmentRow>('SELECT * FROM app.environments WHERE id = $1::uuid AND team_id = $2::uuid', [environmentId, team.id])).rows[0];
        if (!current) throw notFound('No such environment');
        return json(UpdateEnvironmentResponse.parse({ environment: toEnvironment(current) }));
      }
      sets.push('updated_at = now()');
      const row = (
        await tx.query<EnvironmentRow>(`UPDATE app.environments SET ${sets.join(', ')} WHERE id = $1::uuid AND team_id = $2::uuid RETURNING *`, values)
      ).rows[0];
      if (!row) throw notFound('No such environment');
      return json(UpdateEnvironmentResponse.parse({ environment: toEnvironment(row) }));
    }),
  });

  ctx.http.route({
    ...deployEnvironmentRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: DeployRequest, response: DeployResponse },
    handler: route(async (req, tx) => {
      const { slug, environmentId } = req.params as { slug: string; environmentId: string };
      await requireTeam(tx, slug); // access: the deploy door itself is team-scoped by RLS
      const body = DeployRequest.parse(req.body ?? {});
      const res = (
        await tx.query<{ o_outcome: string; o_reason: string; o_approval_id: string | null; o_deploy_id: string | number | null }>(
          'SELECT * FROM app.tasks_deploy_request($1::uuid, $2::uuid, $3)',
          [environmentId, body.taskId ?? null, body.summary],
        )
      ).rows[0];
      if (!res) throw conflict('Could not check the environment');
      if (res.o_outcome === 'not_found') throw notFound(res.o_reason || 'No such environment');
      return json(
        DeployResponse.parse({
          outcome: res.o_outcome,
          approvalId: res.o_approval_id,
          reason: res.o_reason,
        }),
      );
    }),
  });

  // Boards -------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listBoardsRoute,
    schema: { response: ListBoardsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = (await tx.query<BoardRow>('SELECT * FROM app.boards WHERE team_id = $1::uuid ORDER BY created_at', [team.id])).rows;
      return json(ListBoardsResponse.parse({ items: rows.map(toBoard) }));
    }),
  });

  ctx.http.route({
    ...createBoardRoute,
    schema: { body: CreateBoardRequest, response: CreateBoardResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = CreateBoardRequest.parse(req.body);
      const columns = body.columns ?? [
        { state: 'open', title: 'Open' },
        { state: 'in_progress', title: 'In progress' },
        { state: 'verify', title: 'Verify' },
        { state: 'waiting_on_person', title: 'Waiting on a person' },
        { state: 'done', title: 'Done' },
      ];
      const row = (
        await tx.query<BoardRow>(
          `INSERT INTO app.boards (workspace_id, team_id, name, columns, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid) RETURNING *`,
          [team.workspace_id, team.id, body.name, JSON.stringify(columns), tx.actor.id],
        )
      ).rows[0];
      if (!row) throw conflict('Could not create the board');
      return json(CreateBoardResponse.parse({ board: toBoard(row) }), 201);
    }),
  });

  ctx.http.route({
    ...getBoardRoute,
    schema: { response: GetBoardResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId } = req.params as { slug: string; boardId: string };
      const team = await requireTeam(tx, slug);
      const row = (await tx.query<BoardRow>('SELECT * FROM app.boards WHERE id = $1::uuid AND team_id = $2::uuid', [boardId, team.id])).rows[0];
      if (!row) throw notFound('No such board');
      return json(GetBoardResponse.parse({ board: toBoard(row) }));
    }),
  });

  ctx.http.route({
    ...moveTaskRoute,
    schema: { body: MoveTaskRequest, response: MoveTaskResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId } = req.params as { slug: string; boardId: string };
      const team = await requireTeam(tx, slug);
      const body = MoveTaskRequest.parse(req.body);
      const board = (await tx.query<BoardRow>('SELECT * FROM app.boards WHERE id = $1::uuid AND team_id = $2::uuid', [boardId, team.id])).rows[0];
      if (!board) throw notFound('No such board');
      const states = (board.columns ?? []).map((c) => c.state);
      if (!states.includes(body.to)) throw conflict(`this board has no ${body.to} column`);
      const before = await taskOf(tx, team.id, body.taskId);
      const res = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT o_outcome, o_reason FROM app.tasks_move($1::uuid, $2)', [body.taskId, body.to])).rows[0];
      if (!res || res.o_outcome === 'not_found') throw notFound('No such card');
      if (res.o_outcome !== 'moved') throw conflict(res.o_reason || res.o_outcome);
      const after = await taskOf(tx, team.id, body.taskId);
      await emitUpdated(ctx, tx, before, after);
      return json(MoveTaskResponse.parse({ task: after }));
    }),
  });

  // Runners ------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...listRunnersRoute,
    schema: { response: ListRunnersResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = (await tx.query<RunnerRow>('SELECT * FROM app.runners WHERE team_id = $1::uuid ORDER BY name', [team.id])).rows;
      return json(ListRunnersResponse.parse({ items: rows.map(toRunner) }));
    }),
  });

  ctx.http.route({
    ...registerRunnerRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: RegisterRunnerRequest, response: RegisterRunnerResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = RegisterRunnerRequest.parse(req.body);
      const row = (
        await tx.query<RunnerRow>(
          `INSERT INTO app.runners (workspace_id, team_id, name, capabilities, status, last_seen_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'online', now())
           ON CONFLICT (team_id, name) DO UPDATE
             SET capabilities = EXCLUDED.capabilities, status = 'online', last_seen_at = now()
           RETURNING *`,
          [team.workspace_id, team.id, body.name, JSON.stringify(body.capabilities)],
        )
      ).rows[0];
      if (!row) throw conflict('Could not register the runner');
      return json(RegisterRunnerResponse.parse({ runner: toRunner(row) }), 201);
    }),
  });

  ctx.http.route({
    ...updateRunnerRoute,
    schema: { body: UpdateRunnerRequest, response: UpdateRunnerResponse },
    handler: route(async (req, tx) => {
      const { slug, runnerId } = req.params as { slug: string; runnerId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = UpdateRunnerRequest.parse(req.body ?? {});
      const row = (
        await tx.query<RunnerRow>(
          `UPDATE app.runners
              SET status = coalesce($3, status),
                  capabilities = coalesce($4::jsonb, capabilities),
                  last_seen_at = CASE WHEN coalesce($3, '') = 'online' THEN now() ELSE last_seen_at END
            WHERE id = $1::uuid AND team_id = $2::uuid
            RETURNING *`,
          [runnerId, team.id, body.status ?? null, body.capabilities === undefined ? null : JSON.stringify(body.capabilities)],
        )
      ).rows[0];
      if (!row) throw notFound('No such runner');
      return json(UpdateRunnerResponse.parse({ runner: toRunner(row) }));
    }),
  });
}

