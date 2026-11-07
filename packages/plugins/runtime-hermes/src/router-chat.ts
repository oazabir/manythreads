import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ConversationsTurnRegeneratedEvent, type BotTrigger } from '@manythreads/shared';
import { buildPrompt, matchTrigger } from './match.ts';
import { loadMessage, projectOfChannel } from './router-subscribe.ts';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

// Regenerate in the Chat screen (PLAN P20-16): a person asked for another answer to one of their own messages. The conversations plugin checked the person, the
// thread and the model, and announced it; this starts one more run for that message, exactly as the message's first run was started (same prompt, same trigger),
// with the model the person picked. The reply comes back as the next variant of the turn. Runs in the outbox's system transaction.

export function registerChatRouter(ctx: PluginContext): void {
  ctx.events.subscribe('conversations.turn.regenerated', async (raw: PluginEvent, tx: PluginTx, meta) => {
    const event = ConversationsTurnRegeneratedEvent.parse(raw);
    const message = await loadMessage(tx, event.turnMessageId);
    if (!message || message.author_kind !== 'person' || message.channel_kind !== 'bot_conversation') return;
    if (message.channel_id !== event.channelId || message.channel_bot_id !== event.botId) return;
    if (message.channel_team === null || message.channel_archived !== null) return;
    // the asker is the person who wrote the message, as in the first run
    const author = (await tx.query<{ ref_id: string }>('SELECT ref_id FROM app.actors WHERE id = $1::uuid', [message.author_id])).rows[0];
    if (author?.ref_id !== event.personId) return;
    const bot = (
      await tx.query<{ id: string; slug: string; triggers: BotTrigger[] | null }>(
        "SELECT id, slug, triggers FROM app.bots WHERE id = $1::uuid AND team_id = $2::uuid AND status = 'active'",
        [event.botId, message.channel_team],
      )
    ).rows[0];
    if (!bot) return;
    const trigger = matchTrigger(bot.triggers ?? [], bot.slug, { channelName: message.channel_name, isBotChannel: true, mentions: new Set() });
    if (trigger !== 'conversation') return;
    const project = await projectOfChannel(tx, message.channel_id);
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
      messageId: message.id,
      ...(event.modelAlias === null ? {} : { modelAlias: event.modelAlias }),
    };
    // one run per announcement: a redelivered event finds its job already queued or done
    await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:regenerate:${bot.id}:${message.id}:${meta?.eventId ?? event.turnMessageId}` });
  });
}
