import type { ImportedMessage, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ChannelMessage,
  FORWARD_EXCERPT_CHARS,
  type ChannelCreatedPush,
  type FileSummary,
  type ForwardedMessage,
  type MessageAuthor,
  type MessageDeletedPush,
  type MessagePostedPush,
  type ReactionChangedPush,
  type ReactionSummary,
  type VoiceMeta,
  toPlainText,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, notFound } from './http.ts';
import { syncMessageRefs, type GroupNotice } from './mentions.ts';
import { pollIdOf, pollsFor } from './poll-views.ts';
import {
  CHANNEL_COLUMNS,
  MESSAGE_COLUMNS,
  toChannel,
  toChannelMessage,
  type ChannelRow,
  type MessageRow,
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
  const res = await tx.query<{ actor_id: string; display_name: string; kind: MessageAuthor['kind']; sender: MessageAuthor['sender'] | null }>(
    'SELECT actor_id, display_name, kind, sender FROM app.message_authors($1::uuid[])',
    [messageIds],
  );
  for (const r of res.rows) out.set(r.actor_id, { actorId: r.actor_id, displayName: r.display_name, kind: r.kind, ...(r.sender ? { sender: r.sender } : {}) } as MessageAuthor);
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
  // A bot reads a voice message by its transcript, never the recording: audio files are not listed for a bot (P14-17).
  const visible = tx.actor.kind === 'bot' ? res.rows.filter((r) => !r.mime.startsWith('audio/')) : res.rows;
  const byId = new Map(visible.map((r) => [r.id, { id: r.id, name: r.name, size: Number(r.size), mime: r.mime } as FileSummary]));
  for (const [messageId, ids] of wanted) {
    out.set(messageId, ids.flatMap((id) => byId.get(id) ?? []));
  }
  return out;
}

