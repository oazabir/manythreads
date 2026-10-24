import type { PluginContext } from '@manythreads/sdk';
import { CreateTaskRequest } from '@manythreads/shared';
import { insertCard } from './create.ts';
import { handoverAllowlist, mayHandoffToActor } from './handoff.ts';

/**
 * The `tasks.*` tools a bot may be granted (PLAN P6-02). They are the same doors the routes use: the bot's allowlist decides whether the
 * broker offers them, and the SQL functions decide the rest (ownership, freshness, bounds), so a tool call and a drag cannot disagree.
 */
export function registerCapabilities(ctx: PluginContext): void {
  ctx.capabilities.register('tasks.read', async (input, tx) => {
    const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
    const rows = await tx.query(
      `SELECT t.id, t.title, t.state, t.kind, t.priority, t.owner_id, t.branch, t.base_sha, t.tested_sha, t.rework_count, t.handoff_count
         FROM app.tasks t
        WHERE t.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
          AND ($1::uuid IS NULL OR t.id = $1::uuid)
        ORDER BY t.updated_at DESC
        LIMIT 50`,
      [taskId],
    );
    return { ok: true, tasks: rows.rows };
  });

  // Creating a card is the Orchestrator's one act (SPEC §8): the run writes the card in its bot's team, never in a team the caller names.
  // The card goes through the route's own door (`insertCard`), so a card created by a tool and one created by a person are the same row and
  // the same `created` history. There is no assign tool: assignment is a handover, with the caller's `mayTag` deciding the target.
  ctx.capabilities.register('tasks.create', async (input, tx) => {
    const parsed = CreateTaskRequest.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join('.') || 'input';
      return { ok: false, code: 'invalid_input', message: `${field}: ${issue?.message ?? 'invalid'}` };
    }
    const body = parsed.data;
    const bot = (
      await tx.query<{ team_id: string; workspace_id: string }>(
        `SELECT b.team_id, b.workspace_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`,
        [tx.actor.id],
      )
    ).rows[0];
    if (!bot) return { ok: false, code: 'forbidden', message: 'only a bot of a team creates a card' };
    if (body.goalId) {
      const goal = await tx.query('SELECT 1 FROM app.goals WHERE id = $1::uuid AND team_id = $2::uuid', [body.goalId, bot.team_id]);
      if (goal.rows.length === 0) return { ok: false, code: 'not_found', message: 'no such goal in this team' };
    }
    if (body.environmentId) {
      const env = await tx.query('SELECT 1 FROM app.environments WHERE id = $1::uuid AND team_id = $2::uuid', [body.environmentId, bot.team_id]);
      if (env.rows.length === 0) return { ok: false, code: 'not_found', message: 'no such environment in this team' };
    }
    const task = await insertCard(ctx, tx, {
      workspaceId: bot.workspace_id,
      teamId: bot.team_id,
      goalId: body.goalId ?? null,
      title: body.title,
      description: body.description,
      kind: body.kind,
      priority: body.priority,
      branch: body.branch,
      environmentId: body.environmentId ?? null,
      actorId: tx.actor.id,
    });
    return { ok: true, task };
  });

  ctx.capabilities.register('tasks.claim', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const releaseAt = typeof input['ttlSeconds'] === 'number' ? Math.floor(input['ttlSeconds']) : 3600;
    const res = (await tx.query<{ o_outcome: string; o_owner_id: string | null; o_expires_at: Date | null }>('SELECT * FROM app.tasks_claim($1::uuid, $2)', [taskId, releaseAt])).rows[0];
    if (!res) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'claimed') return { ok: false, code: res.o_outcome, message: res.o_outcome };
    return { ok: true, taskId, expiresAt: (res.o_expires_at ?? new Date()).toISOString() };
  });

  ctx.capabilities.register('tasks.complete', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const testedSha = typeof input['testedSha'] === 'string' ? input['testedSha'] : null;
    const branchHeadSha = typeof input['branchHeadSha'] === 'string' ? input['branchHeadSha'] : null;
    const res = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_complete($1::uuid, $2, $3)', [taskId, testedSha, branchHeadSha])).rows[0];
    if (!res) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'done') return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    return { ok: true, taskId, testedSha };
  });

  ctx.capabilities.register('tasks.handoff', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    const toActorId = String(input['toActorId'] ?? '');
    const mode = input['mode'] === 'person' ? 'person' : 'bot';
    if (!taskId || !toActorId) return { ok: false, code: 'invalid_input', message: 'taskId and toActorId are required' };
    // The same allowlist the board enforces (P6-03): a bot reaches only the people and bots its grant's `mayTag` names.
    const mayTag = await handoverAllowlist(tx, tx.actor.id);
    if (mayTag !== null && !(await mayHandoffToActor(tx, mayTag, toActorId))) {
      return { ok: false, code: 'forbidden', message: 'that target is not in your handover.mayTag' };
    }
    const res = (
      await tx.query<{ o_outcome: string; o_handoff_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [
        taskId,
        toActorId,
        mode,
        typeof input['note'] === 'string' ? input['note'] : '',
      ])
    ).rows[0];
    if (!res) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'moved') return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    return { ok: true, taskId, handoffId: res.o_handoff_id };
  });

  ctx.capabilities.register('tasks.deploy', async (input, tx) => {
    const environmentId = String(input['environmentId'] ?? '');
    if (!environmentId) return { ok: false, code: 'invalid_input', message: 'environmentId is required' };
    const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
    const res = (
      await tx.query<{ o_outcome: string; o_reason: string; o_approval_id: string | null; o_deploy_id: string | null }>(
        'SELECT * FROM app.tasks_deploy_request($1::uuid, $2::uuid, $3)',
        [environmentId, taskId, typeof input['note'] === 'string' ? input['note'] : ''],
      )
    ).rows[0];
    if (!res) return { ok: false, code: 'internal', message: 'the deploy check answered nothing' };
    if (res.o_outcome === 'deployed') return { ok: true, environmentId, taskId };
    return { ok: false, code: res.o_outcome, message: res.o_reason, approvalId: res.o_approval_id };
  });
}
