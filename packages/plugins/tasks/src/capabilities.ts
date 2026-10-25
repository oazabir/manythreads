import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { CreateTaskRequest } from '@manythreads/shared';
import { insertCard } from './create.ts';
import { postHandoffCard } from './card.ts';
import { emitCompleted, emitHandedOff, emitUpdated } from './emit.ts';
import { handoverAllowlist, mayHandoffToActor } from './handoff.ts';
import { TASK_SELECT, toHandoff, toTask, type HandoffRow, type TaskRow } from './rows.ts';

/**
 * The `tasks.*` tools a bot may be granted (PLAN P6-02). They are the same doors the routes use: the bot's allowlist decides whether the
 * broker offers them, and the SQL functions decide the rest (ownership, freshness, bounds), so a tool call and a drag cannot disagree.
 */
async function cardOf(tx: PluginTx, taskId: string) {
  const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [taskId])).rows[0];
  return row ? toTask(row) : null;
}

type ActorLabel = { kind: string; name: string; slug: string | null };

/** Names for a list of actor ids (a person cannot read another actor's row, so this goes through the tasks door). */
async function actorLabels(tx: PluginTx, ids: string[]): Promise<Map<string, ActorLabel>> {
  if (ids.length === 0) return new Map();
  const res = await tx.query<{ o_actor_id: string; o_kind: string; o_name: string; o_slug: string | null }>(
    'SELECT o_actor_id, o_kind, o_name, o_slug FROM app.tasks_actor_labels($1::uuid[])',
    [ids],
  );
  return new Map(res.rows.map((r) => [r.o_actor_id, { kind: r.o_kind, name: r.o_name, slug: r.o_slug }]));
}

/** A bot reads by its slug (what `toBotSlug` and `mayTag` use), a person by display name; the caller's own actor ends in "(you)". */
export function labelOf(labels: Map<string, ActorLabel>, id: string, self: string): string {
  const l = labels.get(id);
  const base = l ? (l.slug ?? l.name) : 'unknown';
  return id === self ? `${base} (you)` : base;
}

