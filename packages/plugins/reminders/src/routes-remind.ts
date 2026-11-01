import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CancelReminderResponse,
  CreateReminderRequest,
  ListRemindersQuery,
  ListRemindersResponse,
  Reminder,
  ReminderPathParams,
  RemindersReminderChangedEvent,
  REMINDERS_HISTORY_DAYS,
  cancelReminderRoute,
  checkRemindAt,
  createReminderRoute,
  listRemindersRoute,
  type ReminderTargetKind,
} from '@manythreads/shared';
import { forbidden, invalid, json, route } from './http.ts';

/** The signed-in person (people.id); reminders belong to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Reminders belong to people');
  return row.id;
}

interface ReminderRow extends Record<string, unknown> {
  id: string;
  target_kind: ReminderTargetKind;
  target_person_id: string | null;
  person_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  text: string;
  remind_at: Date;
  state: 'pending' | 'sent' | 'cancelled' | 'refused';
  refused_reason: string | null;
  created_at: Date;
  sent_at: Date | null;
}

/** `app.reminders` joined to the names the caller may read: a person's name, and a channel's name when the caller can still read the channel. */
const COLUMNS = `r.id, r.target_kind, r.target_person_id, p.display_name AS person_name, r.channel_id, c.name AS channel_name,
  r.text, r.remind_at, r.state, r.refused_reason, r.created_at, r.sent_at`;
const FROM = `FROM app.reminders r
  LEFT JOIN app.people p ON p.id = r.target_person_id
  LEFT JOIN app.channels c ON c.id = r.channel_id`;

function toReminder(r: ReminderRow): Reminder {
  return Reminder.parse({
    id: r.id,
    targetKind: r.target_kind,
    person: r.target_person_id ? { id: r.target_person_id, name: r.person_name ?? 'Someone' } : null,
    channel: r.channel_id && r.channel_name !== null ? { id: r.channel_id, name: r.channel_name } : null,
    text: r.text,
    remindAt: r.remind_at.toISOString(),
    state: r.state,
    refusedReason: r.refused_reason,
    createdAt: r.created_at.toISOString(),
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
  });
}

/** `reminders.reminder.changed` as the caller. Ids only: no text, no time, no reason. */
async function emitChanged(
  ctx: PluginContext,
  tx: PluginTx,
  ref: { id: string; creatorId: string; targetKind: ReminderTargetKind; targetPersonId: string | null },
  change: 'created' | 'cancelled',
): Promise<void> {
  await ctx.audit.emit(
    tx,
    RemindersReminderChangedEvent.parse({
      type: 'reminders.reminder.changed',
      schemaVersion: 1,
      workspaceId: (await tx.query<{ id: string }>('SELECT app.workspace_id() AS id')).rows[0]!.id,
      reminderId: ref.id,
      creatorId: ref.creatorId,
      targetKind: ref.targetKind,
      recipientId: ref.targetKind === 'me' ? ref.creatorId : ref.targetPersonId,
      change,
    }),
  );
}

/**
 * `/remind` (PLAN P14-04): the caller's own reminders. Three routes, all on the caller's own rows; the row-level security and the triggers of
 * `app.reminders` make that, and the budget, true even if a query forgot to say so. The job that delivers them is send.ts.
 */
export function registerRemindRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listRemindersRoute,
    schema: { query: ListRemindersQuery, response: ListRemindersResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { state } = ListRemindersQuery.parse(req.query);
      const person = await callerPerson(tx);
      const res =
        state === 'pending'
          ? await tx.query<ReminderRow>(`SELECT ${COLUMNS} ${FROM} WHERE r.creator_id = $1::uuid AND r.state = 'pending' ORDER BY r.remind_at, r.id LIMIT 100`, [person])
          : await tx.query<ReminderRow>(
              `SELECT ${COLUMNS} ${FROM} WHERE r.creator_id = $1::uuid AND r.state <> 'pending' AND r.updated_at > now() - make_interval(days => $2::int)
                ORDER BY r.updated_at DESC, r.id DESC LIMIT 100`,
              [person, REMINDERS_HISTORY_DAYS],
            );
      const pending = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.reminders WHERE creator_id = $1::uuid AND state = 'pending'", [person])).rows[0]!.n;
      return json(ListRemindersResponse.parse({ items: res.rows.map(toReminder), pendingCount: pending }));
    }),
  });

  ctx.http.route({
    ...createReminderRoute,
    schema: { body: CreateReminderRequest, response: Reminder },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = CreateReminderRequest.parse(req.body ?? {});
      const person = await callerPerson(tx);
      const check = checkRemindAt(body.remindAt, ctx.runtime.now());
      if (!check.ok) throw invalid(check.reason);
      const { target } = body;
      const targetPerson = target.kind === 'person' ? target.personId : null;
      const channelId = target.kind === 'me' ? null : target.channelId;
      let id: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, target_person_id, channel_id, text, remind_at)
           VALUES (app.workspace_id(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::timestamptz) RETURNING id`,
          [person, target.kind, targetPerson, channelId, body.text, check.at],
        );
        id = inserted.rows[0]!.id;
      } catch (err) {
        // a row-level-security refusal: the place is not one the caller may use for this
        if ((err as { code?: string } | null)?.code === '42501') {
          throw forbidden(target.kind === 'channel' ? 'You cannot post in that channel, so you cannot set a reminder for it.' : 'You cannot read that conversation.');
        }
        throw err;
      }
      await emitChanged(ctx, tx, { id, creatorId: person, targetKind: target.kind, targetPersonId: targetPerson }, 'created');
      const row = (await tx.query<ReminderRow>(`SELECT ${COLUMNS} ${FROM} WHERE r.id = $1::uuid`, [id])).rows[0]!;
      return json(toReminder(row), 201);
    }),
  });

  ctx.http.route({
    ...cancelReminderRoute,
    schema: { response: CancelReminderResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { reminderId } = ReminderPathParams.parse(req.params);
      const person = await callerPerson(tx);
      const res = await tx.query<{ target_kind: ReminderTargetKind; target_person_id: string | null }>(
        `UPDATE app.reminders SET state = 'cancelled', updated_at = now()
          WHERE id = $1::uuid AND creator_id = $2::uuid AND state = 'pending' RETURNING target_kind, target_person_id`,
        [reminderId, person],
      );
      const row = res.rows[0];
      if (row) await emitChanged(ctx, tx, { id: reminderId, creatorId: person, targetKind: row.target_kind, targetPersonId: row.target_person_id }, 'cancelled');
      return json(CancelReminderResponse.parse({ cancelled: row !== undefined }));
    }),
  });
}
