import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { NotificationLevel, effectiveLevel, levelAllows, type NotificationKind } from '@manythreads/shared';
import { announce } from './announce.ts';
import { quietPeople } from './hold.ts';
import { workspaceDefaultLevel } from './levels.ts';
import { normalizePrefs, wantsInApp } from './prefs.ts';

const PREVIEW_MAX = 140;

/** The message a notification is about, with what the consumer needs to judge and word it. */
export interface MessageFacts {
  id: string;
  workspaceId: string;
  channelId: string;
  channelKind: string;
  threadRootId: string | null;
  authorActorId: string;
  /** The author's `people.id`; null for a bot. */
  authorPersonId: string | null;
  authorName: string;
  bodyPlain: string;
  deleted: boolean;
}

/** One line of at most 140 characters from a message's plain text. */
export function previewOf(plain: string): string {
  const line = plain.replace(/\s+/g, ' ').trim();
  if (line === '') return 'New message';
  const chars = [...line];
  return chars.length > PREVIEW_MAX ? `${chars.slice(0, PREVIEW_MAX - 1).join('')}…` : line;
}

export async function loadMessage(tx: PluginTx, messageId: string): Promise<MessageFacts | null> {
  const res = await tx.query<{
    id: string;
    workspace_id: string;
    channel_id: string;
    channel_kind: string;
    thread_root_id: string | null;
    author_id: string;
    author_person_id: string | null;
    person_name: string | null;
    bot_name: string | null;
    bot_slug: string | null;
    body_plain: string;
    deleted_at: Date | null;
  }>(
    // The author is a person or a bot, so both are looked up: a person's display name, and a bot's own name from the bots plugin's row
    // (its actor's `ref_id` is the bot row). A bot of no row (deleted, or the bots plugin absent) keeps the old generic label.
    `SELECT m.id, m.workspace_id, m.channel_id, c.kind AS channel_kind, m.thread_root_id, m.author_id, m.body_plain, m.deleted_at,
            pa.ref_id AS author_person_id, p.display_name AS person_name, b.name AS bot_name, b.slug AS bot_slug
       FROM app.messages m
       JOIN app.channels c ON c.id = m.channel_id
       LEFT JOIN app.actors pa ON pa.id = m.author_id AND pa.kind = 'person'
       LEFT JOIN app.people p ON p.id = pa.ref_id
       LEFT JOIN app.actors ba ON ba.id = m.author_id AND ba.kind = 'bot'
       LEFT JOIN app.bots b ON b.id = ba.ref_id AND b.workspace_id = m.workspace_id
      WHERE m.id = $1`,
    [messageId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    channelKind: r.channel_kind,
    threadRootId: r.thread_root_id,
    authorActorId: r.author_id,
    authorPersonId: r.author_person_id,
    authorName: r.person_name ?? r.bot_name ?? r.bot_slug ?? 'Bot',
    bodyPlain: r.body_plain,
    deleted: r.deleted_at !== null,
  };
}

// How strong a notification is: its kind, and within a kind being named beats a keyword (so a person named in a message that also holds their
// keyword is told they were named). Equal strength writes nothing, which is what makes a redelivered event a no-op.
const RANK = "((CASE %K WHEN 'mention' THEN 6 WHEN 'reply' THEN 4 WHEN 'dm' THEN 2 ELSE 0 END) + (CASE WHEN %W IS NULL THEN 1 ELSE 0 END))";
const rankOf = (kind: string, keyword: string): string => RANK.replace('%K', kind).replace('%W', keyword);

export interface DeliverOptions {
  /** For a `mention` made by a keyword: the keyword that matched, by person. A person not in the map was named. */
  keywords?: ReadonlyMap<string, string>;
}

/**
 * Makes the notifications of one message for `personIds`, as the system actor (the consumer's transaction). Who is left out: the author,
 * anyone who cannot read the channel, anyone who turned that kind off in the app, anyone who muted the channel (a muted membership or
 * a muted channel in their settings), and anyone whose level for this channel does not allow the kind (`levelAllows`: "nothing" allows none, "mentions" allows
 * mentions, keywords and followed threads, "all" allows everything; a channel with no choice of theirs follows the workspace default, a direct message "all"). Everyone else gets one row per message: the insert is an upsert on (person, message) that only
 * writes when the row is new or the new kind is stronger than the stored one (mention > reply > dm), so a redelivered event or the
 * second event of the same message writes nothing, and writes nothing is announced nowhere. Each row written is pushed to the person's
 * sockets (`notification.created`) and announced as `notifications.notification.created` (`announce`) -- except for a person who has Do not
 * disturb on: their row is written held and announced when it ends.
 */
export async function deliver(
  ctx: PluginContext,
  tx: PluginTx,
  message: MessageFacts,
  kind: NotificationKind,
  personIds: readonly string[],
  options: DeliverOptions = {},
): Promise<void> {
  const candidates = [...new Set(personIds)].filter((id) => id !== message.authorPersonId);
  if (candidates.length === 0) return;

  const audience = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [message.channelId]);
  const canRead = new Set(audience.rows.map((r) => r.person_id));
  const readers = candidates.filter((id) => canRead.has(id));
  if (readers.length === 0) return;

  const settings = await tx.query<{ person_id: string; prefs: unknown; muted: boolean; level: string | null }>(
    `SELECT w.person_id, np.prefs, coalesce(cm.muted, false) AS muted, nl.level
       FROM unnest($1::uuid[]) AS w(person_id)
       LEFT JOIN app.notification_prefs np ON np.person_id = w.person_id
       LEFT JOIN app.channel_members cm ON cm.channel_id = $2::uuid AND cm.person_id = w.person_id
       LEFT JOIN app.notification_levels nl ON nl.channel_id = $2::uuid AND nl.person_id = w.person_id`,
    [readers, message.channelId],
  );
  const workspaceDefault = await workspaceDefaultLevel(tx, message.workspaceId);
  const prefsOf = new Map<string, ReturnType<typeof normalizePrefs>>();
  const wanted: string[] = [];
  for (const s of settings.rows) {
    const prefs = normalizePrefs(s.prefs);
    prefsOf.set(s.person_id, prefs);
    const own = NotificationLevel.safeParse(s.level);
    const level = effectiveLevel(own.success ? own.data : null, message.channelKind, workspaceDefault);
    if (!s.muted && levelAllows(level, kind) && wantsInApp(prefs, kind, message.channelId)) wanted.push(s.person_id);
  }
  if (wanted.length === 0) return;

  // Who is on Do not disturb right now: their rows are written all the same, held, and announced when it ends (hold.ts).
  const quiet = await quietPeople(tx, wanted, ctx.runtime.now());

  const written = await tx.query<{ id: string; person_id: string; held_at: Date | null }>(
    `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, thread_root_id, actor_id, actor_name, preview, keyword, held_at)
     SELECT $1::uuid, w.person_id, $2, 'message', $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, w.keyword, CASE WHEN w.person_id = ANY ($10::uuid[]) THEN now() END
       FROM unnest($9::uuid[], $11::text[]) AS w(person_id, keyword)
     ON CONFLICT (person_id, ref_type, ref_id) DO UPDATE SET kind = EXCLUDED.kind, keyword = EXCLUDED.keyword
       WHERE ${rankOf('EXCLUDED.kind', 'EXCLUDED.keyword')} > ${rankOf('n.kind', 'n.keyword')}
     RETURNING n.id, n.person_id, n.held_at`,
    [
      message.workspaceId,
      kind,
      message.id,
      message.channelId,
      message.threadRootId,
      message.authorActorId,
      message.authorName,
      previewOf(message.bodyPlain),
      wanted,
      [...quiet],
      wanted.map((id) => options.keywords?.get(id) ?? null),
    ],
  );
  // A row that is held (new, or a stronger kind raising a row that was already held) is announced when it is released, not now.
  await announce(ctx, tx, message.workspaceId, written.rows.filter((r) => r.held_at === null), prefsOf);
}