export function registerCapabilities(ctx: PluginContext): void {
  ctx.capabilities.register('tasks.read', async (input, tx) => {
    const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
    const rows = await tx.query<{ owner_id: string | null; created_by: string | null }>(
      `SELECT t.id, t.title, t.state, t.kind, t.priority, t.owner_id, t.created_by, t.branch, t.base_sha, t.tested_sha, t.rework_count, t.handoff_count
         FROM app.tasks t
        WHERE t.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
          AND ($1::uuid IS NULL OR t.id = $1::uuid)
        ORDER BY t.updated_at DESC
        LIMIT 50`,
      [taskId],
    );
    // An id alone tells a bot nothing (live bug: a Reviewer read its own actor id as the Coder's). Every owner and creator is named next to
    // its id, and the caller's own cards say so: `owner: "reviewer (you)"`.
    const ids = [...new Set(rows.rows.flatMap((r) => [r.owner_id, r.created_by, tx.actor.id]).filter((v): v is string => v !== null))];
    const labels = await actorLabels(tx, ids);
    const name = (id: string | null): string | null => (id === null ? null : labelOf(labels, id, tx.actor.id));
    return {
      ok: true,
      you: name(tx.actor.id),
      tasks: rows.rows.map((r) => ({ ...r, owner: name(r.owner_id), creator: name(r.created_by) })),
    };
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
    // A card made in a run that answers in a thread of this team belongs to that thread, so its completion can wake the creator there.
    // The door does nothing when the run has no such thread; the card is read again to carry the link.
    await tx.query('SELECT app.tasks_link_run_thread($1::uuid)', [task.id]);
    return { ok: true, task: (await cardOf(tx, task.id)) ?? task };
  });

  ctx.capabilities.register('tasks.claim', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const releaseAt = typeof input['ttlSeconds'] === 'number' ? Math.floor(input['ttlSeconds']) : 3600;
    const res = (await tx.query<{ o_outcome: string; o_owner_id: string | null; o_expires_at: Date | null }>('SELECT * FROM app.tasks_claim($1::uuid, $2)', [taskId, releaseAt])).rows[0];
    if (!res) return { ok: false, code: 'not_found', message: 'no such card' };
    // Claiming a card you already hold is a no-op that succeeds: no second claim row, no event (a model that lost track of what it owns just continues).
    if (res.o_outcome === 'already_owned' && res.o_owner_id === tx.actor.id) {
      const live = await tx.query<{ expires_at: Date }>('SELECT expires_at FROM app.task_claims WHERE task_id = $1::uuid AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1', [taskId]);
      return { ok: true, taskId, alreadyYours: true, expiresAt: (live.rows[0]?.expires_at ?? new Date()).toISOString() };
    }
    if (res.o_outcome !== 'claimed') return { ok: false, code: res.o_outcome, message: res.o_outcome };
    return { ok: true, taskId, expiresAt: (res.o_expires_at ?? new Date()).toISOString() };
  });

  ctx.capabilities.register('tasks.complete', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const testedSha = typeof input['testedSha'] === 'string' ? input['testedSha'] : null;
    const branchHeadSha = typeof input['branchHeadSha'] === 'string' ? input['branchHeadSha'] : null;
    const before = await cardOf(tx, taskId);
    const res = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_complete($1::uuid, $2, $3)', [taskId, testedSha, branchHeadSha])).rows[0];
    if (!res || !before) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'done') return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    // The same two events the route writes: a tool call and a drag are one history, and whoever watches the card (a board, the creator bot) hears both.
    const after = (await cardOf(tx, taskId)) ?? before;
    await emitCompleted(ctx, tx, after);
    await emitUpdated(ctx, tx, before, after);
    return { ok: true, taskId, testedSha };
  });

  ctx.capabilities.register('tasks.handoff', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    const mode = input['mode'] === 'person' ? 'person' : 'bot';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid) from tasks.read' };
    // The target is named by bot slug (`toBotSlug`, what handover.mayTag lists) or by actor id (`toActorId`). A model that has only a slug
    // often puts it in `toActorId`, so a value that is not a uuid is read as a slug rather than failing inside the database.
    const named = [input['toBotSlug'], input['toActorId'], input['to']].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim();
    if (!named) return { ok: false, code: 'invalid_input', message: 'name who takes the card: toBotSlug (a bot of your team, e.g. "reviewer") or toActorId' };
    let toActorId = named;
    if (!UUID.test(named)) {
      const bot = (
        await tx.query<{ team_id: string }>(`SELECT b.team_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`, [tx.actor.id])
      ).rows[0];
      const target = bot ? (await tx.query<{ id: string }>('SELECT o_actor_id AS id FROM app.tasks_bot_of($1::uuid, $2)', [bot.team_id, named])).rows[0] : undefined;
      if (!target) return { ok: false, code: 'not_found', message: `no active bot "${named}" in your team; pass toBotSlug with the slug of a bot you may hand to` };
      toActorId = target.id;
    }
    // The same allowlist the board enforces (P6-03): a bot reaches only the people and bots its grant's `mayTag` names.
    const mayTag = await handoverAllowlist(tx, tx.actor.id);
    if (mayTag !== null && !(await mayHandoffToActor(tx, mayTag, toActorId))) {
      return {
        ok: false,
        code: 'forbidden',
        message: `"${named}" is not in your handover.mayTag${mayTag.length ? ` (${mayTag.join(', ')})` : ' (it is empty)'}; hand the card to one of those`,
      };
    }
    const note = typeof input['note'] === 'string' ? input['note'] : '';
    const before = await cardOf(tx, taskId);
    const res = (
      await tx.query<{ o_outcome: string; o_handoff_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [taskId, toActorId, mode, note])
    ).rows[0];
    if (!res || !before) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'moved' || !res.o_handoff_id) return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    // Same as the route: the events (the second one wakes the new owner), then the visible card message in the card's thread.
    const handoffRow = (await tx.query<HandoffRow>('SELECT * FROM app.handoffs WHERE id = $1::uuid', [res.o_handoff_id])).rows[0];
    const after = (await cardOf(tx, taskId)) ?? before;
    if (handoffRow) {
      await emitHandedOff(ctx, tx, after, toHandoff(handoffRow));
      await emitUpdated(ctx, tx, before, after);
      await postHandoffCard(ctx, tx, { task: after, handoffId: res.o_handoff_id, toActorId, note, pending: false });
    }
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
