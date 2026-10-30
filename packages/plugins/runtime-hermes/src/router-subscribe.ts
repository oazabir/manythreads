import {
  authorizeContext,
  type ApprovalProvider,
  type MessageProvider,
  type PluginContext,
  type PluginEvent,
  type PluginTx,
} from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  ChannelMessagePostedEvent,
  isRepoOriginAllowed,
  parseRepoOriginAllow,
  type BotTrigger,
} from '@manythreads/shared';
import { buildPrompt, matchTrigger, MAX_DELEGATION_DEPTH, mayTagSlugs, mentionedHandles, type MessageView, type ProjectNote } from './match.ts';
import { registerRhythmRouter } from './router-rhythms.ts';
import { registerTaskRouter } from './router-tasks.ts';
import { RUN_QUEUE, RunPayload } from './run-job.ts';

// Trigger routing (PLAN P5-10: "route `conversation`, `mention`, `channel_message` triggers"). One subscription on
// `channel.message.posted` decides, for every active bot of the message's team, whether one of its BOT.md triggers fired;
// the run itself happens in a job, because starting a process and talking to a model has no business in the outbox
// transaction that delivered the event.
//
// The three triggers, as this phase can honestly tell them apart:
//
//  * `conversation` — the message landed in the bot's own channel (`channels.bot_id = bot.id`, kind `bot_conversation`: the unlisted,
//    private channel the conversations plugin makes, one per bot and person, P5-16). It is the trigger a person talking to a bot fires,
//    and the only one that fires there: a bot's own conversation channel is not a place where a mention or a channel rule wakes anybody.
//  * `mention` — the body names the bot (`@<slug>`), optionally only in the channels the trigger lists.
//  * `channel_message` — a message in a channel the trigger lists (or, with no `source`, anywhere on the bot's team).
//
// What never fires a run: a private channel (a bot conversation is the one exception, and only for its own bot), a DM, an
// archived channel, and the bot's own reply, which is a message like any other. One message starts at most
// one run per bot (the job's dedupe key), and the trigger with the highest priority wins: conversation, then mention, then
// channel_message.
//
// A message a **bot** wrote fires a run only as a delegation: an explicit @mention in a public team channel, of a bot the
// author may tag (its `tasks.handoff` grant names the target), a few hops deep per thread. Everything else a bot wrote — its
// own conversation channel, a DM, a private or archived channel, a message carrying an Answer — answers nothing.

interface MessageRow {
  id: string;
  body: string;
  channel_id: string;
  thread_root_id: string | null;
  author_id: string;
  channel_name: string;
  channel_team: string | null;
  channel_private: boolean;
  channel_archived: Date | null;
  channel_bot_id: string | null;
  channel_kind: string;
  author_kind: string;
  author_name: string;
  /** The message carries an Answer (`meta.answer`): a person's masked copy of one (P5-17), never something typed. */
  carries_answer: boolean;
  /** The message announces a card handover (`meta.handoff`, written by the tasks plugin): it starts no run. */
  is_handoff_card: boolean;
  is_channel_copy: boolean;
  [key: string]: unknown;
}

interface BotRow {
  id: string;
  slug: string;
  runtime: string;
  triggers: BotTrigger[] | null;
  [key: string]: unknown;
}

