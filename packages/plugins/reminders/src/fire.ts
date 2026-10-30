import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { RemindersReminderDueEvent } from '@manythreads/shared';

/** The job that fires due reminders: every minute (the cron grid of the job queue; 5-field cron in UTC). */
export const FIRE_QUEUE = 'reminders.fire_due';
export const FIRE_CRON = '* * * * *';

/** At most this many reminders are fired per run; the next minute takes the rest. */
export const FIRE_BATCH = 500;

interface Fired extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  person_id: string;
  message_id: string;
  channel_id: string;
}

/**
 * Fires the reminders whose time has come, as the system actor. Each item is claimed and marked fired in one statement (`fired_at`; rows another
 * run holds are skipped), and in the same transaction a `reminders.reminder.due` event is written for it, so a reminder is announced once even if
 * the job runs twice or the transaction is retried. An item whose message was deleted or removed is marked fired and announced to nobody. A person
 * who lost access to the channel still gets the event (ids only); the notifications plugin checks access when it handles it and writes nothing.
 * Returns how many events were written.
 */
export async function fireDue(ctx: PluginContext, tx: PluginTx, now: Date): Promise<number> {
  const claimed = await tx.query<Fired>(
    `WITH due AS (
       SELECT id FROM app.later_items
        WHERE state = 'open' AND fired_at IS NULL AND remind_at IS NOT NULL AND remind_at <= $1::timestamptz
        ORDER BY remind_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE app.later_items i SET fired_at = $1::timestamptz, updated_at = now()
       FROM due WHERE i.id = due.id
     RETURNING i.id, i.workspace_id, i.person_id, i.message_id, i.channel_id`,
    [now, FIRE_BATCH],
  );
  if (claimed.rows.length === 0) return 0;

  // Only a message that still exists is announced. Whether the person can still read its channel is checked by the notifications plugin when it
  // handles the event (`app.channel_audience` needs the workspace of the transaction, which a cron job does not have, and a plugin may not set it):
  // the event carries ids only, so an announcement the person may no longer read leaks nothing and becomes no notification.
  const ok = await tx.query<{ id: string }>(
    `SELECT i.id FROM app.later_items i JOIN app.messages m ON m.id = i.message_id AND m.deleted_at IS NULL WHERE i.id = ANY ($1::uuid[])`,
    [claimed.rows.map((r) => r.id)],
  );
  const live = new Set(ok.rows.map((r) => r.id));
  let announced = 0;
  for (const r of claimed.rows) {
    if (!live.has(r.id)) continue;
    await ctx.audit.emit(
      tx,
      RemindersReminderDueEvent.parse({
        type: 'reminders.reminder.due',
        schemaVersion: 1,
        workspaceId: r.workspace_id,
        personId: r.person_id,
        itemId: r.id,
        messageId: r.message_id,
        channelId: r.channel_id,
      }),
    );
    announced += 1;
  }
  return announced;
}
