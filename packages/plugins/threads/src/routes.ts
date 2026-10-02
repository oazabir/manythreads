import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  FollowThreadResponse,
  GetThreadQuery,
  GetThreadResponse,
  ListThreadsParams,
  ListThreadsQuery,
  ListThreadsResponse,
  ThreadPathParams,
  ThreadState,
  followThreadRoute,
  getThreadRoute,
  listThreadsRoute,
  unfollowThreadRoute,
  type FileSummary,
  type ReactionSummary,
} from '@manythreads/shared';
import { listInbox } from './inbox.ts';
import { conflict, forbidden, json, notFound, route } from './http.ts';
import { CHANNEL_REF_COLUMNS, MESSAGE_COLUMNS, toChannelMessage, toChannelRef, type ChannelRefRow, type MessageRow } from './rows.ts';

/** The signed-in person (people.id); follows and read state belong to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Threads belong to people');
  return row.id;
}

type RootRow = MessageRow & ChannelRefRow & { thread_title: string | null };

/**
 * The root message of a thread, with its channel and counters, if the caller may read it. A message that does not exist and one in a
 * channel the caller cannot see look the same (403); a message that is itself a reply is 404 (visible, but not a thread).
 */
async function requireRoot(tx: PluginTx, rootId: string): Promise<RootRow> {
  const res = await tx.query<RootRow>(
    `SELECT ${MESSAGE_COLUMNS}, t.reply_count, t.last_reply_at, t.title AS thread_title, ${CHANNEL_REF_COLUMNS}
       FROM app.messages m JOIN app.channels c ON c.id = m.channel_id LEFT JOIN app.threads t ON t.root_message_id = m.id
      WHERE m.id = $1`,
    [rootId],
  );
  const row = res.rows[0];
  if (!row) throw forbidden('You cannot see this thread');
  if (row.thread_root_id) throw notFound('That message is a reply, not the first message of a thread');
  return row;
}

async function reactionsFor(tx: PluginTx, messageIds: readonly string[]): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const res = await tx.query<{ message_id: string; emoji: string; count: number; mine: boolean }>(
    `SELECT r.message_id, r.emoji, count(*)::int AS count, bool_or(r.actor_id = app.actor()) AS mine
       FROM app.message_reactions r WHERE r.message_id = ANY ($1::uuid[])
      GROUP BY r.message_id, r.emoji ORDER BY min(r.created_at), r.emoji`,
    [messageIds],
  );
  for (const r of res.rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine } as ReactionSummary);
    out.set(r.message_id, list);
  }
  return out;
}

/**
 * The files attached to messages (`meta.attachments`) as cards, in the order the sender listed them, for what the caller may read (the
 * files table's own policy decides; a file the caller cannot see is left out). Touches `app.files` only when a message has attachments.
 */
async function attachmentsFor(tx: PluginTx, messages: readonly MessageRow[]): Promise<Map<string, FileSummary[]>> {
  const out = new Map<string, FileSummary[]>();
  const wanted = new Map<string, string[]>();
  for (const m of messages) {
    const ids = m.meta['attachments'];
    if (Array.isArray(ids) && ids.length > 0) wanted.set(m.id, ids.filter((x): x is string => typeof x === 'string'));
  }
  if (wanted.size === 0) return out;
  const res = await tx.query<{ id: string; name: string; size: string; mime: string }>(
    'SELECT f.id, f.name, f.size, f.mime FROM app.files f WHERE f.id = ANY ($1::uuid[])',
    [[...new Set([...wanted.values()].flat())]],
  );
  const byId = new Map(res.rows.map((r) => [r.id, { id: r.id, name: r.name, size: Number(r.size), mime: r.mime } as FileSummary]));
  for (const [messageId, ids] of wanted) out.set(messageId, ids.flatMap((id) => byId.get(id) ?? []));
  return out;
}

/**
 * Threads (SPEC 6.1, PLAN P3-06). Replying is the channels plugin's `POST /api/channels/:channelId/messages` with `threadRootId`:
 * one insert path, which also does the event, the live push, the unread counts, the mentions and the automatic follow, so a reply
 * through this plugin would be a copy of it. This plugin reads a thread, follows and unfollows it, and lists the Threads inbox.
 *
 * Following has ONE source of truth, `thread_follows` (it decides who gets a thread's unread counts). `read_state.followed` mirrors it
 * (a trigger of the channels migration 0003, plus `ctx.readState.setFollowed` here so the change is announced and pushed).
 */
