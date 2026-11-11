import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  BOT_BOARD_NAME,
  GoalsEnsureInput,
  GoalsPlanInput,
  TasksGoalAnswer,
  TasksGoalInput,
  cardRefOfTitle,
  goalRef,
  goalSteps,
  stepDot,
  stepWords,
  type GoalCardFacts,
  type GoalCardRef,
  type Task,
} from '@manythreads/shared';
import { actorLabels } from './capabilities.ts';
import { emitGoalUpdated } from './emit.ts';
import { GOAL_COLUMNS, TASK_SELECT, toGoal, toTask, type GoalRow, type TaskRow } from './rows.ts';

/**
 * The goal tools (PLAN P22-03, docs/plugins/tasks.md "Goals"): `goals.ensure` makes (or finds) the goal of the thread a bot's run answers in, `goals.plan`
 * sets its steps, and `tasks.goal` reads the plan as the caller, worked out from the cards (`goalSteps`). A step is not a card: the steps are stored on the goal,
 * the state of each is read off the cards and their handoffs, so the bots keep passing one card along as before.
 */

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

function invalid(error: { issues: { path: PropertyKey[]; message: string }[] }): Fail {
  const issue = error.issues[0];
  return fail('invalid_input', `${issue?.path.map(String).join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
}

async function botOf(tx: PluginTx): Promise<{ team_id: string; workspace_id: string } | undefined> {
  return (
    await tx.query<{ team_id: string; workspace_id: string }>(
      `SELECT b.team_id, b.workspace_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`,
      [tx.actor.id],
    )
  ).rows[0];
}

/** `web-smoke-tester` → `Web smoke tester`: the name shown for a bot the caller cannot read any more (a plan never shows a slug). */
const prettySlug = (slug: string): string => {
  const words = slug.replace(/[._-]+/g, ' ').trim();
  return words === '' ? 'A bot' : words.charAt(0).toUpperCase() + words.slice(1);
};

export function registerGoalCapabilities(ctx: PluginContext): void {
  // The goal of the thread this run answers in. The channel and the thread come from the run (a definer door), never from the model, and the goal is
  // looked up first so that asking again changes nothing (not even the numbering counter); a race between two first calls is settled by the unique index.
  ctx.capabilities.register('goals.ensure', async (input, tx) => {
    const parsed = GoalsEnsureInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    const bot = await botOf(tx);
    if (!bot) return fail('forbidden', 'only a bot of a team makes a goal');
    const place = (await tx.query<{ o_team_id: string; o_channel_id: string; o_thread_root_id: string }>('SELECT * FROM app.tasks_run_thread()')).rows[0];
    if (!place) return fail('no_thread', 'goals.ensure needs a run that answers in a thread of a team channel (not a direct message, not an archived channel)');
    if (place.o_team_id !== bot.team_id) return fail('forbidden', 'this run answers in a channel of another team');
    const found = (
      await tx.query<GoalRow>(`SELECT ${GOAL_COLUMNS} FROM app.goals WHERE team_id = $1::uuid AND thread_root_id = $2::uuid`, [bot.team_id, place.o_thread_root_id])
    ).rows[0];
    if (found) {
      const g = toGoal(found);
      return { ok: true, goalId: g.id, ref: goalRef(g.number), number: g.number, created: false };
    }
    const drawn = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    const row = await ctx.db.getOneOrCreate<GoalRow>(tx, {
      table: 'app.goals',
      values: {
        id: drawn,
        workspace_id: bot.workspace_id,
        team_id: bot.team_id,
        title: body.title,
        description: body.description,
        budget_usd: body.budgetUsd ?? null,
        channel_id: place.o_channel_id,
        thread_root_id: place.o_thread_root_id,
        created_by: tx.actor.id,
      },
      conflict: ['team_id', 'thread_root_id'],
      conflictWhere: 'thread_root_id IS NOT NULL',
    });
    const goal = toGoal(row);
    const created = goal.id === drawn;
    if (created) await emitGoalUpdated(ctx, tx, goal, 'created');
    return { ok: true, goalId: goal.id, ref: goalRef(goal.number), number: goal.number, created };
  });

  // Replace the steps of a goal of the caller's team. Every bot slug must be a bot of that team.
  ctx.capabilities.register('goals.plan', async (input, tx) => {
    const parsed = GoalsPlanInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    const bot = await botOf(tx);
    if (!bot) return fail('forbidden', 'only a bot of a team plans a goal');
    const goal = (await tx.query<{ status: string }>('SELECT status FROM app.goals WHERE id = $1::uuid AND team_id = $2::uuid', [body.goalId, bot.team_id])).rows[0];
    if (!goal) return fail('not_found', 'no such goal in this team');
    if (goal.status !== 'open') return fail('conflict', `the goal is ${goal.status}; its plan no longer changes`);
    const slugs = [...new Set(body.steps.flatMap((s) => s.bots))];
    const known = new Set((await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE team_id = $1::uuid AND slug = ANY($2::text[])', [bot.team_id, slugs])).rows.map((r) => r.slug));
    const unknown = slugs.filter((s) => !known.has(s));
    if (unknown.length > 0) return fail('invalid_input', `steps: no bot of this team has the slug ${unknown.slice(0, 5).join(', ')}`);
    const row = (
      await tx.query<GoalRow>(`UPDATE app.goals SET steps = $2::jsonb, updated_at = now() WHERE id = $1::uuid AND team_id = $3::uuid RETURNING ${GOAL_COLUMNS}`, [
        body.goalId,
        JSON.stringify(body.steps),
        bot.team_id,
      ])
    ).rows[0];
    if (!row) return fail('forbidden', 'you cannot change this goal');
    const saved = toGoal(row);
    await emitGoalUpdated(ctx, tx, saved, 'planned');
    return { ok: true, goalId: saved.id, ref: goalRef(saved.number), stepCount: saved.steps.length };
  });

  // The plan of one goal, as the caller sees it: every read below runs under the caller's own row-level security, except the spend (a definer door that
  // checks the caller reads the team) and the actor names (the same door `tasks.read` uses).
  ctx.capabilities.register('tasks.goal', async (input, tx) => {
    const parsed = TasksGoalInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const goalRow = (await tx.query<GoalRow>(`SELECT ${GOAL_COLUMNS} FROM app.goals WHERE id = $1::uuid`, [parsed.data.goalId])).rows[0];
    if (!goalRow) return fail('not_found', 'no such goal');
    const goal = toGoal(goalRow);

    // the goal's cards, the newest of each role (plan, work, publish), and who held each
    const cards = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.goal_id = $1::uuid ORDER BY t.created_at, t.id`, [goal.id])).rows.map(toTask);
    const newest = new Map<GoalCardRef, Task>();
    for (const card of cards) newest.set(cardRefOfTitle(card.title), card);
    const chosen = [...newest.values()];
    const handoffs =
      chosen.length === 0
        ? []
        : (
            await tx.query<{ task_id: string; from_actor_id: string; to_actor_id: string }>(
              `SELECT h.task_id, h.from_actor_id, h.to_actor_id FROM app.handoffs h
                WHERE h.task_id = ANY($1::uuid[]) AND h.applied_at IS NOT NULL ORDER BY h.task_id, h.id`,
              [chosen.map((c) => c.id)],
            )
          ).rows;
    const actorIds = new Set<string>();
    for (const c of chosen) [c.ownerId, c.createdBy].forEach((id) => id && actorIds.add(id));
    for (const h of handoffs) [h.from_actor_id, h.to_actor_id].forEach((id) => actorIds.add(id));

    // the thread: the first message must be readable by the caller, else there is no thread to show
    let thread: { rootId: string; replies: number; lastName: string | null; lastAt: string | null; faces: string[] } | null = null;
    let authors: string[] = [];
    if (goal.threadRootId) {
      const root = (await tx.query<{ id: string }>('SELECT id FROM app.messages WHERE id = $1::uuid AND deleted_at IS NULL', [goal.threadRootId])).rows[0];
      if (root) {
        const meta = (await tx.query<{ reply_count: number; last_reply_at: Date }>('SELECT reply_count, last_reply_at FROM app.threads WHERE root_message_id = $1::uuid', [root.id])).rows[0];
        authors = (
          await tx.query<{ author_id: string }>(
            'SELECT author_id FROM app.messages WHERE thread_root_id = $1::uuid AND deleted_at IS NULL ORDER BY id DESC LIMIT 30',
            [root.id],
          )
        ).rows.map((r) => r.author_id);
        authors.forEach((id) => actorIds.add(id));
        const replies = meta?.reply_count ?? 0;
        thread = { rootId: root.id, replies, lastName: null, lastAt: replies > 0 && meta ? new Date(meta.last_reply_at).toISOString() : null, faces: [] };
      }
    }
    const labels = await actorLabels(tx, [...actorIds]);
    const slugOf = (id: string | null): string | null => (id === null ? null : (labels.get(id)?.slug ?? null));

    const facts: Partial<Record<GoalCardRef, GoalCardFacts>> = {};
    for (const [role, card] of newest) {
      const mine = handoffs.filter((h) => h.task_id === card.id);
      const holders: (string | null)[] = mine.length > 0 ? [slugOf(mine[0]!.from_actor_id), ...mine.map((h) => slugOf(h.to_actor_id))] : [];
      const lastActor = mine.length > 0 ? mine[mine.length - 1]!.to_actor_id : null;
      if (card.ownerId !== null && card.ownerId !== lastActor) holders.push(slugOf(card.ownerId));
      if (holders.length === 0) holders.push(slugOf(card.createdBy));
      facts[role] = { state: card.state, blockerReason: card.blockerReason, holders };
    }
    const worked = goalSteps({ goalStatus: goal.status, steps: goal.steps, cards: facts });

    // bots by display name, never by slug
    const slugs = [...new Set(goal.steps.flatMap((s) => s.bots))];
    const names = new Map(
      slugs.length === 0
        ? []
        : (await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM app.bots WHERE team_id = $1::uuid AND slug = ANY($2::text[])', [goal.teamId, slugs])).rows.map((r) => [r.slug, r.name] as const),
    );

    if (thread) {
      const names3 = [...new Set(authors.map((id) => labels.get(id)?.name).filter((n): n is string => n !== undefined && n !== ''))];
      thread.lastName = authors.length > 0 ? (labels.get(authors[0]!)?.name ?? null) : null;
      thread.faces = names3.slice(0, 3);
    }

    // the board: the one the goal's newest card is filed on, else the Bot Board of the goal's channel; null when the caller cannot read it
    let boardId: string | null = null;
    const filed = [...cards].reverse().find((c) => c.boardId !== null);
    if (filed?.boardId) boardId = (await tx.query<{ id: string }>('SELECT id FROM app.boards WHERE id = $1::uuid', [filed.boardId])).rows[0]?.id ?? null;
    if (boardId === null && goal.channelId) {
      boardId = (await tx.query<{ id: string }>('SELECT id FROM app.boards WHERE channel_id = $1::uuid AND name = $2 AND team_id = $3::uuid', [goal.channelId, BOT_BOARD_NAME, goal.teamId])).rows[0]?.id ?? null;
    }
    const slug = boardId ? (await tx.query<{ slug: string }>('SELECT slug FROM app.teams WHERE id = $1::uuid', [goal.teamId])).rows[0]?.slug : undefined;

    const usd = (await tx.query<{ usd: string | null }>('SELECT app.tasks_goal_spend($1::uuid)::text AS usd', [goal.id])).rows[0]?.usd ?? null;

    return TasksGoalAnswer.parse({
      ok: true,
      plan: {
        ref: goalRef(goal.number),
        title: goal.title,
        chip: worked.chip,
        spend: usd === null ? null : { usd: Number(usd), budgetUsd: goal.budgetUsd },
        steps: goal.steps.map((s, i) => {
          const state = worked.steps[i]!;
          return { title: s.title, bots: s.bots.map((b) => names.get(b) ?? prettySlug(b)), status: stepWords(state), dot: stepDot(state), rework: state.rework };
        }),
        stepNow: worked.stepNow,
        stepCount: worked.stepCount,
        board: boardId && slug ? { teamSlug: slug, boardId } : null,
        thread,
      },
    });
  });
}