/** What a forwarding message stores in `meta.forward`: where the original lives. Never its text. */
export interface ForwardRef {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function forwardRefOf(meta: Record<string, unknown>): ForwardRef | undefined {
  const f = meta['forward'];
  if (typeof f !== 'object' || f === null) return undefined;
  const { channelId, messageId, threadRootId } = f as Record<string, unknown>;
  if (typeof channelId !== 'string' || !UUID_RE.test(channelId) || typeof messageId !== 'string' || !UUID_RE.test(messageId)) return undefined;
  return { channelId, messageId, threadRootId: typeof threadRootId === 'string' && UUID_RE.test(threadRootId) ? threadRootId : null };
}

/**
 * The quote cards of forwarding messages, by the forwarding message's id, **as the caller may see the original** (P14-12): the original is read
 * under the caller's own row level security, so a reader who cannot read its channel gets `hidden` and nothing of its text, author or place.
 */
export async function forwardsFor(
  tx: PluginTx,
  messages: readonly { id: string; meta: Record<string, unknown>; deleted_at: Date | null }[],
): Promise<Map<string, ForwardedMessage>> {
  const out = new Map<string, ForwardedMessage>();
  const wanted = new Map<string, ForwardRef>();
  for (const m of messages) {
    if (m.deleted_at) continue;
    const ref = forwardRefOf(m.meta);
    if (ref) wanted.set(m.id, ref);
  }
  if (wanted.size === 0) return out;
  const res = await tx.query<{
    id: string;
    channel_id: string;
    author_id: string;
    body_plain: string;
    created_at: Date;
    deleted_at: Date | null;
    thread_root_id: string | null;
    name: string;
    kind: 'channel' | 'dm' | 'bot_conversation';
    team_id: string | null;
  }>(
    `SELECT m.id, m.channel_id, m.author_id, m.body_plain, m.created_at, m.deleted_at, m.thread_root_id, c.name, c.kind, c.team_id
       FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
      WHERE m.id = ANY ($1::uuid[])`,
    [[...new Set([...wanted.values()].map((r) => r.messageId))]],
  );
  const originals = new Map(res.rows.map((r) => [r.id, r]));
  const authors = await authorsFor(tx, res.rows.filter((r) => !r.deleted_at).map((r) => r.id));
  for (const [id, ref] of wanted) {
    const o = originals.get(ref.messageId);
    if (!o || o.channel_id !== ref.channelId) out.set(id, { state: 'hidden' });
    else if (o.deleted_at) out.set(id, { state: 'deleted' });
    else {
      const text = o.body_plain.trim();
      const author = authors.get(o.author_id);
      out.set(id, {
        state: 'visible',
        channelId: o.channel_id,
        channelKind: o.kind,
        channelName: o.kind === 'channel' ? o.name : null,
        teamId: o.team_id,
        messageId: o.id,
        threadRootId: o.thread_root_id,
        ...(author ? { author } : {}),
        createdAt: o.created_at.toISOString(),
        excerpt: text.length > FORWARD_EXCERPT_CHARS ? `${text.slice(0, FORWARD_EXCERPT_CHARS)}…` : text,
      } as ForwardedMessage);
    }
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
  const forwards = await forwardsFor(tx, [row]);
  const polls = await pollsFor(tx, [row]);
  return toChannelMessage(row, reactions.get(row.id) ?? [], attachments.get(row.id) ?? [], authors.get(row.author_id), forwards.get(row.id), polls.get(row.id));
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
  /** The card depends on who reads it (a forward's original, a poll's own ballot): one push goes to everybody, so it carries no message and each client fetches its own. */
  perReader = false,
): Promise<void> {
  const full: MessagePostedPush = { channelId: message.channelId, messageId: message.id, threadRootId: message.threadRootId, message };
  const small = message.forward === undefined && !perReader && JSON.stringify(full).length <= MAX_PUSH_BYTES;
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

/** What posting one message needs, once the caller's shape is validated. */
export interface PostMessageInput {
  channelId: string;
  body: string;
  threadRootId?: string | null;
  /** Files the poster already uploaded to this channel (the files plugin); their cards are resolved when the message is read. */
  attachmentIds?: readonly string[];
  /** A voice message (P14-17): the clip is the one attachment and this names it; stored as `meta.voice`. People who are not guests only. */
  voice?: VoiceMeta;
  /** Extra `meta` for the row (the run that wrote it, an integration's own bookkeeping). */
  meta?: Record<string, unknown>;
  /** Do not record mentions and links (the copy made by "Also send to channel": the reply it copies has already notified everybody named). */
  skipRefs?: boolean;
  /** The writer confirmed that `@here` / `@channel` will notify a big room (P14-02; a bot's post never carries it, and a bot's `@channel` notifies nobody). */
  confirmBroadcast?: boolean;
  /** Imported history (the import plugin; system transactions only): keeps its original time, raises no event, push, unread count or mention. */
  imported?: ImportedMessage;
}

export interface PostedMessage {
  id: string;
  channelId: string;
  threadRootId: string | null;
  /** The row as written: the route answers with it. */
  row: MessageRow;
  /** The message the push carries (a fresh row: no replies, no reactions, its files' cards). */
  push: ChannelMessage;
  /** Role groups the message named whose mention was cut at the per-group limit (the author is told); empty almost always. */
  groupNotices: GroupNotice[];
}

/**
 * Who may record a voice message (P14-17): a person who is not a guest (a guest can play a clip but not record one). Asked before any file is looked at.
 */
async function checkVoiceSender(tx: PluginTx): Promise<void> {
  if (tx.actor.kind !== 'person') throw forbidden('Only people can send voice messages');
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role === 'guest') throw forbidden('Guests can play voice messages but not record them.');
}

/**
 * The file rules of a voice message, on top of the attachment rules (the file is the author's own, in this channel): exactly one attachment,
 * `voice.fileId` is that attachment, and it is audio. The length is bounded by the shared schema (five minutes).
 */
function checkVoiceFile(voice: VoiceMeta, attachmentIds: readonly string[], cards: readonly FileSummary[]): void {
  if (attachmentIds.length !== 1) throw conflict('A voice message carries exactly one file: its recording');
  if (attachmentIds[0] !== voice.fileId) throw invalid('voice.fileId: must be the file attached to the message');
  if (!cards[0]?.mime.startsWith('audio/')) throw invalid('voice.fileId: the recording must be an audio file');
}

/**
 * Post one message into a channel — **the one path a channel message is written on** (PLAN P5-10): the post route and the
 * `messages.post` capability both call it, so the behaviour a person gets (permission, thread rules, attachments, the
 * event, the push, the unread counters, mention resolution) is exactly what a bot's reply gets. The caller is whoever the
 * transaction says (`app.actor()`): a person on the route, the run's bot through the capability.
 */
export async function postChannelMessage(deps: Deps, tx: PluginTx, input: PostMessageInput): Promise<PostedMessage> {
  if (input.imported) return postImportedMessage(tx, input, input.imported);
  const { ctx } = deps;
  const channel = await requireChannel(tx, input.channelId);
  await requirePost(tx, channel);
  if (input.threadRootId) {
    const root = (
      await tx.query<{ thread_root_id: string | null; deleted_at: Date | null }>(
        'SELECT thread_root_id, deleted_at FROM app.messages WHERE id = $1 AND channel_id = $2',
        [input.threadRootId, input.channelId],
      )
    ).rows[0];
    if (!root) throw notFound('No such message to reply to in this channel');
    if (root.thread_root_id) throw conflict('Reply to the first message of the thread, not to a reply');
    if (root.deleted_at) throw conflict('That message was deleted');
  }
  if (input.voice) await checkVoiceSender(tx);
  const attachmentIds = input.attachmentIds ?? [];
  if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('attachments: a file can be attached once');
  let cards: FileSummary[] = [];
  if (attachmentIds.length > 0) {
    // Row-lock the files first (files migration 0004): a concurrent delete of the last other message that lists one waits for this post, or
    // has already hidden it, in which case the validation below refuses. Without the files plugin there is nothing to lock.
    await tx.query('SELECT app.files_lock_for_attach($1::uuid[])', [attachmentIds]).catch((err: unknown) => {
      if ((err as { code?: string }).code === '42883') throw invalid('attachments: file storage is not enabled');
      throw err;
    });
    const found = await tx
      .query<{ id: string; name: string; size: string; mime: string }>(
        'SELECT f.id, f.name, f.size, f.mime FROM app.files f WHERE f.id = ANY ($1::uuid[]) AND f.channel_id = $2 AND f.uploader_id = app.actor()',
        [attachmentIds, input.channelId],
      )
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '42P01') throw invalid('attachments: file storage is not enabled');
        throw err;
      });
    if (found.rows.length !== attachmentIds.length) throw invalid('attachments: every file must be one you uploaded to this channel');
    const byId = new Map(found.rows.map((r) => [r.id, { id: r.id, name: r.name, size: Number(r.size), mime: r.mime } as FileSummary]));
    cards = attachmentIds.map((id) => byId.get(id)!);
  }
  if (input.voice) checkVoiceFile(input.voice, attachmentIds, cards);
  const meta = { ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}), ...(input.voice ? { voice: input.voice } : {}), ...(input.meta ?? {}) };
  const res = await tx.query<MessageRow>(
    `INSERT INTO app.messages AS m (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta)
     VALUES (app.workspace_id(), $1, app.actor(), $2, $3, $4, $5::jsonb) RETURNING ${MESSAGE_COLUMNS}`,
    [input.channelId, input.body, toPlainText(input.body), input.threadRootId ?? null, JSON.stringify(meta)],
  );
  const row = res.rows[0]!;
  await ctx.audit.emit(tx, {
    type: 'channel.message.posted',
    channelId: input.channelId,
    teamId: channel.team_id,
    messageId: row.id,
    authorId: row.author_id,
    threadRootId: row.thread_root_id,
  });
  const readers = await audience(tx, input.channelId);
  const push = toChannelMessage(
    { ...row, reply_count: null, last_reply_at: null },
    [],
    cards,
    (await authorsFor(tx, [row.id])).get(row.author_id),
    // a forwarding message is pushed without its body (see pushMessage): the placeholder only marks it, no reader is shown this card
    forwardRefOf(meta) ? { state: 'hidden' } : undefined,
  );
  await pushMessage(deps, tx, readers, 'message.posted', push, pollIdOf(meta) !== undefined);
  // Unread: a channel message counts for every reader, a reply for the followers of its thread (the replier and the root's author
  // follow it by themselves, see the messages triggers).
  await ctx.readState.onPosted(tx, {
    targetType: row.thread_root_id ? 'thread' : 'channel',
    targetId: row.thread_root_id ?? input.channelId,
    messageId: row.id,
    authorId: row.author_id,
    recipientPersonIds: row.thread_root_id ? await threadFollowers(tx, row.thread_root_id) : readers,
  });
  // Sending ends the author's "typing" signal, and what the body names (people, channels, entities) is recorded.
  await tx.query('DELETE FROM app.typing WHERE channel_id = $1 AND person_id = app.person_id()', [input.channelId]);
  const groupNotices = input.skipRefs ? [] : await syncMessageRefs(deps, tx, channel, { id: row.id, body: row.body, authorId: row.author_id, threadRootId: row.thread_root_id, ...(input.confirmBroadcast ? { confirmBroadcast: true } : {}) }, 'post');
  return { id: row.id, channelId: input.channelId, threadRootId: row.thread_root_id, row, push, groupNotices };
}

