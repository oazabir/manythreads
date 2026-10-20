import type { PluginContext } from '@manythreads/sdk';
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
