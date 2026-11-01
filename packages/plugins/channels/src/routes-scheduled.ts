import { HttpError, type PluginTx } from '@manythreads/sdk';
import {
  CancelScheduledResponse,
  EditScheduledRequest,
  EditScheduledResponse,
  ListScheduledResponse,
  ScheduleMessageRequest,
  ScheduleMessageResponse,
  ScheduledChannelPathParams,
  ScheduledItemPathParams,
  cancelScheduledRoute,
  checkSendAt,
  editScheduledRoute,
  listAllScheduledRoute,
  listScheduledRoute,
  scheduleMessageRoute,
} from '@manythreads/shared';
import { conflict, invalid, json, notFound, route } from './http.ts';
import { SCHEDULED_COLUMNS, toScheduledMessage, type ScheduledRow } from './rows.ts';
import { emitChanged, pushChanged } from './scheduled.ts';
import { myPersonId, requireChannel, requirePost, type Deps } from './service.ts';

/** The signed-in person (people.id); scheduled messages belong to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const id = await myPersonId(tx);
  if (!id) throw new HttpError(403, 'forbidden', 'Scheduled messages belong to people');
  return id;
}

/**
 * Scheduled send (PLAN P14-05): the caller's own scheduled messages in a channel. Four routes, all on the caller's own rows; the row-level
 * security of `scheduled_messages` makes that true even if a query forgot to say so. The job that posts them is `scheduled.ts`.
 */
export function registerScheduledRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...listScheduledRoute,
    schema: { response: ListScheduledResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ScheduledChannelPathParams.parse(req.params);
      await callerPerson(tx);
      // no right to read the channel is asked: a message that could not be sent because its author lost access must stay findable (the policy limits this to their own rows)
      const res = await tx.query<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM app.scheduled_messages WHERE channel_id = $1 AND author_id = app.actor() ORDER BY send_at, id`,
        [channelId],
      );
      return json(ListScheduledResponse.parse({ items: res.rows.map(toScheduledMessage) }));
    }),
  });

  ctx.http.route({
    ...listAllScheduledRoute,
    schema: { response: ListScheduledResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await callerPerson(tx);
      const res = await tx.query<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM app.scheduled_messages WHERE author_id = app.actor() ORDER BY send_at, id LIMIT 200`,
      );
      return json(ListScheduledResponse.parse({ items: res.rows.map(toScheduledMessage) }));
    }),
  });

  ctx.http.route({
    ...scheduleMessageRoute,
    schema: { body: ScheduleMessageRequest, response: ScheduleMessageResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ScheduledChannelPathParams.parse(req.params);
      const body = ScheduleMessageRequest.parse(req.body);
      const personId = await callerPerson(tx);
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      if (channel.kind === 'bot_conversation') throw invalid('A conversation with a bot cannot hold scheduled messages');
      if (body.body.trim() === '') throw invalid('body: write something to send');
      const when = checkSendAt(body.sendAt, ctx.runtime.now());
      if (!when.ok) throw invalid(`sendAt: ${when.reason}`);
      if (body.threadRootId) {
        const root = (
          await tx.query<{ thread_root_id: string | null; deleted_at: Date | null }>('SELECT thread_root_id, deleted_at FROM app.messages WHERE id = $1 AND channel_id = $2', [
            body.threadRootId,
            channelId,
          ])
        ).rows[0];
        if (!root) throw notFound('No such message to reply to in this channel');
        if (root.thread_root_id) throw conflict('Reply to the first message of the thread, not to a reply');
        if (root.deleted_at) throw conflict('That message was deleted');
      }
      const res = await tx.query<ScheduledRow>(
        `INSERT INTO app.scheduled_messages (workspace_id, channel_id, author_id, thread_root_id, team_id, body, send_at)
         VALUES (app.workspace_id(), $1, app.actor(), $2, $3, $4, $5::timestamptz) RETURNING ${SCHEDULED_COLUMNS}`,
        [channelId, body.threadRootId ?? null, channel.team_id, body.body, when.at],
      );
      const row = res.rows[0]!;
      await emitChanged(deps, tx, { id: row.id, workspaceId: tx.actor.workspaceId, channelId, teamId: channel.team_id, authorId: tx.actor.id }, 'scheduled');
      await pushChanged(deps, tx, personId, channelId, 'scheduled');
      return json(ScheduleMessageResponse.parse(toScheduledMessage(row)), 201);
    }),
  });

  ctx.http.route({
    ...editScheduledRoute,
    schema: { body: EditScheduledRequest, response: EditScheduledResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, scheduledId } = ScheduledItemPathParams.parse(req.params);
      const body = EditScheduledRequest.parse(req.body);
      const personId = await callerPerson(tx);
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      // locked, so an edit and the send job's post of the same row take turns (the job skips a row an edit holds)
      const current = (
        await tx.query<ScheduledRow>(
          `SELECT ${SCHEDULED_COLUMNS} FROM app.scheduled_messages WHERE id = $1 AND channel_id = $2 AND author_id = app.actor() FOR UPDATE`,
          [scheduledId, channelId],
        )
      ).rows[0];
      if (!current) throw notFound('No such scheduled message');
      const text = body.body ?? current.body;
      if (text.trim() === '') throw invalid('body: write something to send');
      const when = checkSendAt(body.sendAt ?? current.send_at.toISOString(), ctx.runtime.now());
      if (!when.ok) throw invalid(`sendAt: ${when.reason}`);
      // editing a refused message schedules it again: its reason goes, and a failed-send count starts over
      const res = await tx.query<ScheduledRow>(
        `UPDATE app.scheduled_messages
            SET body = $2, send_at = $3::timestamptz, state = 'scheduled', refused_reason = NULL, refused_at = NULL, attempts = 0, retry_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING ${SCHEDULED_COLUMNS}`,
        [scheduledId, text, when.at],
      );
      const row = res.rows[0]!;
      await emitChanged(deps, tx, { id: row.id, workspaceId: tx.actor.workspaceId, channelId, teamId: channel.team_id, authorId: tx.actor.id }, 'edited');
      await pushChanged(deps, tx, personId, channelId, 'edited');
      return json(EditScheduledResponse.parse(toScheduledMessage(row)));
    }),
  });

  ctx.http.route({
    ...cancelScheduledRoute,
    schema: { response: CancelScheduledResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, scheduledId } = ScheduledItemPathParams.parse(req.params);
      const personId = await callerPerson(tx);
      // no post permission is asked: someone who lost access to the channel can still remove what they left in it
      // the team comes from the row (copied when it was scheduled): the author may not read the channel any more
      const res = await tx.query<{ team_id: string | null }>(
        'DELETE FROM app.scheduled_messages WHERE id = $1 AND channel_id = $2 AND author_id = app.actor() RETURNING team_id',
        [scheduledId, channelId],
      );
      const gone = res.rows[0];
      if (gone) {
        await emitChanged(deps, tx, { id: scheduledId, workspaceId: tx.actor.workspaceId, channelId, teamId: gone.team_id, authorId: tx.actor.id }, 'cancelled');
        await pushChanged(deps, tx, personId, channelId, 'cancelled');
      }
      return json(CancelScheduledResponse.parse({ cancelled: gone !== undefined }));
    }),
  });
}