/**
 * Write one message of imported history (PLAN P14-13). The caller is a system transaction that has set the author with `app.import_act_as`; the
 * message gets an id that sorts at its original time (uuidv7 shifted back from now), that time as `created_at`, and `meta.importedFrom`. It
 * raises no event, no live push, no unread count, no typing change and no mention or link record: old history must not notify anybody.
 * The thread rules are the live ones (the root is a top-level message of the same channel). The channel's own post permission is not asked:
 * the import plugin decides who wrote what, and the people it names may no longer be allowed to post.
 */
async function postImportedMessage(tx: PluginTx, input: PostMessageInput, imp: ImportedMessage): Promise<PostedMessage> {
  const channel = (await tx.query<{ id: string }>('SELECT id FROM app.channels WHERE id = $1', [input.channelId])).rows[0];
  if (!channel) throw notFound('No such channel');
  if (input.threadRootId) {
    const root = (
      await tx.query<{ thread_root_id: string | null; deleted_at: Date | null }>(
        'SELECT thread_root_id, deleted_at FROM app.messages WHERE id = $1 AND channel_id = $2',
        [input.threadRootId, input.channelId],
      )
    ).rows[0];
    if (!root) throw notFound('No such message to reply to in this channel');
    if (root.thread_root_id) throw conflict('Reply to the first message of the thread, not to a reply');
  }
  const meta = { importedFrom: { source: imp.source, id: imp.sourceId } };
  const res = await tx.query<MessageRow>(
    `INSERT INTO app.messages AS m (id, workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta, created_at)
     VALUES (uuidv7($6::timestamptz - clock_timestamp()), app.workspace_id(), $1, app.actor(), $2, $3, $4, $5::jsonb, $6::timestamptz)
     RETURNING ${MESSAGE_COLUMNS}`,
    [input.channelId, input.body, toPlainText(input.body), input.threadRootId ?? null, JSON.stringify(meta), imp.at],
  );
  const row = res.rows[0]!;
  for (const group of imp.reactions ?? []) {
    for (const actorId of group.actorIds) {
      await tx.query(
        'INSERT INTO app.message_reactions (message_id, actor_id, emoji, created_at) VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT DO NOTHING',
        [row.id, actorId, group.emoji, imp.at],
      );
    }
  }
  return { id: row.id, channelId: input.channelId, threadRootId: row.thread_root_id, row, push: toChannelMessage({ ...row, reply_count: null, last_reply_at: null }, []), groupNotices: [] };
}

