import {
  type ApprovalProvider,
  type PluginContext,
  type PluginEvent,
  type PluginTx,
} from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  ChannelMessagePostedEvent,
  type BotTrigger,
} from '@manythreads/shared';
import { buildPrompt, matchTrigger, MAX_DELEGATION_DEPTH, mayTagSlugs, mentionedHandles, type MessageView } from './match.ts';
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
  [key: string]: unknown;
}

interface BotRow {
  id: string;
  slug: string;
  runtime: string;
  triggers: BotTrigger[] | null;
  [key: string]: unknown;
}

/** The one subscription: decide, then enqueue one run per bot that the message fires. Runs in the outbox's system transaction. */
export function registerRouter(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    const message = (
      await tx.query<MessageRow>(
        `SELECT m.id, m.body, m.channel_id, m.thread_root_id, m.author_id,
                c.name AS channel_name, c.team_id AS channel_team, c.private AS channel_private,
                c.archived_at AS channel_archived, c.bot_id AS channel_bot_id, c.kind AS channel_kind,
                a.kind AS author_kind, coalesce(p.display_name, b.name, 'someone') AS author_name,
                (m.meta ? 'answer') AS carries_answer
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
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body }),
        text: message.body.slice(0, 40_000),
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
 *     is the chain's length; past `MAX_DELEGATION_DEPTH` the mention is an ordinary message.
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
      `SELECT COALESCE(MAX(delegation_depth), 0)::int AS max FROM app.bot_runs WHERE reply_root_id = $1::uuid AND delegation_depth > 0`,
      [replyRootId],
    )
  ).rows[0];
  const depth = (deepest?.max ?? 0) + 1;
  if (depth > MAX_DELEGATION_DEPTH) return;
  const bots = (
    await tx.query<BotRow>(
      `SELECT id, slug, runtime, triggers FROM app.bots WHERE team_id = $1 AND status = 'active' AND id <> $2 ORDER BY slug`,
      [message.channel_team, author.id],
    )
  ).rows;
  const view: MessageView = { channelName: message.channel_name, isBotChannel: false, mentions };
  for (const bot of bots) {
    if (!mayTag.has(bot.slug.toLowerCase())) continue;
    if (matchTrigger(bot.triggers ?? [], bot.slug, view) !== 'mention') continue;
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
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body }),
        text: message.body.slice(0, 40_000),
        delegation: { fromBotId: author.id, depth },
      } satisfies RunPayload,
      { dedupeKey: `runtime-hermes:${bot.id}:${message.id}` },
    );
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
