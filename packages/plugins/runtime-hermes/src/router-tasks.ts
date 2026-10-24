import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { RuntimeTaskNotWokenEvent, TasksTaskCompletedEvent, TasksTaskHandedOffEvent, type BotTrigger } from '@manythreads/shared';
import { buildTaskPrompt } from './match.ts';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// The `task_assigned` trigger (PLAN P6-02, P6-03; SPEC §7.6, §8). Two events of the tasks plugin wake a bot:
//
//  * `tasks.task.handed_off` — the card's owner became this bot. A non-strict handover emits it at once; a `strict` one (waits in the
//    Approvals inbox) emits it only after the approval applied the move, so a refused or pending handover wakes nobody. A claim by the bot
//    itself is `tasks.task.claimed`, which is not subscribed to: a bot is never woken by taking a card.
//  * `tasks.task.completed` — a card this bot created was finished by someone else (the Orchestrator hears that its card is done).
//
// Both start the bot only if its BOT.md lists a `task_assigned` trigger. Exactly one run per assignment: the job's dedupe key is the
// handoff's id (the stable id of that assignment; the event is delivered at least once) — and the announcement message the handover posts in
// the card's thread is skipped by the message router, so its @mention starts no second run.
//
// The run answers in the card's thread (`tasks.thread_root_id`, set by the first handover announcement). That thread may be in a PRIVATE
// channel of the team (where the handover was asked for), so the new owner must be able to post there (the channel visibility rule, evaluated
// for that bot); otherwise nothing is started. Every miss (no thread, a channel that went away, a bot that cannot post, too many wakes) is
// emitted as `runtime.task.not_woken` and lands on the card's history, so a card nobody picked up says why. A bot is never woken by itself,
// and the chain orchestrator → coder → tester → reviewer → … is bounded by the tasks door that counts hand-overs (`handoff_count`, five).
// Completion wakes are bounded here: a creator bot is woken by finished cards at most `MAX_DONE_WAKES` (three) times an hour. The count is the
// completion-wake jobs of that bot created in the last hour (any state: queued, running or finished), taken under a per-bot advisory lock so a
// burst of completions delivered together cannot all pass. These runs record no `delegation_depth`: they are not a mention chain.

const MAX_DONE_WAKES = 3;

interface BotRow {
  id: string;
  slug: string;
  name: string;
  triggers: BotTrigger[] | null;
  [key: string]: unknown;
}

interface CardRow {
  id: string;
  title: string;
  kind: string;
  state: string;
  description: string;
  branch: string;
  base_sha: string | null;
  tested_sha: string | null;
  owner_id: string | null;
  created_by: string;
  thread_root_id: string | null;
  completed_ms: string | null;
  [key: string]: unknown;
}

/** The active bot behind an actor, on `teamId`, when its definition lists `task_assigned`. */
async function wakeableBot(tx: PluginTx, actorId: string, teamId: string): Promise<BotRow | null> {
  const bot = (
    await tx.query<BotRow>(
      `SELECT b.id, b.slug, b.name, b.triggers FROM app.actors a JOIN app.bots b ON b.id = a.ref_id
        WHERE a.id = $1::uuid AND a.kind = 'bot' AND b.team_id = $2::uuid AND b.status = 'active'`,
      [actorId, teamId],
    )
  ).rows[0];
  return bot && (bot.triggers ?? []).some((t) => t.type === 'task_assigned') ? bot : null;
}

async function actorName(tx: PluginTx, actorId: string): Promise<{ kind: string; name: string }> {
  const row = (
    await tx.query<{ kind: string; name: string }>(
      `SELECT a.kind, coalesce(p.display_name, b.name, 'Someone') AS name FROM app.actors a
         LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
         LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
        WHERE a.id = $1::uuid`,
      [actorId],
    )
  ).rows[0];
  return row ?? { kind: 'person', name: 'Someone' };
}

type ThreadFailure = 'no_thread' | 'channel_unavailable' | 'receiver_cannot_post';

/**
 * Where the bot answers: the card's thread, if its root is a live message of an unarchived channel of the team (public or private), and the
 * bot may post there, by `app.channel_actor_can_post` (the same rule that decides what a bot sees, evaluated for that bot).
 */
async function cardThread(
  tx: PluginTx,
  card: CardRow,
  teamId: string,
  workspaceId: string,
  botActorId: string,
): Promise<{ channelId: string; channelName: string; rootId: string; threadKnown: boolean } | ThreadFailure> {
  if (!card.thread_root_id) return 'no_thread';
  const root = (
    await tx.query<{ channel_id: string; channel_name: string; thread_known: boolean }>(
      `SELECT c.id AS channel_id, c.name AS channel_name, EXISTS (SELECT 1 FROM app.threads t WHERE t.root_message_id = m.id) AS thread_known
         FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
        WHERE m.id = $1::uuid AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
          AND c.team_id = $2::uuid AND c.kind = 'channel' AND c.archived_at IS NULL`,
      [card.thread_root_id, teamId],
    )
  ).rows[0];
  if (!root) return 'channel_unavailable';
  const can = (await tx.query<{ ok: boolean }>('SELECT app.channel_actor_can_post($1::uuid, $2::uuid) AS ok', [botActorId, root.channel_id])).rows[0]?.ok === true;
  if (!can) return 'receiver_cannot_post';
  return { channelId: root.channel_id, channelName: root.channel_name, rootId: card.thread_root_id, threadKnown: root.thread_known };
}

async function notWoken(ctx: PluginContext, tx: PluginTx, e: { workspaceId: string; teamId: string; taskId: string; botId: string; reason: ThreadFailure | 'wake_limit' }): Promise<void> {
  await ctx.audit.emit(tx, RuntimeTaskNotWokenEvent.parse({ type: 'runtime.task.not_woken', schemaVersion: 1, ...e }));
}