/** What editing one message needs. */
export interface EditMessageInput {
  channelId: string;
  messageId: string;
  body: string;
  /**
   * Bring the message's mentions and links in line with the new text (a person's edit). A bot's edit passes false: the mentions and links the
   * message was posted with stay as they were, a name added later is plain text, and nobody is notified or woken.
   */
  syncRefs: boolean;
  /** As on posting: the editor confirmed that the `@here` / `@channel` this edit adds will notify a big room. */
  confirmBroadcast?: boolean;
}

/**
 * Replace the text of one of the caller's own messages — **the one path a channel message is edited on**: the edit route and the
 * `messages.update` capability both call it, so the permission, the `channel.message.edited` event and the live push are the same.
 * The caller is `app.actor()`: only the author may edit, a deleted message and an Answer cannot be edited.
 */
export async function editChannelMessage(deps: Deps, tx: PluginTx, input: EditMessageInput): Promise<ChannelMessage> {
  const { channelId, messageId, body } = input;
  const channel = await requireChannel(tx, channelId);
  const current = await findChannelMessage(tx, channelId, messageId);
  if (!current) throw notFound('No such message');
  if (current.authorId !== tx.actor.id) throw forbidden('You can only edit your own messages');
  if (current.deletedAt) throw conflict('That message was deleted');
  if (current.body === body) return current;
  // An answer's text is the payload's `body` (the Answer is drawn from it, and a shared copy was checked against its original): editing the
  // message would make the two differ, so a message that carries an Answer is deleted and shared again, never edited.
  const kind = (await tx.query<{ answer: boolean; poll: boolean }>("SELECT meta ? 'answer' AS answer, meta ? 'poll' AS poll FROM app.messages WHERE id = $1", [messageId])).rows[0];
  if (kind?.answer === true) throw conflict('An answer cannot be edited. Delete it and share the answer again.');
  // a poll's text is made from its question and options and the card is drawn from the poll: editing the message would make the two differ
  if (kind?.poll === true) throw conflict('A poll cannot be edited. Delete it and ask again.');
  await requirePost(tx, channel);
  const res = await tx.query(
    // the text of a voice message was written by the device or by hand; either way, once it is edited it says "edited" (P14-17)
    `UPDATE app.messages SET body = $3, body_plain = $4, edited_at = now(),
            meta = CASE WHEN meta ? 'voice' THEN jsonb_set(meta, '{voice,transcript}', '"edited"') ELSE meta END
      WHERE id = $1 AND channel_id = $2 RETURNING id`,
    [messageId, channelId, body, toPlainText(body)],
  );
  if (res.rows.length === 0) throw forbidden('You cannot edit this message');
  await deps.ctx.audit.emit(tx, {
    type: 'channel.message.edited',
    channelId,
    teamId: channel.team_id,
    messageId,
    editorId: tx.actor.id,
    threadRootId: current.threadRootId,
  });
  const edited = (await findChannelMessage(tx, channelId, messageId))!;
  await pushMessage(deps, tx, await audience(tx, channelId), 'message.edited', edited);
  if (input.syncRefs) {
    await syncMessageRefs(deps, tx, channel, { id: messageId, body, authorId: current.authorId, threadRootId: current.threadRootId, previousBody: current.body, ...(input.confirmBroadcast ? { confirmBroadcast: true } : {}) }, 'edit');
  }
  return edited;
}