export function registerThreadRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getThreadRoute,
    schema: { query: GetThreadQuery, response: GetThreadResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadPathParams.parse(req.params);
      const q = GetThreadQuery.parse(req.query);
      const root = await requireRoot(tx, rootId);
      // Replies: the live ones, newest first, keyset by id (uuid v7 sorts by time) like the channel list.
      const res = await tx.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}, NULL::int AS reply_count, NULL::timestamptz AS last_reply_at
           FROM app.messages m WHERE m.thread_root_id = $1 AND m.deleted_at IS NULL AND ($2::uuid IS NULL OR m.id < $2)
          ORDER BY m.id DESC LIMIT $3`,
        [rootId, q.before ?? null, q.limit + 1],
      );
      const more = res.rows.length > q.limit;
      const page = more ? res.rows.slice(0, q.limit) : res.rows;
      const reactions = await reactionsFor(tx, [rootId, ...page.map((r) => r.id)]);
      const attachments = await attachmentsFor(tx, [root, ...page]);
      const oldest = page[page.length - 1];

      const person = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      let followed = false;
      let entry = { unreadCount: 0, lastReadId: null as string | null };
      if (person) {
        followed = (await tx.query('SELECT 1 FROM app.thread_follows WHERE person_id = $1 AND thread_root_id = $2', [person, rootId])).rows.length > 0;
        const [state] = await ctx.readState.get(tx, person, [{ targetType: 'thread', targetId: rootId }]);
        if (state) entry = { unreadCount: state.unreadCount, lastReadId: state.lastReadId };
      }
      return json(
        GetThreadResponse.parse({
          channel: toChannelRef(root),
          root: toChannelMessage(root, reactions.get(rootId) ?? [], attachments.get(rootId) ?? []),
          thread: ThreadState.parse({
            rootMessageId: rootId,
            channelId: root.channel_id,
            title: root.thread_title ?? '',
            replyCount: root.reply_count ?? 0,
            lastReplyAt: root.last_reply_at?.toISOString() ?? null,
            followed,
            ...entry,
          }),
          replies: {
            items: page.map((r) => toChannelMessage(r, reactions.get(r.id) ?? [], attachments.get(r.id) ?? [])),
            nextCursor: more && oldest ? oldest.id : null,
          },
        }),
      );
    }),
  });

  ctx.http.route({
    ...followThreadRoute,
    schema: { response: FollowThreadResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadPathParams.parse(req.params);
      const person = await callerPerson(tx);
      const root = await requireRoot(tx, rootId);
      if (root.deleted_at) throw conflict('That message was deleted');
      // The mirror first (it announces the change and pushes it to the person's sockets), then the membership.
      await ctx.readState.setFollowed(tx, person, { targetType: 'thread', targetId: rootId }, true);
      const res = await tx.query(
        'INSERT INTO app.thread_follows (person_id, thread_root_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING thread_root_id',
        [person, rootId],
      );
      return json(FollowThreadResponse.parse({ followed: true, changed: res.rows.length > 0 }));
    }),
  });

  ctx.http.route({
    ...unfollowThreadRoute,
    schema: { response: FollowThreadResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadPathParams.parse(req.params);
      const person = await callerPerson(tx);
      await requireRoot(tx, rootId);
      const target = { targetType: 'thread', targetId: rootId } as const;
      const entry = await ctx.readState.setFollowed(tx, person, target, false);
      const res = await tx.query('DELETE FROM app.thread_follows WHERE person_id = $1 AND thread_root_id = $2 RETURNING thread_root_id', [
        person,
        rootId,
      ]);
      // Not following means not being told: replies that were counted unread stop counting, so the Unread tab and the badge never
      // list a thread the person has stopped following.
      if (entry.unreadCount > 0) {
        const latest = (
          await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.messages WHERE thread_root_id = $1', [rootId])
        ).rows[0]?.id;
        if (latest) await ctx.readState.markRead(tx, person, target, latest, { remaining: 0 });
      }
      return json(FollowThreadResponse.parse({ followed: false, changed: res.rows.length > 0 }));
    }),
  });

  ctx.http.route({
    ...listThreadsRoute,
    schema: { query: ListThreadsQuery, response: ListThreadsResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListThreadsParams.parse(req.params);
      const q = ListThreadsQuery.parse(req.query);
      const person = await callerPerson(tx);
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0];
      const teamId: string | null = team?.id ?? null;
      if (!teamId) {
        // An unknown or unreadable team has an empty inbox (200, like the channel directory); a guest sits on no team and gets the
        // threads of the channels they were granted, whatever the slug.
        const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
        if (role !== 'guest') return json(ListThreadsResponse.parse({ items: [], nextCursor: null }));
      }
      return json(await listInbox(tx, { personId: person, tab: q.tab, teamId, limit: q.limit, cursor: q.cursor }));
    }),
  });
}
