import {
  ListPinsResponse,
  MAX_CHANNEL_PINS,
  type MessagePinChangedPush,
  PinMessagePathParams,
  PinMessageResponse,
  PinsPathParams,
  listPinsRoute,
  pinMessageRoute,
  unpinMessageRoute,
} from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';
import { conflict, json, notFound, route } from './http.ts';
import { pollsFor } from './poll-views.ts';
import { MESSAGE_COLUMNS, toChannelMessage, type MessageWithThreadRow } from './rows.ts';
import {
  attachmentsFor,
  audience,
  authorsFor,
  findChannelMessage,
  forwardsFor,
  lockChannel,
  pinsFor,
  pushPinChanged,
  reactionsFor,
  requireChannel,
  requirePost,
  withPin,
  type Deps,
} from './service.ts';

/**
 * Pinned messages (PLAN P31-07): pin and unpin a message, and the channel's pinned list. Whoever can read the channel reads the list; whoever can post in it
 * pins and unpins (the same people who keep the bookmarks bar; the table's policies say so too, migration 0020). Each real change is one
 * `channel.message.pin_changed` event and one `message.pin_changed` push to the channel's readers, so the row's mark and an open list follow in every tab.
 */
export function registerPinRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...listPinsRoute,
    schema: { response: ListPinsResponse },
    handler: route(async (req, tx) => {
      const { channelId } = PinsPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const res = await tx.query<MessageWithThreadRow>(
        `SELECT ${MESSAGE_COLUMNS}, t.reply_count, t.last_reply_at
           FROM app.message_pins p
           JOIN app.messages m ON m.id = p.message_id
           LEFT JOIN app.threads t ON t.root_message_id = m.id
          WHERE p.channel_id = $1 AND m.deleted_at IS NULL
          ORDER BY p.pinned_at DESC, p.message_id DESC LIMIT $2`,
        [channelId, MAX_CHANNEL_PINS],
      );
      const rows = res.rows;
      const ids = rows.map((r) => r.id);
      const reactions = await reactionsFor(tx, ids);
      const attachments = await attachmentsFor(tx, rows);
      const authors = await authorsFor(tx, ids);
      const forwards = await forwardsFor(tx, rows);
      const polls = await pollsFor(tx, rows);
      const pins = await pinsFor(tx, ids);
      return json(
        ListPinsResponse.parse({
          items: rows.map((r) => withPin(toChannelMessage(r, reactions.get(r.id) ?? [], attachments.get(r.id) ?? [], authors.get(r.author_id), forwards.get(r.id), polls.get(r.id)), pins.get(r.id))),
        }),
      );
    }),
  });

  /** Pins (`add`) or unpins one message; `changed` is false when it already was so. */
  async function setPin(tx: PluginTx, channelId: string, messageId: string, add: boolean): Promise<PinMessageResponse> {
    const channel = await requireChannel(tx, channelId);
    const message = await findChannelMessage(tx, channelId, messageId);
    if (!message) throw notFound('No such message');
    if (add && message.deletedAt) throw conflict('That message was deleted');
    await requirePost(tx, channel);
    // one pin change per channel at a time (held to the end of this transaction): under READ COMMITTED two pins at 99 would each count only their own
    // insert and both pass the cap; with the lock the second one counts after the first has committed
    if (add) await lockChannel(tx, 'pins', channelId);
    const res = add
      ? await tx.query<{ pinned_by: string | null; pinned_at: Date }>(
          `INSERT INTO app.message_pins (message_id, workspace_id, channel_id, pinned_by)
           VALUES ($1, app.workspace_id(), $2, app.actor()) ON CONFLICT (message_id) DO NOTHING RETURNING pinned_by, pinned_at`,
          [messageId, channelId],
        )
      : await tx.query<{ pinned_by: string | null; pinned_at: Date }>('DELETE FROM app.message_pins WHERE message_id = $1 AND channel_id = $2 RETURNING pinned_by, pinned_at', [messageId, channelId]);
    const changed = res.rows.length > 0;
    if (!changed) return { pinned: add, changed };
    if (add) {
      // counted under the channel's lock, after the insert (a refusal rolls this insert back)
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_pins WHERE channel_id = $1', [channelId])).rows[0]?.n ?? 0;
      if (n > MAX_CHANNEL_PINS) throw conflict(`A channel keeps at most ${MAX_CHANNEL_PINS} pinned messages. Unpin one first.`);
    }
    await ctx.audit.emit(tx, {
      type: 'channel.message.pin_changed',
      channelId,
      teamId: channel.team_id,
      messageId,
      threadRootId: message.threadRootId,
      actorId: tx.actor.id,
      pinned: add,
    });
    const row = res.rows[0]!;
    await pushPinChanged(deps, tx, await audience(tx, channelId), {
      channelId,
      messageId,
      threadRootId: message.threadRootId,
      pinned: add ? { by: row.pinned_by, at: row.pinned_at.toISOString() } : null,
    } as MessagePinChangedPush);
    return { pinned: add, changed };
  }

  ctx.http.route({
    ...pinMessageRoute,
    schema: { response: PinMessageResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = PinMessagePathParams.parse(req.params);
      return json(PinMessageResponse.parse(await setPin(tx, channelId, messageId, true)));
    }),
  });

  ctx.http.route({
    ...unpinMessageRoute,
    schema: { response: PinMessageResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = PinMessagePathParams.parse(req.params);
      return json(PinMessageResponse.parse(await setPin(tx, channelId, messageId, false)));
    }),
  });
}
