import type { PluginContext, PluginTx, RealtimePush } from '@manythreads/sdk';
import {
  NotificationCreatedPush,
  NotificationsNotificationCreatedEvent,
  notificationCreatedPushType,
  type NotificationPrefs,
} from '@manythreads/shared';
import { NOTIFICATION_COLUMNS, toNotification, type NotificationRow } from './rows.ts';

/**
 * Tells people about notification rows that are visible to them: a live push to their sockets (`notification.created`, upsert by id) and the
 * `notifications.notification.created` event, which mobile push and mail channels subscribe to. Used when a row is written and, for a held
 * row, when it is released.
 */
export async function announce(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
  written: ReadonlyArray<{ id: string; person_id: string }>,
  prefsOf: ReadonlyMap<string, NotificationPrefs>,
): Promise<void> {
  if (written.length === 0) return;
  const ids = written.map((r) => r.id);
  const rows = await tx.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id WHERE n.id = ANY ($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  // Each person's card differs (their own row and browser preference), so the pushes are batched, not broadcast: one statement for all.
  const pushes: RealtimePush[] = [];
  for (const w of written) {
    const row = byId.get(w.id);
    if (!row) continue;
    const notification = toNotification(row);
    pushes.push({
      personId: w.person_id,
      type: notificationCreatedPushType,
      payload: NotificationCreatedPush.parse({
        notification,
        browser: prefsOf.get(w.person_id)?.[notification.kind].browser ?? false,
      }),
    });
    await ctx.audit.emit(
      tx,
      NotificationsNotificationCreatedEvent.parse({
        type: 'notifications.notification.created',
        schemaVersion: 1,
        workspaceId,
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
  await ctx.realtime.pushMany(tx, pushes);
}
