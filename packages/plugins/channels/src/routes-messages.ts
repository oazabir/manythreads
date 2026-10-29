import {
  ChannelPathParams,
  ClearMessageVersionsResponse,
  ForwardMessageRequest,
  ForwardMessageResponse,
  ListMessageVersionsResponse,
  MarkMessageUnreadResponse,
  markMessageUnreadRoute,
  clearMessageVersionsRoute,
  forwardMessageRoute,
  listMessageVersionsRoute,
  DeleteMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  GetMessageResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  MessageDeletedPush,
  MessagePathParams,
  PostMessageRequest,
  PostMessageResponse,
  ReactRequest,
  ReactResponse,
  ReactionChangedPush,
  UnreactPathParams,
  UnreactResponse,
  deleteMessageRoute,
  editMessageRoute,
  getMessageRoute,
  listMessagesRoute,
  postMessageRoute,
  reactRoute,
  unreactRoute,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import {
  MESSAGE_COLUMNS,
  toChannelMessage,
  toMessage,
  type MessageWithThreadRow,
} from './rows.ts';
import {
  attachmentsFor,
  authorsFor,
  forwardsFor,
  myPersonId,
  audience,
  can,
  findChannelMessage,
  pushMessageDeleted,
  pushReaction,
  reactionsFor,
  editChannelMessage,
  postChannelMessage,
  requireChannel,
  requirePost,
  type Deps,
} from './service.ts';

export function registerMessageRoutes(deps: Deps): void {
  const { ctx } = deps;
  const emit = ctx.audit.emit;

  ctx.http.route({
    ...postMessageRoute,
    schema: { body: PostMessageRequest, response: PostMessageResponse },
    rateLimit: { limit: 300, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const body = PostMessageRequest.parse(req.body);
      if (body.channelId !== channelId) throw invalid('channelId: must match the channel in the path');
      if (body.alsoToChannel && !body.threadRootId) throw invalid('alsoToChannel: only a reply in a thread can also be sent to the channel');
      if (body.alsoToChannel && (await requireChannel(tx, channelId)).kind === 'bot_conversation') {
        throw invalid('alsoToChannel: a conversation with a bot has no channel to send to');
      }
      // The write itself is `postChannelMessage` (service.ts) — the same call the `messages.post` capability makes, so a bot's reply
      // in a thread is posted by exactly the code a person's message is.
      const posted = await postChannelMessage(deps, tx, {
        channelId,
        body: body.body,
        threadRootId: body.threadRootId ?? null,
        attachmentIds: body.attachments ?? [],
      });
      // "Also send to channel": the same text once more as a message of the channel, marked with the thread it came from
      if (body.alsoToChannel && body.threadRootId) {
        await postChannelMessage(deps, tx, {
          channelId,
          body: body.body,
          threadRootId: null,
          attachmentIds: body.attachments ?? [],
          meta: { alsoSentFrom: { threadRootId: body.threadRootId, replyId: posted.id } },
          skipRefs: true,
        });
      }
      return json(PostMessageResponse.parse(toMessage(posted.row)), 201);
    }),
  });

  ctx.http.route({
    ...listMessagesRoute,
    schema: { query: ListMessagesQuery, response: ListMessagesResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const q = ListMessagesQuery.parse(req.query);
      await requireChannel(tx, channelId);
      // Channel feed: top-level messages (a deleted one stays only while it holds a thread); thread: its live replies. Newest first.
      const res = await tx.query<MessageWithThreadRow>(
        `SELECT ${MESSAGE_COLUMNS}, t.reply_count, t.last_reply_at
           FROM app.messages m LEFT JOIN app.threads t ON t.root_message_id = m.id
          WHERE m.channel_id = $1 AND ($2::uuid IS NULL OR m.id < $2)
            AND (CASE WHEN $3::uuid IS NULL THEN m.thread_root_id IS NULL AND (m.deleted_at IS NULL OR coalesce(t.reply_count, 0) > 0)
                      ELSE m.thread_root_id = $3 AND m.deleted_at IS NULL END)
          ORDER BY m.id DESC LIMIT $4`,
        [channelId, q.before ?? null, q.threadRootId ?? null, q.limit + 1],
      );
      const more = res.rows.length > q.limit;
      const page = more ? res.rows.slice(0, q.limit) : res.rows;
      const reactions = await reactionsFor(tx, page.map((r) => r.id));
      const attachments = await attachmentsFor(tx, page);
      const authors = await authorsFor(tx, page.map((r) => r.id));
      const forwards = await forwardsFor(tx, page);
      const oldest = page[page.length - 1];
      return json(
        ListMessagesResponse.parse({
          items: page.map((r) => toChannelMessage(r, reactions.get(r.id) ?? [], attachments.get(r.id) ?? [], authors.get(r.author_id), forwards.get(r.id))),
          nextCursor: more && oldest ? oldest.id : null,
        }),
      );
    }),
  });

  ctx.http.route({
    ...getMessageRoute,
    schema: { response: GetMessageResponse },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const message = await findChannelMessage(tx, channelId, messageId);
      if (!message) throw notFound('No such message');
      return json(GetMessageResponse.parse(message));
    }),
  });

  ctx.http.route({
    ...editMessageRoute,
    schema: { body: EditMessageRequest, response: EditMessageResponse },
    rateLimit: { limit: 300, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      const { body } = EditMessageRequest.parse(req.body);
      // The write itself is `editChannelMessage` (service.ts) — the same call the `messages.update` capability makes.
      const edited = await editChannelMessage(deps, tx, { channelId, messageId, body, syncRefs: true });
      return json(EditMessageResponse.parse(edited));
    }),
  });

  // Earlier versions of an edited message: whoever may read the message reads them (the table's own policy), nobody else.
  ctx.http.route({
    ...listMessageVersionsRoute,
    schema: { response: ListMessageVersionsResponse },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const message = await findChannelMessage(tx, channelId, messageId);
      if (!message) throw notFound('No such message');
      // a deleted message keeps no history (the trigger dropped it); say so without a query
      if (message.deletedAt) return json(ListMessageVersionsResponse.parse({ items: [] }));
      const res = await tx.query<{ id: string; body: string; written_at: Date; replaced_at: Date }>(
        'SELECT v.id, v.body, v.written_at, v.replaced_at FROM app.message_versions v WHERE v.message_id = $1 AND v.channel_id = $2 ORDER BY v.id',
        [messageId, channelId],
      );
      return json(
        ListMessageVersionsResponse.parse({
          items: res.rows.map((r) => ({ id: r.id, body: r.body, writtenAt: r.written_at.toISOString(), replacedAt: r.replaced_at.toISOString() })),
        }),
      );
    }),
  });

  ctx.http.route({
    ...clearMessageVersionsRoute,
    schema: { response: ClearMessageVersionsResponse },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const message = await findChannelMessage(tx, channelId, messageId);
      if (!message) throw notFound('No such message');
      if (message.authorId !== tx.actor.id) throw forbidden('Only the author can clear the earlier versions of a message');
      const res = await tx.query<{ n: number }>('SELECT app.message_versions_clear($1) AS n', [messageId]);
      return json(ClearMessageVersionsResponse.parse({ cleared: res.rows[0]?.n ?? 0 }));
    }),
  });

  // Mark unread from here: the caller's own read position moves back to the message before this one.
  ctx.http.route({
    ...markMessageUnreadRoute,
    schema: { response: MarkMessageUnreadResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const message = await findChannelMessage(tx, channelId, messageId);
      if (!message) throw notFound('No such message');
      if (message.deletedAt) throw conflict('That message was deleted');
      const person = await myPersonId(tx);
      if (!person) throw forbidden('Reading position belongs to people');
      // the thread of a reply, else the channel itself; the position is the message just before this one in that feed (a reply with no reply
      // before it falls back to the first message of its thread, so only replies count)
      const root = message.threadRootId;
      const before = (
        await tx.query<{ id: string | null }>(
          root
            ? 'SELECT id FROM app.messages WHERE thread_root_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1'
            : 'SELECT id FROM app.messages WHERE channel_id = $1 AND thread_root_id IS NULL AND id < $2 ORDER BY id DESC LIMIT 1',
          [root ?? channelId, messageId],
        )
      ).rows[0]?.id ?? null;
      const entry = await ctx.readState.markUnread(
        tx,
        person,
        root ? { targetType: 'thread', targetId: root } : { targetType: 'channel', targetId: channelId },
        before ?? root,
      );
      return json(MarkMessageUnreadResponse.parse(entry));
    }),
  });

  // Forward: a new message of the forwarder's own in another channel or direct message, holding a reference to the original (never its text).
  ctx.http.route({
    ...forwardMessageRoute,
    schema: { body: ForwardMessageRequest, response: ForwardMessageResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      const { targetChannelId, note } = ForwardMessageRequest.parse(req.body);
      await requireChannel(tx, channelId); // the forwarder must be able to read the original
      const original = await findChannelMessage(tx, channelId, messageId);
      if (!original) throw notFound('No such message');
      if (original.deletedAt) throw conflict('That message was deleted');
      const target = await requireChannel(tx, targetChannelId);
      if (target.kind === 'bot_conversation') throw conflict('A conversation with a bot cannot receive a forwarded message');
      // `postChannelMessage` checks the post permission, the archive and all that a message gets; the reference rides in `meta`
      const posted = await postChannelMessage(deps, tx, {
        channelId: targetChannelId,
        body: note && note.length > 0 ? note : 'Forwarded a message',
        threadRootId: null,
        meta: { forward: { channelId, messageId, threadRootId: original.threadRootId } },
      });
      const forwarded = await findChannelMessage(tx, targetChannelId, posted.id);
      return json(ForwardMessageResponse.parse(forwarded), 201);
    }),
  });

  ctx.http.route({
    ...deleteMessageRoute,
    schema: { response: DeleteMessageResponse },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      const current = await findChannelMessage(tx, channelId, messageId);
      if (!current) throw notFound('No such message');
      if (current.authorId !== tx.actor.id && !(await can(tx, channelId, 'manage'))) {
        throw forbidden('Only the author or a team lead can delete a message');
      }
      if (current.deletedAt) return json(DeleteMessageResponse.parse({ deleted: false }));
      if (channel.archived_at) throw conflict('This channel is archived');
      const res = await tx.query(
        `UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL RETURNING id`,
        [messageId, channelId],
      );
      if (res.rows.length === 0) throw forbidden('You cannot delete this message');
      await emit(tx, {
        type: 'channel.message.deleted',
        channelId,
        teamId: channel.team_id,
        messageId,
        deletedBy: tx.actor.id,
        threadRootId: current.threadRootId,
      });
      await pushMessageDeleted(deps, tx, await audience(tx, channelId), MessageDeletedPush.parse({ channelId, messageId, threadRootId: current.threadRootId }));
      return json(DeleteMessageResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    ...reactRoute,
    schema: { body: ReactRequest, response: ReactResponse },
    rateLimit: { limit: 300, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = MessagePathParams.parse(req.params);
      const { emoji } = ReactRequest.parse(req.body);
      const channel = await requireChannel(tx, channelId);
      const message = await findChannelMessage(tx, channelId, messageId);
      if (!message) throw notFound('No such message');
      if (message.deletedAt) throw conflict('That message was deleted');
      await requirePost(tx, channel);
      const res = await tx.query(
        `INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id) VALUES ($1, app.actor(), $2, $3)
         ON CONFLICT DO NOTHING RETURNING message_id`,
        [messageId, emoji, channelId],
      );
      const added = res.rows.length > 0;
      const reactions = (await reactionsFor(tx, [messageId])).get(messageId) ?? [];
      if (added) {
        await emit(tx, { type: 'channel.reaction.changed', channelId, teamId: channel.team_id, messageId, actorId: tx.actor.id, emoji, added: true });
        await pushReaction(
          deps,
          tx,
          await audience(tx, channelId),
          ReactionChangedPush.parse({
            channelId, messageId, actorId: tx.actor.id, emoji, added: true,
            count: reactions.find((r) => r.emoji === emoji)?.count ?? 1,
          }),
        );
      }
      return json(ReactResponse.parse({ added, reactions }));
    }),
  });

  ctx.http.route({
    ...unreactRoute,
    schema: { response: UnreactResponse },
    handler: route(async (req, tx) => {
      const { channelId, messageId, emoji } = UnreactPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      const res = await tx.query(
        'DELETE FROM app.message_reactions WHERE message_id = $1 AND channel_id = $2 AND emoji = $3 AND actor_id = app.actor() RETURNING message_id',
        [messageId, channelId, emoji],
      );
      const removed = res.rows.length > 0;
      const reactions = (await reactionsFor(tx, [messageId])).get(messageId) ?? [];
      if (removed) {
        await emit(tx, { type: 'channel.reaction.changed', channelId, teamId: channel.team_id, messageId, actorId: tx.actor.id, emoji, added: false });
        await pushReaction(
          deps,
          tx,
          await audience(tx, channelId),
          ReactionChangedPush.parse({
            channelId, messageId, actorId: tx.actor.id, emoji, added: false,
            count: reactions.find((r) => r.emoji === emoji)?.count ?? 0,
          }),
        );
      }
      return json(UnreactResponse.parse({ removed, reactions }));
    }),
  });
}
