import type { PluginContext, PluginTx, RealtimePush } from '@manythreads/sdk';
import {
  NotificationCreatedPush,
  NotificationsNotificationCreatedEvent,
  notificationCreatedPushType,
  type NotificationPrefs,
} from '@manythreads/shared';
import { prefKey } from './prefs.ts';
import { PUSH_QUEUE } from './push.ts';
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
        browser: prefsOf.get(w.person_id)?.[prefKey(notification.kind)].browser ?? false,
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

  // Browser push: a person who signed a browser up gets one job per notification, sent outside this transaction (a push service can be slow).
  const subscribed = await tx.query<{ person_id: string }>('SELECT DISTINCT person_id FROM app.push_subscriptions WHERE person_id = ANY ($1::uuid[])', [
    [...new Set(written.map((w) => w.person_id))],
  ]);
  const withPush = new Set(subscribed.rows.map((r) => r.person_id));
  for (const w of written) {
    if (!withPush.has(w.person_id) || !byId.has(w.id)) continue;
    await ctx.jobs.enqueue(tx, PUSH_QUEUE, { workspaceId, notificationId: w.id, personId: w.person_id }, { dedupeKey: `push:${w.id}` });
  }
}
