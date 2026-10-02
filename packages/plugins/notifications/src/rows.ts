import { Notification } from '@manythreads/shared';

/** A notification joined with its channel (name and kind), as `NOTIFICATION_COLUMNS` selects it. */
export interface NotificationRow extends Record<string, unknown> {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  thread_root_id: string | null;
  actor_id: string;
  actor_name: string;
  preview: string;
  read_at: Date | null;
  created_at: Date;
}

/** `FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id` */
export const NOTIFICATION_COLUMNS =
  'n.id, n.kind, n.ref_type, n.ref_id, n.channel_id, c.name AS channel_name, c.kind AS channel_kind, n.thread_root_id, n.actor_id, n.actor_name, n.preview, n.read_at, n.created_at';

/** The one place a `notifications` row becomes the shared `Notification`. */
export const toNotification = (r: NotificationRow): Notification =>
  Notification.parse({
    id: r.id,
    kind: r.kind,
    refType: r.ref_type,
    refId: r.ref_id,
    channelId: r.channel_id,
    channelName: r.channel_name === '' ? null : r.channel_name,
    channelKind: r.channel_kind,
    threadRootId: r.thread_root_id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    preview: r.preview,
    readAt: r.read_at ? r.read_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  });
