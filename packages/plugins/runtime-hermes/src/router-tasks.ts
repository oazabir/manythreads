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
// and the chain engineer → coder → code-reviewer → tester → … is bounded by the tasks door that counts hand-overs (`handoff_count`, thirty).
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
    /** The handover that woke the bot (assigned) carried a private note. */
    privateNote?: boolean;
  },
): Promise<void> {
  if (!(await firstDelivery(tx, input.dedupeKey))) return;
  const thread = await cardThread(tx, input.card, input.teamId, input.workspaceId, input.botActorId);
  if (typeof thread === 'string') {
    await notWoken(ctx, tx, { workspaceId: input.workspaceId, teamId: input.teamId, taskId: input.card.id, botId: input.bot.id, reason: thread });
    return;
  }
  const from = await actorName(tx, input.fromActorId);
  // Only whether secrets exist is read here (the id column, never the text): the prompt tells the bot where to fetch them, or to stay quiet.
  const privateSecretsOnCard =
    input.event === 'done' &&
    (await tx.query(`SELECT 1 FROM app.handoffs WHERE task_id = $1::uuid AND private_note_secret_id IS NOT NULL LIMIT 1`, [input.card.id])).rows.length > 0;
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
    privateNote: input.privateNote === true,
    privateSecretsOnCard,
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
    taskId: input.card.id,
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
    const privateNote = (await tx.query(`SELECT 1 FROM app.handoffs WHERE id = $1::uuid AND private_note_secret_id IS NOT NULL`, [event.handoffId])).rows.length > 0;
    await enqueueTaskRun(ctx, tx, {
      event: 'assigned',
      privateNote,
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

// ---- stalled cards (P31-03, item 10 proof 2026-11-21/22) -----------------------------------------------------------------------------------
//
// A hand-off wakes the new owner once. When that run fails (the Codex Coder ran out of its budget waiting on a test suite) or never starts (a wake
// lost while the server restarted), nothing woke the card again and the chain sat idle for hours. The sweep below, every five minutes, finds a card
// a bot owns that has not changed for STALL_MINUTES, where since its last hand-off the owner's last run on it (or in its thread) failed, ended without handing it on, or there was none, nothing of
// it is running or queued there, and no approval it filed is waiting (a card held for a person stays held). It starts the owner again with a note saying
// so, at most MAX_RESUMES times per hand-off: the latches are `outbox_processed` rows keyed by the hand-off and the try, like a first wake. After
// that the card is left and its history says why (`runtime.task.not_woken`, `wake_limit`). A run that stopped (an approval it waits on, a person, a budget or rate limit) is not resumed.

export const RESUME_QUEUE = 'runtime-hermes.resume-stalled';
const STALL_MINUTES = 15;
const MAX_RESUMES = 2;
/** A hand-off older than this is left alone: the sweep is for a delivery that is moving, not for an old card somebody forgot. */
const RESUME_WINDOW_HOURS = 48;

export const RESUME_NOTE =
  'Your previous run on this card ended while the card was still yours (it failed, ran out of time, never started, or ended without a hand-off). Read the card and the thread, check what is already done on the branch, continue from there and hand the card over as your steps say.';

interface StalledRow {
  task_id: string;
  team_id: string;
  workspace_id: string;
  owner_id: string;
  handoff_id: string;
  from_actor_id: string;
  note: string;
  [key: string]: unknown;
}

const latchTaken = async (tx: PluginTx, key: string): Promise<boolean> =>
  (await tx.query(`SELECT 1 FROM app.outbox_processed WHERE subscriber = 'runtime-hermes:task_assigned' AND event_id = md5($1)::uuid`, [key])).rows.length > 0;

/** Wake one stalled card's owner again, or note that every try was used. True when a run was queued. */
async function resumeOne(ctx: PluginContext, tx: PluginTx, row: StalledRow): Promise<boolean> {
  const bot = await wakeableBot(tx, row.owner_id, row.team_id);
  if (!bot) return false;
  const card = await loadCard(tx, row.task_id, row.team_id);
  if (!card || card.owner_id !== row.owner_id) return false;
  let attempt = 0;
  for (let n = 1; n <= MAX_RESUMES; n += 1) {
    if (!(await latchTaken(tx, `runtime-hermes:${bot.id}:task-resume:${row.handoff_id}:${n}`))) {
      attempt = n;
      break;
    }
  }
  if (attempt === 0) {
    // every try was used: say so once on the card's history and leave it for a person
    if (await firstDelivery(tx, `runtime-hermes:${bot.id}:task-resume:${row.handoff_id}:gave-up`)) {
      await notWoken(ctx, tx, { workspaceId: row.workspace_id, teamId: row.team_id, taskId: row.task_id, botId: bot.id, reason: 'wake_limit' });
    }
    return false;
  }
  await enqueueTaskRun(ctx, tx, {
    event: 'assigned',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    bot,
    botActorId: row.owner_id,
    card,
    fromActorId: row.from_actor_id,
    note: `${RESUME_NOTE}\n\nThe hand-off note was:\n${row.note}`,
    dedupeKey: `runtime-hermes:${bot.id}:task-resume:${row.handoff_id}:${attempt}`,
  });
  return true;
}

/** Wake the owners of stalled cards again. Returns how many runs were queued. */
export async function resumeStalledCards(ctx: PluginContext, tx: PluginTx, now: Date): Promise<number> {
  const stalled = (
    await tx.query<StalledRow>(
      `WITH last_handoff AS (
         SELECT DISTINCT ON (h.task_id) h.task_id, h.id, h.from_actor_id, h.to_actor_id, h.note, h.applied_at
           FROM app.handoffs h
          WHERE h.applied_at IS NOT NULL AND h.applied_at > $1::timestamptz - make_interval(hours => $3)
          ORDER BY h.task_id, h.applied_at DESC, h.id DESC
       )
       SELECT t.id AS task_id, t.team_id, t.workspace_id, t.owner_id, lh.id AS handoff_id, lh.from_actor_id, lh.note
         FROM app.tasks t
         JOIN last_handoff lh ON lh.task_id = t.id AND lh.to_actor_id = t.owner_id
         JOIN app.actors a ON a.id = t.owner_id AND a.kind = 'bot'
         -- only a bot that can be woken (the same rule as a hand-off), so a card that cannot be helped never fills the batch
         JOIN app.bots b ON b.id = a.ref_id AND b.team_id = t.team_id AND b.status = 'active'
                        AND jsonb_path_exists(b.triggers, '$[*] ? (@.type == "task_assigned")')
        WHERE t.state IN ('open', 'in_progress', 'verify')
          AND t.thread_root_id IS NOT NULL
          AND t.updated_at < $1::timestamptz - make_interval(mins => $2)
          -- every try used: the card is left for a person (its history says so), and it never comes back in the batch
          AND NOT EXISTS (SELECT 1 FROM app.outbox_processed o WHERE o.subscriber = 'runtime-hermes:task_assigned'
                            AND o.event_id = md5('runtime-hermes:' || b.id::text || ':task-resume:' || lh.id::text || ':gave-up')::uuid)
          -- nothing of the owner is running or queued on this card or in its thread (an answered approval or a person's @mention wakes it there
          -- without the card's id)
          AND NOT EXISTS (SELECT 1 FROM app.bot_runs r WHERE r.ended_at IS NULL AND (r.task_id = t.id OR (r.bot_id = b.id AND r.reply_root_id = t.thread_root_id)))
          AND NOT EXISTS (SELECT 1 FROM app.jobs j WHERE j.queue = $4 AND j.state IN ('ready', 'running')
                            AND (j.payload ->> 'taskId' = t.id::text OR (j.payload ->> 'botId' = b.id::text AND j.payload ->> 'replyRootId' = t.thread_root_id::text)))
          AND NOT EXISTS (SELECT 1 FROM app.approvals p WHERE p.status = 'pending' AND p.bot_id = b.id AND p.created_at >= lh.applied_at)
          -- a card with an open pull request waits for a person to merge it
          AND t.pull_request_state IS DISTINCT FROM 'open'
          -- the owner's last run on the card (or in its thread) since the hand-off failed, ended without handing the card on, or there was none.
          -- A run that stopped (it waits on an approval, a person stopped it, a budget or a rate limit refused it) is not a stall: waking it again
          -- would not help.
          AND COALESCE((
                SELECT r.status IN ('failed', 'done')
                  FROM app.bot_runs r
                 WHERE r.bot_id = b.id AND (r.task_id = t.id OR r.reply_root_id = t.thread_root_id) AND r.started_at >= lh.applied_at AND NOT r.rehearsal
                 ORDER BY r.started_at DESC, r.id DESC LIMIT 1
              ), true)
        ORDER BY t.updated_at
        LIMIT 20`,
      [now.toISOString(), STALL_MINUTES, RESUME_WINDOW_HOURS, RUN_QUEUE],
    )
  ).rows;
  let queued = 0;
  // Each card is woken in a transaction of its own workspace: the thread check (`app.channel_actor_can_post`) reads the workspace from the
  // transaction, and the cron job's own has none (the event that wakes a hand-off carries it).
  for (const row of stalled) {
    if (await ctx.db.system((own) => resumeOne(ctx, own, row), { workspaceId: row.workspace_id })) queued += 1;
  }
  return queued;
}

export function registerStalledCardSweep(ctx: PluginContext): void {
  ctx.jobs.register(
    RESUME_QUEUE,
    async (_payload, tx, job) => {
      const n = await resumeStalledCards(ctx, tx, new Date());
      if (n > 0) job.log.info(`runtime-hermes: woke the owners of ${n} stalled card(s) again`);
    },
    { cron: '*/5 * * * *' },
  );
}
