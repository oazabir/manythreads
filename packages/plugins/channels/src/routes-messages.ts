import {
  ChannelPathParams,
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
  type FileSummary,
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
  toPlainText,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { syncMessageRefs } from './mentions.ts';
import {
  MESSAGE_COLUMNS,
  toChannelMessage,
  toMessage,
  type MessageRow,
  type MessageWithThreadRow,
} from './rows.ts';
import {
  attachmentsFor,
  authorsFor,
  audience,
  can,
  findChannelMessage,
  pushMessage,
  pushMessageDeleted,
  pushReaction,
  reactionsFor,
  requireChannel,
  requirePost,
  threadFollowers,
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
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      if (body.threadRootId) {
        const root = (
          await tx.query<{ thread_root_id: string | null; deleted_at: Date | null }>(
            'SELECT thread_root_id, deleted_at FROM app.messages WHERE id = $1 AND channel_id = $2',
            [body.threadRootId, channelId],
          )
        ).rows[0];
        if (!root) throw notFound('No such message to reply to in this channel');
        if (root.thread_root_id) throw conflict('Reply to the first message of the thread, not to a reply');
        if (root.deleted_at) throw conflict('That message was deleted');
      }
      // Attachments are files the sender already uploaded to this channel (the files plugin); the ids go into meta, the cards are resolved on read.
      const attachmentIds = body.attachments ?? [];
      if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('attachments: a file can be attached once');
      let cards: FileSummary[] = [];
      if (attachmentIds.length > 0) {
        const found = await tx
          .query<{ id: string; name: string; size: string; mime: string }>(
            'SELECT f.id, f.name, f.size, f.mime FROM app.files f WHERE f.id = ANY ($1::uuid[]) AND f.channel_id = $2 AND f.uploader_id = app.actor()',
            [attachmentIds, channelId],
          )
          .catch((err: unknown) => {
            if ((err as { code?: string }).code === '42P01') throw invalid('attachments: file storage is not enabled');
            throw err;
          });
        if (found.rows.length !== attachmentIds.length) throw invalid('attachments: every file must be one you uploaded to this channel');
        const byId = new Map(found.rows.map((r) => [r.id, { id: r.id, name: r.name, size: Number(r.size), mime: r.mime } as FileSummary]));
        cards = attachmentIds.map((id) => byId.get(id)!);
      }
      const res = await tx.query<MessageRow>(
        `INSERT INTO app.messages AS m (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta)
         VALUES (app.workspace_id(), $1, app.actor(), $2, $3, $4, $5::jsonb) RETURNING ${MESSAGE_COLUMNS}`,
        [channelId, body.body, toPlainText(body.body), body.threadRootId, JSON.stringify(attachmentIds.length > 0 ? { attachments: attachmentIds } : {})],
      );
      const row = res.rows[0]!;
      await emit(tx, {
        type: 'channel.message.posted',
        channelId,
        teamId: channel.team_id,
        messageId: row.id,
        authorId: row.author_id,
        threadRootId: row.thread_root_id,
      });
      const readers = await audience(tx, channelId);
      await pushMessage(deps, tx, readers, 'message.posted', toChannelMessage({ ...row, reply_count: null, last_reply_at: null }, [], cards, (await authorsFor(tx, [row.id])).get(row.author_id)));
      // Unread: a channel message counts for every reader, a reply for the followers of its thread (the replier and the root's author
      // follow it by themselves, see the messages triggers).
      await ctx.readState.onPosted(tx, {
        targetType: row.thread_root_id ? 'thread' : 'channel',
        targetId: row.thread_root_id ?? channelId,
        messageId: row.id,
        authorId: row.author_id,
        recipientPersonIds: row.thread_root_id ? await threadFollowers(tx, row.thread_root_id) : readers,
      });
      // Sending ends the author's "typing" signal, and what the body names (people, channels, entities) is recorded.
      await tx.query('DELETE FROM app.typing WHERE channel_id = $1 AND person_id = app.person_id()', [channelId]);
      await syncMessageRefs(deps, tx, channel, { id: row.id, body: row.body, authorId: row.author_id, threadRootId: row.thread_root_id }, 'post');
      return json(PostMessageResponse.parse(toMessage(row)), 201);
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
      const oldest = page[page.length - 1];
      return json(
        ListMessagesResponse.parse({
          items: page.map((r) => toChannelMessage(r, reactions.get(r.id) ?? [], attachments.get(r.id) ?? [], authors.get(r.author_id))),
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
      const channel = await requireChannel(tx, channelId);
      const current = await findChannelMessage(tx, channelId, messageId);
      if (!current) throw notFound('No such message');
      if (current.authorId !== tx.actor.id) throw forbidden('You can only edit your own messages');
      if (current.deletedAt) throw conflict('That message was deleted');
      if (current.body === body) return json(EditMessageResponse.parse(current));
      await requirePost(tx, channel);
      const res = await tx.query(
        `UPDATE app.messages SET body = $3, body_plain = $4, edited_at = now() WHERE id = $1 AND channel_id = $2 RETURNING id`,
        [messageId, channelId, body, toPlainText(body)],
      );
      if (res.rows.length === 0) throw forbidden('You cannot edit this message');
      await emit(tx, {
        type: 'channel.message.edited',
        channelId,
        teamId: channel.team_id,
        messageId,
        editorId: tx.actor.id,
        threadRootId: current.threadRootId,
      });
      const edited = (await findChannelMessage(tx, channelId, messageId))!;
      const readers = await audience(tx, channelId);
      await pushMessage(deps, tx, readers, 'message.edited', edited);
      await syncMessageRefs(deps, tx, channel, { id: messageId, body, authorId: current.authorId, threadRootId: current.threadRootId }, 'edit');
      return json(EditMessageResponse.parse(edited));
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
