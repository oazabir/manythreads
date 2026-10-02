import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ChannelMessage,
  type ChannelCreatedPush,
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
  return toChannelMessage(row, reactions.get(row.id) ?? []);
}

/** Sends one push to everyone who can read the channel, atomically with the change (delivered when `tx` commits). */
async function pushToAudience(
  { ctx }: Deps,
  tx: PluginTx,
  channelId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const personId of await audience(tx, channelId)) await ctx.realtime.pushToPerson(tx, personId, type, payload);
}

/** `message.posted` and `message.edited`: the message rides along when it is small enough, else the client fetches it. */
export async function pushMessage(
  deps: Deps,
  tx: PluginTx,
  type: 'message.posted' | 'message.edited',
  message: ChannelMessage,
): Promise<void> {
  const full: MessagePostedPush = { channelId: message.channelId, messageId: message.id, threadRootId: message.threadRootId, message };
  const small = JSON.stringify(full).length <= MAX_PUSH_BYTES;
  const payload: MessagePostedPush = small ? full : { channelId: message.channelId, messageId: message.id, threadRootId: message.threadRootId };
  await pushToAudience(deps, tx, message.channelId, type, payload);
}

export const pushMessageDeleted = (deps: Deps, tx: PluginTx, payload: MessageDeletedPush): Promise<void> =>
  pushToAudience(deps, tx, payload.channelId, 'message.deleted', payload);

export const pushReaction = (deps: Deps, tx: PluginTx, payload: ReactionChangedPush): Promise<void> =>
  pushToAudience(deps, tx, payload.channelId, 'reaction.changed', payload);

export const pushChannelCreated = (deps: Deps, tx: PluginTx, row: ChannelRow): Promise<void> => {
  const payload: ChannelCreatedPush = { channel: toChannel(row) };
  return pushToAudience(deps, tx, row.id, 'channel.created', payload);
};