/** The project the channel is tied to, if any (the projects plugin's table; read in the outbox's system transaction). */
async function projectOfChannel(tx: PluginTx, channelId: string): Promise<ProjectNote | null> {
  const row = (
    await tx.query<{ name: string; repo_url: string; default_branch: string }>(
      'SELECT name, repo_url, default_branch FROM app.projects WHERE channel_id = $1::uuid',
      [channelId],
    )
  ).rows[0];
  if (!row) return null;
  // the same allowlist the pod controller applies (the server's own setting), so the note never promises a copy the pod does not hold
  const allow = parseRepoOriginAllow(process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
  return { name: row.name, repoUrl: row.repo_url, defaultBranch: row.default_branch, cloned: isRepoOriginAllowed(row.repo_url, allow) };
}

/** Did the bot page's Test action file this message as its rehearsal question (bots migration 0018)? */
async function isRehearsalQuestion(tx: PluginTx, messageId: string): Promise<boolean> {
  const res = await tx.query('SELECT 1 FROM app.rehearsal_questions WHERE message_id = $1::uuid', [messageId]);
  return res.rows.length > 0;
}

/** The one subscription: decide, then enqueue one run per bot that the message fires. Runs in the outbox's system transaction. */
export function registerRouter(ctx: PluginContext): void {
  registerTaskRouter(ctx);
  registerRhythmRouter(ctx);
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    const message = (
      await tx.query<MessageRow>(
        `SELECT m.id, m.body, m.channel_id, m.thread_root_id, m.author_id,
                c.name AS channel_name, c.team_id AS channel_team, c.private AS channel_private,
                c.archived_at AS channel_archived, c.bot_id AS channel_bot_id, c.kind AS channel_kind,
                a.kind AS author_kind, coalesce(p.display_name, b.name, 'someone') AS author_name,
                (m.meta ? 'answer') AS carries_answer, (m.meta ? 'handoff') AS is_handoff_card, (m.meta ? 'alsoSentFrom') AS is_channel_copy
           FROM app.messages m
           JOIN app.channels c ON c.id = m.channel_id
           JOIN app.actors a ON a.id = m.author_id
           LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
           LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
          WHERE m.id = $1`,
        [event.messageId],
      )
    ).rows[0];
    if (!message) return;
    // The announcement a handover posts ("Orchestrator → @coder: ...") carries `meta.handoff`, set only by the tasks plugin through the message
    // door. It is not a request of its own: the assignment's event (router-tasks.ts) wakes the new owner, so this message starts nothing,
    // whoever wrote it.
    if (message.is_handoff_card) return;
    // "Also send to channel" posts the reply a second time as a message of the channel (`meta.alsoSentFrom`, set by the channels plugin only).
    // The reply in the thread already woke whoever it names; the copy is the same words, so it wakes nobody a second time.
    if (message.is_channel_copy) return;
    // A bot answering a bot is a delegation (below): an explicit @mention in a public team channel, mayTag-gated and
    // depth-capped. Anything else that is not a person — a gone author included — starts nothing.
    if (message.author_kind === 'bot') {
      await routeDelegation(ctx, tx, event.workspaceId, message);
      return;
    }
    if (message.author_kind !== 'person') return;
    // A person's message that carries an Answer is a shared copy, made by the platform from a bot's text: whatever it names (an `@bot` a
    // prompt-injected source planted in the answer) is not the sharer asking for anything, so no trigger fires for it.
    if (message.carries_answer) return;
    // A bot conversation is the one private channel a bot runs from, and then only its own bot (a DM, a private team channel and every
    // other bot's conversation stay out): the channel says who it is with, the bot's team is the channel's team.
    const conversation = message.channel_kind === 'bot_conversation';
    if (message.channel_team === null || message.channel_archived !== null) return;
    if (message.channel_private && !conversation) return;
    if (conversation && message.channel_bot_id === null) return;

    const view: MessageView = {
      channelName: message.channel_name,
      isBotChannel: false,
      mentions: conversation ? new Set() : mentionedHandles(message.body),
    };
    const bots = (
      await tx.query<BotRow>(
        `SELECT id, slug, runtime, triggers FROM app.bots
          WHERE team_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2::uuid) ORDER BY slug`,
        [message.channel_team, conversation ? message.channel_bot_id : null],
      )
    ).rows;
    const project = await projectOfChannel(tx, message.channel_id);
    // A question the bot page's Test action filed is a rehearsal (the row is written by the Test route in the transaction that posted the message,
    // so it is there before this event is delivered). Only a bot conversation has one.
    const rehearsal = conversation && (await isRehearsalQuestion(tx, message.id));
    for (const bot of bots) {
      const trigger = matchTrigger(bot.triggers ?? [], bot.slug, {
        ...view,
        isBotChannel: message.channel_bot_id === bot.id,
      });
      if (trigger === null) continue;
      const payload: RunPayload = {
        workspaceId: event.workspaceId,
        botId: bot.id,
        teamId: message.channel_team,
        channelId: message.channel_id,
        trigger,
        askerActorId: message.author_id,
        replyRootId: message.thread_root_id ?? message.id,
        runThreadId: message.thread_root_id,
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body, project }),
        text: message.body.slice(0, 40_000),
        ...(rehearsal && trigger === 'conversation' ? { rehearsal: true as const } : {}),
      };
      await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:${message.id}` });
    }
  });
}

/**
 * One bot handing work to another in a public team channel: the author's message names the target with an @mention and the
 * target answers in the same thread, so the thread's readers never change. Runs in the outbox's system transaction, like the
 * person path above.
 *
 * Three locks, all read from the database, none from the message:
 *
 *  1. **Explicit mention only.** A bot's prose never trips another bot's `channel_message` rule — that way every bot with one
 *     would answer every bot message on the team. The mention is read with the composer's own parser, so a handle inside a
 *     code span, a fence, a URL or an email names nobody here either.
 *  2. **The author's handover allowlist.** The bots loader compiles `handover.mayTag` into the author's `tasks.handoff`
 *     grant (`constraints: { mayTag: [...] }`); a target it does not name is not woken. No grant, no names, no handoff.
 *  3. **A shallow chain per thread.** Every hop answers in the same thread, so the deepest run hanging off the thread's root
 *     is the chain's length; past `MAX_DELEGATION_DEPTH` the mention wakes nobody and one line in the thread says so.
 *
 * The run has no person asker (`runs.open` refuses a bot as asker): it is a run nobody asked, so reads run as the bot and an
 * approval it raises names the bot itself as the requester. The author's own run already answered the person; this one only
 * does the named work.
 */
async function routeDelegation(ctx: PluginContext, tx: PluginTx, workspaceId: string, message: MessageRow): Promise<void> {
  // A person's masked copy of an Answer can name a bot a planted source chose: never a handoff (the person path agrees).
  if (message.carries_answer) return;
  // Team channels only: a bot conversation is one person's private thread, a DM or private channel is no bot's to read into,
  // and an archived channel takes nothing.
  if (message.channel_kind !== 'channel' || message.channel_private || message.channel_archived !== null || message.channel_team === null) {
    return;
  }
  // The authoring bot, on this team, still active: a disabled bot hands nothing off, and a bot never wakes itself.
  const author = (
    await tx.query<{ id: string; slug: string }>(
      `SELECT b.id, b.slug FROM app.actors a JOIN app.bots b ON b.id = a.ref_id
        WHERE a.id = $1 AND a.kind = 'bot' AND b.team_id = $2 AND b.status = 'active'`,
      [message.author_id, message.channel_team],
    )
  ).rows[0];
  if (!author) return;
  const grant = (
    await tx.query<{ constraints: unknown }>(
      `SELECT constraints FROM app.capability_grants WHERE actor_id = $1 AND capability = 'tasks.handoff'`,
      [message.author_id],
    )
  ).rows[0];
  const mayTag = mayTagSlugs(grant?.constraints);
  if (mayTag.size === 0) return;
  const mentions = mentionedHandles(message.body);
  if (mentions.size === 0) return;
  const replyRootId = message.thread_root_id ?? message.id;
  const deepest = (
    await tx.query<{ max: number }>(
      `SELECT COALESCE(MAX(delegation_depth), 0)::int AS max FROM app.bot_runs WHERE reply_root_id = $1::uuid AND delegation_depth > 0 AND trigger_type <> 'task_assigned'`,
      [replyRootId],
    )
  ).rows[0];
  const depth = (deepest?.max ?? 0) + 1;
  const bots = (
    await tx.query<BotRow>(
      `SELECT id, slug, runtime, triggers FROM app.bots WHERE team_id = $1 AND status = 'active' AND id <> $2 ORDER BY slug`,
      [message.channel_team, author.id],
    )
  ).rows;
  const view: MessageView = { channelName: message.channel_name, isBotChannel: false, mentions };
  const project = await projectOfChannel(tx, message.channel_id);
  for (const bot of bots) {
    if (!mayTag.has(bot.slug.toLowerCase())) continue;
    if (matchTrigger(bot.triggers ?? [], bot.slug, view) !== 'mention') continue;
    // Past the cap the mention wakes nobody, but it must not vanish: one line in the thread says why (once per message and target).
    if (depth > MAX_DELEGATION_DEPTH) {
      await noteDepthCap(ctx, tx, { author, targetSlug: bot.slug, message, replyRootId, workspaceId });
      continue;
    }
    // The bot is already working this thread from a card handed to it: the handover woke it and its run has not ended, so the prose
    // mention would only start the same work a second time.
    if (await alreadyOnThread(tx, bot.id, replyRootId)) continue;
    await ctx.jobs.enqueue(
      tx,
      RUN_QUEUE,
      {
        workspaceId,
        botId: bot.id,
        teamId: message.channel_team,
        channelId: message.channel_id,
        trigger: 'mention',
        askerActorId: null,
        replyRootId,
        runThreadId: message.thread_root_id,
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body, project }),
        text: message.body.slice(0, 40_000),
        delegation: { fromBotId: author.id, depth },
      } satisfies RunPayload,
      { dedupeKey: `runtime-hermes:${bot.id}:${message.id}` },
    );
  }
}

/**
 * Is this bot already busy with the thread because a handover put it there? True only when BOTH hold: it owns an unfinished task card whose
 * thread is this one (the handover woke it), and it has a run for the thread that is queued or running right now (the run the handover
 * started, which is still doing that work). Then a prose @mention is redundant and starts nothing.
 *
 * Either half alone is not enough. A card owner whose run has ended is idle, so the mention is the only thing that can wake it (the live
 * run that stalled had exactly this: the deployer owned the card but was idle). And a bot with a live run but no card here was woken by an
 * earlier mention, so a new mention may carry a new instruction and gets its own run afterwards. Queued means a ready or running job on the run
 * queue for this bot and thread; running means a `bot_runs` row of the bot for the thread with no `ended_at`.
 * (`routeDelegation` runs in the outbox's system transaction.)
 */
async function alreadyOnThread(tx: PluginTx, botId: string, replyRootId: string): Promise<boolean> {
  const owns = await tx.query(
    `SELECT 1 FROM app.tasks t JOIN app.actors a ON a.id = t.owner_id AND a.kind = 'bot'
      WHERE a.ref_id = $1::uuid AND t.thread_root_id = $2::uuid AND t.state <> 'done' LIMIT 1`,
    [botId, replyRootId],
  );
  if (owns.rows.length === 0) return false;
  const live = await tx.query(
    `SELECT 1 FROM app.bot_runs WHERE bot_id = $1::uuid AND reply_root_id = $2::uuid AND ended_at IS NULL AND status = 'running'
        AND started_at > now() - interval '2 hours'
     UNION ALL
     SELECT 1 FROM app.jobs WHERE queue = $3 AND state IN ('ready', 'running')
        AND payload ->> 'botId' = $1::text AND payload ->> 'replyRootId' = $2::text
      LIMIT 1`,
    [botId, replyRootId, RUN_QUEUE],
  );
  return live.rows.length > 0;
}

/**
 * Says, once, that a bot's mention did not wake its target because the bot-to-bot chain hit its depth limit. The line is written as the
 * mention's author (a notice needs a real author: the platform's system actor owns no message), through the message door, in the same
 * thread. The mention is put in a code span so the notice names nobody to the routers (it would otherwise be a delegation of its own).
 * Once per (thread, target, message): a durable latch (`outbox_processed`) is taken first, so a replayed event posts nothing. Never throws:
 * a notice that cannot be posted must not fail the routing of the message.
 */
async function noteDepthCap(
  ctx: PluginContext,
  tx: PluginTx,
  input: { author: { id: string; slug: string }; targetSlug: string; message: MessageRow; replyRootId: string; workspaceId: string },
): Promise<void> {
  const { author, targetSlug, message, replyRootId } = input;
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages || message.channel_team === null) return;
  const first = await tx.query(
    `INSERT INTO app.outbox_processed (subscriber, event_id) VALUES ('runtime-hermes:depth_cap', md5($1)::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    [`${replyRootId}:${targetSlug.toLowerCase()}:${message.id}`],
  );
  if (first.rows.length === 0) return;
  const body = `\`@${targetSlug}\` was not woken by that mention: the bot-to-bot chain in this thread has reached its limit of ${String(MAX_DELEGATION_DEPTH)}. A person's mention or a card handover will wake it.`;
  try {
    // The author's own run is usually still open (it wrote the mention a moment ago); when it has ended, a run opened only for this line.
    let run = await ctx.runs.openRunOf(author.id);
    let opened = false;
    if (!run) {
      run = (
        await ctx.runs.open({
          botId: author.id,
          teamId: message.channel_team,
          workspaceId: input.workspaceId,
          trigger: 'mention',
          channelId: message.channel_id,
          replyRootId,
          delegationDepth: 0,
        })
      ).run;
      opened = true;
    }
    const live = run;
    try {
      const decision = await ctx.runs.authorize(live, 'messages.post', authorizeContext({ channelId: message.channel_id, body, threadRootId: replyRootId }));
      if (!decision.allowed || decision.needsApproval) return;
      await ctx.runs.asBot(live, (inner) => messages.post(inner, { channelId: message.channel_id, body, threadRootId: replyRootId }));
    } finally {
      if (opened) await ctx.runs.close(live.runId, 'done');
    }
  } catch (err) {
    console.warn(`runtime-hermes: depth-cap notice for ${targetSlug} not posted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Takes a held model call back once a person approves it: the `approvals.approval.decided` event (an outbox consumer, so a system transaction)
 * claims the stored payload — once; a replayed event gets nothing — and puts the run on its queue again with the approval's id, which makes
 * the next pre-call check let that one finding through as written.
 */
export function registerApprovalResume(ctx: PluginContext): void {
  ctx.events.subscribe('approvals.approval.decided', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ApprovalsApprovalDecidedEvent.parse(raw);
    if (event.decision !== 'approved' || event.source !== 'dlp' || event.botId === null) return;
    const approvals = ctx.providers.get<ApprovalProvider>('approvals');
    if (!approvals) return;
    const payload = await approvals.claim(tx, event.approvalId, { botId: event.botId, source: 'dlp' });
    if (!payload) return;
    // A gate hold resumes past the gate only; a DLP hold resumes past the DLP check only. The two are different questions a person answered.
    const { gateHold, ...rest } = payload;
    const parsed = RunPayload.safeParse(gateHold === true ? { ...rest, gateApprovalId: event.approvalId } : { ...rest, approvalId: event.approvalId });
    if (!parsed.success) return;
    await ctx.jobs.enqueue(tx, RUN_QUEUE, parsed.data, { dedupeKey: `runtime-hermes:approval:${event.approvalId}` });
  });
}
