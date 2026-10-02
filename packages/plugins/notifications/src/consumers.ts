import type { PluginContext, PluginEvent } from '@manythreads/sdk';
import { ChannelMemberRemovedEvent, ChannelMentionCreatedEvent, ChannelMessageDeletedEvent, ChannelMessagePostedEvent } from '@manythreads/shared';
import { deliver, loadMessage } from './service.ts';

/**
 * The three event subscriptions (the plugin's outbox consumer runs them as the system actor, once per event, in one transaction
 * with the effects, so a failure rolls everything back and the event is retried):
 *
 * - `channel.mention.created`: the mentioned person gets a `mention` (the channels plugin already left out the author and people who
 *   cannot read the channel; the audience is checked again here because the event may be old).
 * - `channel.message.posted`: in a direct message the other members get a `dm`; a reply in a thread gets a `reply` for the followers of
 *   the thread; a plain channel message notifies nobody (mentions have their own event).
 * - `channel.message.deleted`: the message's notifications go, so a deleted text is not left in anyone's inbox.
 * - `channel.member.removed`: a person who can no longer read the channel (a private channel or a direct message) loses what it notified
 *   them of; leaving a channel everyone on the team can read changes nothing. (The inbox policy already hides such rows; this keeps
 *   them from being counted or kept.)
 */
export function registerConsumers(ctx: PluginContext): void {
  ctx.events.subscribe('channel.mention.created', async (raw: PluginEvent, tx) => {
    const event = ChannelMentionCreatedEvent.parse(raw);
    if (event.kind !== 'person' || event.personId === null) return;
    const message = await loadMessage(tx, event.messageId);
    if (!message || message.deleted) return;
    await deliver(ctx, tx, message, 'mention', [event.personId]);
  });

  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    const message = await loadMessage(tx, event.messageId);
    if (!message || message.deleted) return;
    if (message.channelKind === 'dm') {
      const members = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1::uuid', [message.channelId]);
      await deliver(ctx, tx, message, 'dm', members.rows.map((r) => r.person_id));
    } else if (message.channelKind === 'channel' && message.threadRootId !== null) {
      const followers = await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_follower_ids($1::uuid)', [message.threadRootId]);
      await deliver(ctx, tx, message, 'reply', followers.rows.map((r) => r.person_id));
    }
  });

  ctx.events.subscribe('channel.message.deleted', async (raw: PluginEvent, tx) => {
    const event = ChannelMessageDeletedEvent.parse(raw);
    await tx.query("DELETE FROM app.notifications WHERE ref_type = 'message' AND ref_id = $1::uuid", [event.messageId]);
  });

  ctx.events.subscribe('channel.member.removed', async (raw: PluginEvent, tx) => {
    const event = ChannelMemberRemovedEvent.parse(raw);
    const audience = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [event.channelId]);
    if (audience.rows.some((r) => r.person_id === event.personId)) return;
    await tx.query('DELETE FROM app.notifications WHERE person_id = $1::uuid AND channel_id = $2::uuid', [event.personId, event.channelId]);
  });
}