async function loadCard(tx: PluginTx, taskId: string, teamId: string): Promise<CardRow | undefined> {
  return (
    await tx.query<CardRow>(
      `SELECT id, title, kind, state, description, branch, base_sha, tested_sha, owner_id, created_by, thread_root_id,
              (extract(epoch FROM completed_at) * 1000)::bigint::text AS completed_ms
         FROM app.tasks WHERE id = $1::uuid AND team_id = $2::uuid`,
      [taskId, teamId],
    )
  ).rows[0];
}

/**
 * The durable latch of one assignment. The job queue's dedupe only covers a job that is still waiting or running, so an event delivered a
 * second time after its run finished would start another; this row (kernel `outbox_processed`, written in the same transaction as the job) is
 * what makes "once per assignment" last. True the first time, false for every later delivery.
 */
async function firstDelivery(tx: PluginTx, key: string): Promise<boolean> {
  const row = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ('runtime-hermes:task_assigned', md5($1)::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    [key],
  );
  return row.rows.length > 0;
}

async function enqueueTaskRun(
  ctx: PluginContext,
  tx: PluginTx,
  input: {
    event: 'assigned' | 'done';
    workspaceId: string;
    teamId: string;
    bot: BotRow;
    botActorId: string;
    card: CardRow;
    fromActorId: string;
    note: string;
    dedupeKey: string;
  },
): Promise<void> {
  if (!(await firstDelivery(tx, input.dedupeKey))) return;
  const thread = await cardThread(tx, input.card, input.teamId, input.workspaceId, input.botActorId);
  if (typeof thread === 'string') {
    await notWoken(ctx, tx, { workspaceId: input.workspaceId, teamId: input.teamId, taskId: input.card.id, botId: input.bot.id, reason: thread });
    return;
  }
  const from = await actorName(tx, input.fromActorId);
  const prompt = buildTaskPrompt({
    event: input.event,
    fromName: from.name,
    channelName: thread.channelName,
    card: {
      id: input.card.id,
      title: input.card.title,
      kind: input.card.kind,
      state: input.card.state,
      description: input.card.description,
      branch: input.card.branch,
      baseSha: input.card.base_sha,
      testedSha: input.card.tested_sha,
    },
    note: input.note,
    self: { name: input.bot.name, slug: input.bot.slug },
  });
  const payload: RunPayload = {
    workspaceId: input.workspaceId,
    botId: input.bot.id,
    teamId: input.teamId,
    channelId: thread.channelId,
    trigger: 'task_assigned',
    // A person who handed the card over is the asker (reads run as them, like a mention); a bot cannot be one, so a bot's handover is a run
    // nobody asked. A finished card is nobody's request either: the creator reads as itself.
    askerActorId: input.event === 'assigned' && from.kind === 'person' ? input.fromActorId : null,
    replyRootId: thread.rootId,
    runThreadId: thread.threadKnown ? thread.rootId : null,
    prompt,
    text: `${input.note}\n${input.card.title}\n${input.card.description}`.slice(0, 40_000),
  };
  await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: input.dedupeKey });
}

/** Subscribe the two events. Called from `registerRouter`. */
export function registerTaskRouter(ctx: PluginContext): void {
  ctx.events.subscribe('tasks.task.handed_off', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TasksTaskHandedOffEvent.parse(raw);
    // A handover to oneself is not a handover (the door refuses it too); a bot never wakes itself.
    if (event.fromActorId === event.toActorId) return;
    const bot = await wakeableBot(tx, event.toActorId, event.teamId);
    if (!bot) return;
    const card = await loadCard(tx, event.taskId, event.teamId);
    // The card has moved on since the event (handed again, completed): the new owner's own event wakes them, not this one.
    if (!card || card.owner_id !== event.toActorId) return;
    await enqueueTaskRun(ctx, tx, {
      event: 'assigned',
      workspaceId: event.workspaceId,
      teamId: event.teamId,
      bot,
      botActorId: event.toActorId,
      card,
      fromActorId: event.fromActorId,
      note: event.note,
      dedupeKey: `runtime-hermes:${bot.id}:task-assigned:${event.handoffId}`,
    });
  });

  ctx.events.subscribe('tasks.task.completed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TasksTaskCompletedEvent.parse(raw);
    const card = await loadCard(tx, event.taskId, event.teamId);
    if (!card || card.state !== 'done' || card.created_by === event.actorId) return;
    const bot = await wakeableBot(tx, card.created_by, event.teamId);
    if (!bot) return;
    // At most three completion wakes of one creator an hour: a creator that makes cards which finish and make cards cannot loop for ever.
    // The lock serialises the count with the enqueue below (it is released at commit), so concurrent deliveries see each other's jobs.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`done-wake:${bot.id}`]);
    const woken = (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.jobs
          WHERE queue = $1 AND starts_with(dedupe_key, $2) AND created_at > now() - interval '1 hour'`,
        [RUN_QUEUE, `runtime-hermes:${bot.id}:task-done:`],
      )
    ).rows[0]?.n ?? 0;
    if (woken >= MAX_DONE_WAKES) {
      await notWoken(ctx, tx, { workspaceId: event.workspaceId, teamId: event.teamId, taskId: card.id, botId: bot.id, reason: 'wake_limit' });
      return;
    }
    await enqueueTaskRun(ctx, tx, {
      event: 'done',
      workspaceId: event.workspaceId,
      teamId: event.teamId,
      bot,
      botActorId: card.created_by,
      card,
      fromActorId: event.actorId,
      note: '',
      dedupeKey: `runtime-hermes:${bot.id}:task-done:${card.id}:${card.completed_ms ?? '0'}`,
    });
  });
}
