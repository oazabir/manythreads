import type { HttpCaller, MessageProvider, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  GoalStep,
  SURFACE_REGISTRY,
  SurfacesSurfaceRenderedEvent,
  TasksGoalUpdatedEvent,
  TasksTaskCompletedEvent,
  TasksTaskHandedOffEvent,
  TasksTaskUpdatedEvent,
  cardRefOfTitle,
  goalLine,
  goalRef,
  goalSteps,
  parseSurface,
  type GoalCardFacts,
  type GoalCardRef,
  type GoalStatus,
  type TaskState,
} from '@manythreads/shared';
import { addLine, refuse, type RunContext } from './common.ts';
import type { SurfaceRow } from './mappers.ts';
import { eventTeamId, pushChanged } from './notify.ts';

// The plan card (PLAN P22-03, docs/plugins/surfaces.md "The plan card"): one surface message in the goal's channel that shows where the goal stands.
//
//  * `renderGoalCard` is `surface.render {goalId, target: "channel"}`. The bot writes no screen text: the platform writes `GoalCard(...)` bound to the read `tasks.goal`,
//    which each viewer runs as themself (so a viewer sees only what they may read: no spend, no board link). One card per goal, however often or however many runs
//    ask: a unique index on `surfaces.goal_id`, and the insert is a `getOneOrCreate`.
//  * `registerPlanCardFollower` makes the card follow the board. A card, a handoff or the goal itself changing tells every open page to read the card's bound data
//    again (`surfaces.changed {reason: 'data'}`) and rewrites the short line an old client shows as the message text.

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** One line of plain text: control characters and line separators (which would end an OpenUI statement or fail a title check) become spaces. */
const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const q = (s: string): string => JSON.stringify(s);

/** The facts of a goal's cards, worked out by the same pure rule the read `tasks.goal` uses, so the line and the card agree. */
export async function goalLineOf(tx: PluginTx, goalId: string): Promise<{ ref: string; line: string } | null> {
  const goal = (
    await tx.query<{ id: string; number: number; status: GoalStatus; steps: unknown }>('SELECT id, number, status, steps FROM app.goals WHERE id = $1::uuid', [goalId])
  ).rows[0];
  if (!goal) return null;
  const steps = GoalStep.array().safeParse(goal.steps);
  // The goal's cards, the newest of each role (plan, work, publish), and who held each: the same reading as `tasks.goal` (tasks plugin, goals.ts).
  const cards = (
    await tx.query<{ id: string; title: string; state: TaskState; blocker_reason: string; owner_id: string | null; created_by: string | null }>(
      'SELECT t.id, t.title, t.state, t.blocker_reason, t.owner_id, t.created_by FROM app.tasks t WHERE t.goal_id = $1::uuid ORDER BY t.created_at, t.id',
      [goal.id],
    )
  ).rows;
  const newest = new Map<GoalCardRef, (typeof cards)[number]>();
  for (const card of cards) newest.set(cardRefOfTitle(card.title), card);
  const chosen = [...newest.values()];
  const handoffs =
    chosen.length === 0
      ? []
      : (
          await tx.query<{ task_id: string; from_actor_id: string; to_actor_id: string }>(
            'SELECT h.task_id, h.from_actor_id, h.to_actor_id FROM app.handoffs h WHERE h.task_id = ANY($1::uuid[]) AND h.applied_at IS NOT NULL ORDER BY h.task_id, h.id',
            [chosen.map((c) => c.id)],
          )
        ).rows;
  const actorIds = new Set<string>();
  for (const c of chosen) [c.owner_id, c.created_by].forEach((id) => id && actorIds.add(id));
  for (const h of handoffs) [h.from_actor_id, h.to_actor_id].forEach((id) => actorIds.add(id));
  const slugs = new Map(
    actorIds.size === 0
      ? []
      : (await tx.query<{ o_actor_id: string; o_slug: string | null }>('SELECT o_actor_id, o_slug FROM app.tasks_actor_labels($1::uuid[])', [[...actorIds]])).rows.map((r) => [r.o_actor_id, r.o_slug] as const),
  );
  const slugOf = (id: string | null): string | null => (id === null ? null : (slugs.get(id) ?? null));
  const facts: Partial<Record<GoalCardRef, GoalCardFacts>> = {};
  for (const [role, card] of newest) {
    const mine = handoffs.filter((h) => h.task_id === card.id);
    const holders: (string | null)[] = mine.length > 0 ? [slugOf(mine[0]!.from_actor_id), ...mine.map((h) => slugOf(h.to_actor_id))] : [];
    const lastActor = mine.length > 0 ? mine[mine.length - 1]!.to_actor_id : null;
    if (card.owner_id !== null && card.owner_id !== lastActor) holders.push(slugOf(card.owner_id));
    if (holders.length === 0) holders.push(slugOf(card.created_by));
    facts[role] = { state: card.state, blockerReason: card.blocker_reason, holders };
  }
  const worked = goalSteps({ goalStatus: goal.status, steps: steps.success ? steps.data : [], cards: facts });
  const ref = goalRef(goal.number);
  return { ref, line: goalLine(ref, worked) };
}

