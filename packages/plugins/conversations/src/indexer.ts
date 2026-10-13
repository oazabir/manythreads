import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ChannelMessagePostedEvent } from '@manythreads/shared';

// The index of conversations (PLAN P5-16): the first message a person sends into their conversation channel with a bot is the root of a new
// conversation, and the row that says so is what the lists and the visibility of a conversation hang from. Runs in the outbox consumer's
// system transaction, one statement to decide and one to write; idempotent (the root's id is the key), so a redelivered event writes nothing
// and announces nothing twice.

/** The channel and person the message belongs to when it opens a conversation; nothing for every other message. */
interface Opening {
  workspace_id: string;
  team_id: string;
  bot_id: string;
  channel_id: string;
  person_id: string;
  [key: string]: unknown;
}

export function registerIndexer(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    // a reply is part of a conversation already; only a root opens one
    if (event.threadRootId !== null) return;
    const opening = (
      await tx.query<Opening>(
        `SELECT m.workspace_id, c.team_id, c.bot_id, c.id AS channel_id, a.ref_id AS person_id
           FROM app.messages m
           JOIN app.channels c ON c.id = m.channel_id AND c.kind = 'bot_conversation' AND c.team_id IS NOT NULL
           JOIN app.bots b ON b.id = c.bot_id AND b.workspace_id = c.workspace_id
           JOIN app.actors a ON a.id = m.author_id AND a.kind = 'person' AND a.id = c.created_by
          WHERE m.id = $1 AND m.thread_root_id IS NULL`,
        [event.messageId],
      )
    ).rows[0];
    if (!opening) return;
    const written = await tx.query<{ thread_root_id: string }>(
      `INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (thread_root_id) DO NOTHING RETURNING thread_root_id`,
      [event.messageId, opening.workspace_id, opening.team_id, opening.bot_id, opening.person_id, opening.channel_id],
    );
    if (written.rows.length === 0) return;
    await ctx.audit.emit(tx, {
      type: 'conversations.conversation.started',
      teamId: opening.team_id,
      botId: opening.bot_id,
      personId: opening.person_id,
      channelId: opening.channel_id,
      threadRootId: event.messageId,
    });
  });
}