/** What adding or removing one reaction needs. */
export interface ReactInput {
  channelId: string;
  messageId: string;
  emoji: string;
  add: boolean;
}

/**
 * Add or remove the caller's own reaction to a message — **the one path a reaction is changed on**: the two reaction routes and the `messages` provider
 * (the Slack-shaped API of the webhooks plugin) call it, so the event and the live push are the same. Adding needs the post permission, a live message and
 * a channel that is not archived; removing asks only for the caller's own row. `changed` is false when nothing was there to add or remove.
 */
export async function reactToMessage(deps: Deps, tx: PluginTx, input: ReactInput): Promise<{ changed: boolean; reactions: ReactionSummary[] }> {
  const { channelId, messageId, emoji } = input;
  const channel = await requireChannel(tx, channelId);
  if (input.add) {
    const message = await findChannelMessage(tx, channelId, messageId);
    if (!message) throw notFound('No such message');
    if (message.deletedAt) throw conflict('That message was deleted');
    await requirePost(tx, channel);
  }
  const res = await tx.query(
    input.add
      ? `INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id) VALUES ($1, app.actor(), $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`
      : 'DELETE FROM app.message_reactions WHERE message_id = $1 AND actor_id = app.actor() AND emoji = $2 AND channel_id = $3 RETURNING message_id',
    [messageId, emoji, channelId],
  );
  const changed = res.rows.length > 0;
  const reactions = (await reactionsFor(tx, [messageId])).get(messageId) ?? [];
  if (changed) {
    await deps.ctx.audit.emit(tx, { type: 'channel.reaction.changed', channelId, teamId: channel.team_id, messageId, actorId: tx.actor.id, emoji, added: input.add });
    await pushReaction(deps, tx, await audience(tx, channelId), {
      channelId,
      messageId,
      actorId: tx.actor.id,
      emoji,
      added: input.add,
      count: reactions.find((r) => r.emoji === emoji)?.count ?? (input.add ? 1 : 0),
    } as ReactionChangedPush);
  }
  return { changed, reactions };
}