const existing = (s: { id: string; version: number }): Record<string, unknown> => ({
  ok: true,
  surfaceId: s.id,
  version: s.version,
  created: false,
  message: 'This goal already has its plan card in the channel. Nothing was posted. It follows the goal on its own; change the plan with goals.plan.',
});

/**
 * `surface.render {goalId, target: "channel"}`. The checks, in order, each with the answer a model can act on: inside a run (the caller has checked); the goal is a
 * goal of the bot's team and was given in the channel this run answers in (else `not_found`, the same for a goal that does not exist); the bot may post in the
 * channel (else `forbidden`, and nothing is written); the channel is a team channel, not a direct message or a bot conversation (else `no_place`). Then the card
 * is made once for the goal: a second call, a restarted run, or two runs at the same moment get the same `surfaceId` with `created: false` and post nothing.
 */
export async function renderGoalCard(ctx: PluginContext, tx: PluginTx, run: RunContext, goalId: string): Promise<Record<string, unknown>> {
  const channelId = run.channel_id;
  if (channelId === null) return refuse('no_place', 'This run was not started in a channel, so there is nowhere to post the plan card.');
  const goal = (
    await tx.query<{ id: string; number: number; title: string }>(
      'SELECT g.id, g.number, g.title FROM app.goals g WHERE g.id = $1::uuid AND g.team_id = $2::uuid AND g.channel_id = $3::uuid',
      [goalId, run.team_id, channelId],
    )
  ).rows[0];
  if (!goal) return refuse('not_found', 'There is no such goal of your team that was given in this channel. Use the goalId that goals.ensure answered with, in the channel it was given in.');
  const can = (await tx.query<{ ok: boolean | null }>('SELECT app.channel_actor_can_post(app.actor(), $1::uuid) AS ok', [channelId])).rows[0]?.ok === true;
  if (!can) return refuse('forbidden', 'You cannot post in this channel, so you cannot post the plan card in it.');
  if (run.channel_kind !== 'channel') {
    return refuse('no_place', 'The plan card goes in a team channel. This run answers in a direct message or a conversation with a bot, so nothing was posted.');
  }

  const found = (await tx.query<{ id: string; version: number }>('SELECT id, version FROM app.surfaces WHERE goal_id = $1::uuid', [goal.id])).rows[0];
  if (found) return existing(found);

  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return refuse('unavailable', 'Messages are not available in this deployment.');

  const ref = goalRef(goal.number);
  const heading = clip(oneLine(`${ref} · ${goal.title}`), 200);
  const source = `root = GoalCard(${q(goal.id)}, ${q(heading)}, null, {tool: "tasks.goal", args: {goalId: ${q(goal.id)}}, into: {plan: "plan"}})\n`;
  // The platform wrote this text, so it must be a screen the page draws; anything else is a bug here, not the model's mistake.
  const tree = parseSurface(source, SURFACE_REGISTRY);
  if (tree.problems.length > 0 || tree.root === null || tree.root.kind !== 'component') {
    throw new Error(`the plan card of a goal is not a screen the page can draw: ${tree.problems[0]?.message ?? 'no root'}`);
  }

  // One card per goal. The row is drawn with a pre-made id: when the insert finds the card another run made, the id that comes back is not ours.
  const drawn = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
  const row = await ctx.db.getOneOrCreate<SurfaceRow>(tx, {
    table: 'app.surfaces',
    values: {
      id: drawn,
      workspace_id: run.workspace_id,
      channel_id: channelId,
      bot_id: run.bot_id,
      thread_root_id: null,
      title: heading,
      source,
      created_by: tx.actor.id,
      goal_id: goal.id,
    },
    conflict: ['goal_id'],
    conflictWhere: 'goal_id IS NOT NULL',
  });
  if (row.id !== drawn) return existing({ id: row.id, version: row.version });

  const line = { id: row.id, workspace_id: row.workspace_id, channel_id: row.channel_id };
  await addLine(tx, line, 'render', 1, null, { chars: source.length, problems: 0, goal: true });

  // The channel shows the card through a message of the bot's, at the top level of the channel. Its text is the line an old client shows. `skipRefs`: nobody is
  // notified. A refusal throws (the channels plugin's own error) and rolls the whole call back, so a card is never left without its message.
  const now = await goalLineOf(tx, goal.id);
  const posted = await messages.post(tx, { channelId, body: now?.line ?? `Goal ${ref}`, threadRootId: null, meta: { surfaceRef: row.id }, skipRefs: true });
  await tx.query('UPDATE app.surfaces SET message_id = $2::uuid WHERE id = $1::uuid', [row.id, posted.id]);

  await ctx.audit.emit(
    tx,
    SurfacesSurfaceRenderedEvent.parse({
      type: 'surfaces.surface.rendered',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: await eventTeamId(tx, row.channel_id),
      channelId: row.channel_id,
      surfaceId: row.id,
      botId: row.bot_id,
      runId: run.run_id,
      version: row.version,
      problemCount: 0,
      at: ctx.runtime.now().toISOString(),
    }),
  );
  await pushChanged(ctx, tx, { channelId: row.channel_id, surfaceId: row.id, version: row.version });
  return { ok: true, surfaceId: row.id, version: row.version, created: true, message: 'The plan card is posted in the channel. It follows the goal on its own: do not post it again, and change the plan with goals.plan.' };
}

