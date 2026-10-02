import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ChannelMessage,
  type ChannelCreatedPush,
  type FileSummary,
  type MessageAuthor,
  type MessageDeletedPush,
  type MessagePostedPush,
  type ReactionChangedPush,
  type ReactionSummary,
} from '@manythreads/shared';
import { conflict, forbidden } from './http.ts';
import {
  CHANNEL_COLUMNS,
  MESSAGE_COLUMNS,
  toChannel,
  toChannelMessage,
  type ChannelRow,
  type MessageWithThreadRow,
} from './rows.ts';

/** What every route module needs from the plugin context. */
export interface Deps {
  ctx: PluginContext;
}

/** A push over WebSocket stays well under the 7,000 bytes a NOTIFY may carry; a larger message is fetched by id instead. */
const MAX_PUSH_BYTES = 5_500;

/** The channel, if the caller may read it (row level security decides); undefined for a missing one and a hidden one alike. */
export async function findChannel(tx: PluginTx, channelId: string): Promise<ChannelRow | undefined> {
  const res = await tx.query<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM app.channels c WHERE c.id = $1`, [channelId]);
  return res.rows[0];
}

/** 403 for a channel that does not exist or that the caller cannot see: nobody learns which. */
export async function requireChannel(tx: PluginTx, channelId: string): Promise<ChannelRow> {
  const channel = await findChannel(tx, channelId);
  if (!channel) throw forbidden();
  return channel;
}

export async function can(tx: PluginTx, channelId: string, permission: 'read' | 'post' | 'manage'): Promise<boolean> {
  const res = await tx.query<{ ok: boolean }>('SELECT app.channel_can($1, $2) AS ok', [channelId, permission]);
  return res.rows[0]?.ok === true;
}

/** Posting, editing and reacting need the post permission (a guest with a read grant has none) and a channel that is not archived. */
export async function requirePost(tx: PluginTx, channel: ChannelRow): Promise<void> {
  if (channel.archived_at) throw conflict('This channel is archived');
  if (!(await can(tx, channel.id, 'post'))) throw forbidden('You can read this channel but not post in it');
}

/** The team of a channel for someone who can read or manage it (an admin may add people to a private channel they cannot SELECT). */
export async function channelTeamId(tx: PluginTx, channelId: string): Promise<string | null> {
  const res = await tx.query<{ team_id: string | null }>('SELECT app.channel_team_id($1) AS team_id', [channelId]);
  return res.rows[0]?.team_id ?? null;
}

export async function myPersonId(tx: PluginTx): Promise<string | null> {
  const res = await tx.query<{ id: string | null }>('SELECT app.person_id() AS id');
  return res.rows[0]?.id ?? null;
}

/** The people who can read the channel now (the push audience). */
export async function audience(tx: PluginTx, channelId: string): Promise<string[]> {
  const res = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1)', [channelId]);
  return res.rows.map((r) => r.person_id);
}

/** Reactions of a set of messages as the caller sees them (`mine`), in the order they first appeared. */
export async function reactionsFor(tx: PluginTx, messageIds: readonly string[]): Promise<Map<string, ReactionSummary[]>> {
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
 * The names of the authors of these messages, by author actor id, for the messages the caller can read (`app.message_authors` joins the
 * ids to the caller's readable channels before it looks anybody up, so no name outside a visible message is ever returned).
 */
export async function authorsFor(tx: PluginTx, messageIds: readonly string[]): Promise<Map<string, MessageAuthor>> {
  const out = new Map<string, MessageAuthor>();
  if (messageIds.length === 0) return out;
  const res = await tx.query<{ actor_id: string; display_name: string; kind: MessageAuthor['kind'] }>(
    'SELECT actor_id, display_name, kind FROM app.message_authors($1::uuid[])',
    [messageIds],
  );
  for (const r of res.rows) out.set(r.actor_id, { actorId: r.actor_id, displayName: r.display_name, kind: r.kind } as MessageAuthor);
  return out;
}

/**
 * The files attached to messages (`meta.attachments`) as cards, in the order the sender listed them, for what the caller may read: a file in
 * a channel they cannot see, or one that was deleted, is left out. Touches `app.files` (the files plugin) only when a message has attachments.
 */
export async function attachmentsFor(
  tx: PluginTx,
  messages: readonly { id: string; meta: Record<string, unknown> }[],
): Promise<Map<string, FileSummary[]>> {
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
  for (const [messageId, ids] of wanted) {
    out.set(messageId, ids.flatMap((id) => byId.get(id) ?? []));
  }
  return out;
}

/** One message of a channel with its reactions and thread counters; undefined when it is not there for this caller. */
export async function findChannelMessage(tx: PluginTx, channelId: string, messageId: string): Promise<ChannelMessage | undefined> {
  const res = await tx.query<MessageWithThreadRow>(
    `SELECT ${MESSAGE_COLUMNS}, t.reply_count, t.last_reply_at
       FROM app.messages m LEFT JOIN app.threads t ON t.root_message_id = m.id
      WHERE m.id = $1 AND m.channel_id = $2`,
    [messageId, channelId],
  );
  const row = res.rows[0];
  if (!row) return undefined;
  const reactions = await reactionsFor(tx, [row.id]);
  const attachments = await attachmentsFor(tx, [row]);
  const authors = await authorsFor(tx, [row.id]);
  return toChannelMessage(row, reactions.get(row.id) ?? [], attachments.get(row.id) ?? [], authors.get(row.author_id));
}

/** Sends one push to each of `people` (the channel's audience), atomically with the change: delivered when `tx` commits. One statement for any audience size. */
async function pushToPeople(
  { ctx }: Deps,
  tx: PluginTx,
  people: readonly string[],
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.realtime.pushToPeople(tx, people, type, payload);
}

/** `message.posted` and `message.edited`: the message rides along when it is small enough, else the client fetches it. */
export async function pushMessage(
  deps: Deps,
  tx: PluginTx,
  people: readonly string[],
  type: 'message.posted' | 'message.edited',
  message: ChannelMessage,
): Promise<void> {
  const full: MessagePostedPush = { channelId: message.channelId, messageId: message.id, threadRootId: message.threadRootId, message };
  const small = JSON.stringify(full).length <= MAX_PUSH_BYTES;
  const payload: MessagePostedPush = small ? full : { channelId: message.channelId, messageId: message.id, threadRootId: message.threadRootId };
  await pushToPeople(deps, tx, people, type, payload);
}

export const pushMessageDeleted = (deps: Deps, tx: PluginTx, people: readonly string[], payload: MessageDeletedPush): Promise<void> =>
  pushToPeople(deps, tx, people, 'message.deleted', payload);

export const pushReaction = (deps: Deps, tx: PluginTx, people: readonly string[], payload: ReactionChangedPush): Promise<void> =>
  pushToPeople(deps, tx, people, 'reaction.changed', payload);

export const pushChannelCreated = async (deps: Deps, tx: PluginTx, row: ChannelRow): Promise<void> => {
  const payload: ChannelCreatedPush = { channel: toChannel(row) };
  await pushToPeople(deps, tx, await audience(tx, row.id), 'channel.created', payload);
};

/** The people who follow a thread (and can still read its channel): who its replies count as unread for. */
export async function threadFollowers(tx: PluginTx, rootId: string): Promise<string[]> {
  const res = await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_follower_ids($1)', [rootId]);
  return res.rows.map((r) => r.person_id);
}
