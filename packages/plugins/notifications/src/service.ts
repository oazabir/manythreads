import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  NotificationCreatedPush,
  NotificationsNotificationCreatedEvent,
  notificationCreatedPushType,
  type NotificationKind,
} from '@manythreads/shared';
import { normalizePrefs, wantsInApp } from './prefs.ts';
import { NOTIFICATION_COLUMNS, toNotification, type NotificationRow } from './rows.ts';

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
    author_name: string | null;
    body_plain: string;
    deleted_at: Date | null;
  }>(
    `SELECT m.id, m.workspace_id, m.channel_id, c.kind AS channel_kind, m.thread_root_id, m.author_id, m.body_plain, m.deleted_at,
            a.ref_id AS author_person_id, p.display_name AS author_name
       FROM app.messages m
       JOIN app.channels c ON c.id = m.channel_id
       LEFT JOIN app.actors a ON a.id = m.author_id AND a.kind = 'person'
       LEFT JOIN app.people p ON p.id = a.ref_id
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
    authorName: r.author_name ?? 'Bot',
    bodyPlain: r.body_plain,
    deleted: r.deleted_at !== null,
  };
}

const RANK = "(CASE %K WHEN 'mention' THEN 3 WHEN 'reply' THEN 2 ELSE 1 END)";

/**
 * Makes the notifications of one message for `personIds`, as the system actor (the consumer's transaction). Who is left out: the author,
 * anyone who cannot read the channel, anyone who turned that kind off in the app, anyone who muted the channel (a muted membership or
 * a muted channel in their settings). Everyone else gets one row per message: the insert is an upsert on (person, message) that only
 * writes when the row is new or the new kind is stronger than the stored one (mention > reply > dm), so a redelivered event or the
 * second event of the same message writes nothing, and writes nothing is announced nowhere. Each row written is pushed to the person's
 * sockets (`notification.created`) and announced as `notifications.notification.created`.
 */
export async function deliver(ctx: PluginContext, tx: PluginTx, message: MessageFacts, kind: NotificationKind, personIds: readonly string[]): Promise<void> {
  const candidates = [...new Set(personIds)].filter((id) => id !== message.authorPersonId);
  if (candidates.length === 0) return;

  const audience = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [message.channelId]);
  const canRead = new Set(audience.rows.map((r) => r.person_id));
  const readers = candidates.filter((id) => canRead.has(id));
  if (readers.length === 0) return;

  const settings = await tx.query<{ person_id: string; prefs: unknown; muted: boolean }>(
    `SELECT w.person_id, np.prefs, coalesce(cm.muted, false) AS muted
       FROM unnest($1::uuid[]) AS w(person_id)
       LEFT JOIN app.notification_prefs np ON np.person_id = w.person_id
       LEFT JOIN app.channel_members cm ON cm.channel_id = $2::uuid AND cm.person_id = w.person_id`,
    [readers, message.channelId],
  );
  const prefsOf = new Map<string, ReturnType<typeof normalizePrefs>>();
  const wanted: string[] = [];
  for (const s of settings.rows) {
    const prefs = normalizePrefs(s.prefs);
    prefsOf.set(s.person_id, prefs);
    if (!s.muted && wantsInApp(prefs, kind, message.channelId)) wanted.push(s.person_id);
  }
  if (wanted.length === 0) return;

  const written = await tx.query<{ id: string; person_id: string }>(
    `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, thread_root_id, actor_id, actor_name, preview)
     SELECT $1::uuid, w.person_id, $2, 'message', $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8 FROM unnest($9::uuid[]) AS w(person_id)
     ON CONFLICT (person_id, ref_type, ref_id) DO UPDATE SET kind = EXCLUDED.kind
       WHERE ${RANK.replace('%K', 'EXCLUDED.kind')} > ${RANK.replace('%K', 'n.kind')}
     RETURNING n.id, n.person_id`,
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
    ],
  );
  if (written.rows.length === 0) return;

  const ids = written.rows.map((r) => r.id);
  const rows = await tx.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id WHERE n.id = ANY ($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  for (const w of written.rows) {
    const row = byId.get(w.id);
    if (!row) continue;
    const notification = toNotification(row);
    await ctx.realtime.pushToPerson(
      tx,
      w.person_id,
      notificationCreatedPushType,
      NotificationCreatedPush.parse({
        notification,
        browser: prefsOf.get(w.person_id)?.[notification.kind].browser ?? false,
      }),
    );
    await ctx.audit.emit(
      tx,
      NotificationsNotificationCreatedEvent.parse({
        type: 'notifications.notification.created',
        schemaVersion: 1,
        workspaceId: message.workspaceId,
        notificationId: notification.id,
        personId: w.person_id,
        kind: notification.kind,
        refType: notification.refType,
        refId: notification.refId,
        channelId: notification.channelId,
        actorId: notification.actorId,
      }),
    );
  }
}