// Following the board ------------------------------------------------------------------------------------------------------------------------

type CardRow = { id: string; workspace_id: string; channel_id: string; version: number; goal_id: string; message_id: string | null; created_by: string };
const CARD_COLUMNS = 's.id, s.workspace_id, s.channel_id, s.version, s.goal_id, s.message_id, s.created_by';

/** The statuses a bot's own edit of its message may be refused with, in ordinary life: it can no longer post there, the message or channel is gone, archived or deleted. */
const EXPECTED_EDIT_REFUSALS = new Set([403, 404, 409]);

/**
 * One plan card to bring up to date after its goal moved: rewrite the short line of its message when it changed, then tell the open pages to read the card's bound data
 * again. The pages read it as themselves (`tasks.goal`), so this carries no data of the goal: only that it may have changed.
 *
 * The message is edited AS THE BOT that posted it, through `MessageProvider.edit` in a transaction of its own (`ctx.db.as`): the edit is the bot's own edit of its own
 * message under the channel's ordinary rules (the author, the post right, a live message in an open channel), so a bot taken out of the channel simply no longer
 * updates the line, and the provider's edit never wakes anyone (it leaves mentions and links as they were). No system door writes into the channel. A refusal
 * of that kind keeps the old line; anything else (the database is down) is thrown, so the event is delivered again.
 */
async function follow(ctx: PluginContext, tx: PluginTx, card: CardRow): Promise<void> {
  if (card.message_id !== null) {
    const now = await goalLineOf(tx, card.goal_id);
    const current = (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE id = $1::uuid AND deleted_at IS NULL', [card.message_id])).rows[0];
    const messages = ctx.providers.get<MessageProvider>('messages');
    if (now !== null && current !== undefined && current.body !== now.line && messages !== undefined) {
      const bot: HttpCaller = { actorId: card.created_by, kind: 'bot', workspaceId: card.workspace_id, personId: null, sessionId: null };
      try {
        await ctx.db.as(bot, (botTx) => messages.edit(botTx, { channelId: card.channel_id, messageId: card.message_id!, body: now.line }));
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        if (typeof status !== 'number' || !EXPECTED_EDIT_REFUSALS.has(status)) throw e;
      }
    }
  }
  await pushChanged(ctx, tx, { channelId: card.channel_id, surfaceId: card.id, version: card.version }, 'data');
}

/** Every plan card of the goal a card (task) belongs to, or of the goal itself. System transaction: the event says what happened, not who may see it. */
async function cardsOfTask(tx: PluginTx, taskId: string): Promise<CardRow[]> {
  return (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM app.tasks t JOIN app.surfaces s ON s.goal_id = t.goal_id WHERE t.id = $1::uuid`, [taskId])).rows;
}
async function cardsOfGoal(tx: PluginTx, goalId: string): Promise<CardRow[]> {
  return (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM app.surfaces s WHERE s.goal_id = $1::uuid`, [goalId])).rows;
}

/** Subscribes to what moves a goal: a card changed, handed off or completed, or the goal's plan or status changed (tasks events, delivered by the outbox within seconds). */
export function registerPlanCardFollower(ctx: PluginContext): void {
  const onTask = (parse: (raw: PluginEvent) => { taskId: string }) => async (raw: PluginEvent, tx: PluginTx) => {
    for (const card of await cardsOfTask(tx, parse(raw).taskId)) await follow(ctx, tx, card);
  };
  ctx.events.subscribe('tasks.task.updated', onTask((raw) => TasksTaskUpdatedEvent.parse(raw)));
  ctx.events.subscribe('tasks.task.handed_off', onTask((raw) => TasksTaskHandedOffEvent.parse(raw)));
  ctx.events.subscribe('tasks.task.completed', onTask((raw) => TasksTaskCompletedEvent.parse(raw)));
  ctx.events.subscribe('tasks.goal.updated', async (raw: PluginEvent, tx: PluginTx) => {
    for (const card of await cardsOfGoal(tx, TasksGoalUpdatedEvent.parse(raw).goalId)) await follow(ctx, tx, card);
  });
}
