import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  LATER_MAX_ITEMS,
  LaterItem,
  LaterItemPathParams,
  LaterMessagePathParams,
  ListLaterQuery,
  ListLaterResponse,
  RemoveLaterResponse,
  SaveLaterRequest,
  UpdateLaterRequest,
  checkRemindAt,
  listLaterRoute,
  removeLaterRoute,
  saveLaterRoute,
  updateLaterRoute,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { LATER_COLUMNS, toLaterItem, type LaterRow } from './rows.ts';

/** The signed-in person (people.id); Later belongs to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Later belongs to people');
  return row.id;
}

const FROM = `FROM app.later_items l
  LEFT JOIN app.messages m ON m.id = l.message_id
  LEFT JOIN app.channels c ON c.id = m.channel_id`;

/** The authors' names of the messages, for what the caller can read (the channels plugin's definer function `app.message_authors`). */
async function authorNames(tx: PluginTx, messageIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messageIds.length === 0) return out;
  const res = await tx.query<{ actor_id: string; display_name: string }>('SELECT actor_id, display_name FROM app.message_authors($1::uuid[])', [messageIds.slice(0, 500)]);
  for (const r of res.rows) out.set(r.actor_id, r.display_name);
  return out;
}

/** Items as the caller sees them. Rows are read through the caller's own policies, so what they cannot read comes back as "no longer available". */
async function loadItems(tx: PluginTx, where: string, params: unknown[], now: Date, order = 'l.id DESC'): Promise<LaterItem[]> {
  const res = await tx.query<LaterRow>(`SELECT ${LATER_COLUMNS} ${FROM} WHERE l.person_id = app.person_id() AND ${where} ORDER BY ${order}`, params);
  const authors = await authorNames(tx, res.rows.filter((r) => r.readable).map((r) => r.message_id));
  return res.rows.map((r) => toLaterItem(r, authors, now));
}

/**
 * Later and reminders: the caller's saved messages. Four routes, all on the caller's own items; the row-level security of `later_items`
 * makes that true even if a query forgot to say so. The reminders job (fire.ts) turns a due reminder into an event.
 */
export function registerLaterRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listLaterRoute,
    schema: { query: ListLaterQuery, response: ListLaterResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { state } = ListLaterQuery.parse(req.query);
      await callerPerson(tx);
      const now = ctx.runtime.now();
      // Open items: the due ones first (the oldest reminder first), then the rest newest first. Done items: the latest finished first.
      const items =
        state === 'open'
          ? await loadItems(
              tx,
              'l.state = $1',
              [state, now],
              now,
              '(l.remind_at IS NOT NULL AND l.remind_at <= $2::timestamptz) DESC, CASE WHEN l.remind_at <= $2::timestamptz THEN l.remind_at END ASC, l.id DESC',
            )
          : await loadItems(tx, 'l.state = $1', [state], now, 'l.done_at DESC, l.id DESC');
      const counts = (
        await tx.query<{ open_count: number; due_count: number }>(
          `SELECT count(*) FILTER (WHERE state = 'open')::int AS open_count,
                  count(*) FILTER (WHERE state = 'open' AND remind_at IS NOT NULL AND remind_at <= $1::timestamptz)::int AS due_count
             FROM app.later_items WHERE person_id = app.person_id()`,
          [now],
        )
      ).rows[0]!;
      return json(ListLaterResponse.parse({ items, openCount: counts.open_count, dueCount: counts.due_count }));
    }),
  });

  ctx.http.route({
    ...saveLaterRoute,
    schema: { body: SaveLaterRequest, response: LaterItem },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { messageId } = LaterMessagePathParams.parse(req.params);
      const body = SaveLaterRequest.parse(req.body ?? {});
      const person = await callerPerson(tx);
      const now = ctx.runtime.now();

      let remindAt: Date | null = null;
      if (body.remindAt !== undefined && body.remindAt !== null) {
        const check = checkRemindAt(body.remindAt, now);
        if (!check.ok) throw invalid(check.reason);
        remindAt = check.at;
      }

      // The message must be one the caller can read (an unknown id and a private channel look the same), and must still exist.
      const msg = (
        await tx.query<{ channel_id: string; thread_root_id: string | null; deleted_at: Date | null }>(
          'SELECT m.channel_id, m.thread_root_id, m.deleted_at FROM app.messages m WHERE m.id = $1::uuid',
          [messageId],
        )
      ).rows[0];
      if (!msg) throw forbidden('You cannot see this message');
      if (msg.deleted_at) throw notFound('This message is no longer there');

      const existing = (await tx.query<{ id: string }>('SELECT id FROM app.later_items WHERE person_id = $1::uuid AND message_id = $2::uuid', [person, messageId])).rows[0];
      let id: string;
      if (existing) {
        // Saving again reopens the item. A time sent (or an explicit null) replaces the reminder and lets it fire again; no time keeps the old one.
        const explicit = body.remindAt !== undefined;
        await tx.query(
          `UPDATE app.later_items SET state = 'open', done_at = NULL, updated_at = now(),
                  remind_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE remind_at END,
                  fired_at = CASE WHEN $2::boolean THEN NULL ELSE fired_at END
            WHERE id = $1::uuid`,
          [existing.id, explicit, remindAt],
        );
        id = existing.id;
      } else {
        // A full list makes room by dropping its oldest finished item; if everything is still open, it says so.
        const total = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.later_items WHERE person_id = $1::uuid', [person])).rows[0]!.n;
        if (total >= LATER_MAX_ITEMS) {
          const dropped = await tx.query(
            `DELETE FROM app.later_items WHERE id = (SELECT id FROM app.later_items WHERE person_id = $1::uuid AND state = 'done' ORDER BY done_at, id LIMIT 1) RETURNING id`,
            [person],
          );
          if (dropped.rows.length === 0) throw conflict(`You already have ${LATER_MAX_ITEMS} saved items. Finish or remove some first.`);
        }
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO app.later_items (workspace_id, person_id, message_id, channel_id, thread_root_id, remind_at)
           VALUES (app.workspace_id(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz) RETURNING id`,
          [person, messageId, msg.channel_id, msg.thread_root_id, remindAt],
        );
        id = inserted.rows[0]!.id;
      }
      const item = (await loadItems(tx, 'l.id = $1::uuid', [id], now))[0]!;
      return json(item, existing ? 200 : 201);
    }),
  });

  ctx.http.route({
    ...updateLaterRoute,
    schema: { body: UpdateLaterRequest, response: LaterItem },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { itemId } = LaterItemPathParams.parse(req.params);
      const { state } = UpdateLaterRequest.parse(req.body ?? {});
      await callerPerson(tx);
      const res = await tx.query(
        `UPDATE app.later_items SET state = $2, done_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1::uuid AND person_id = app.person_id() RETURNING id`,
        [itemId, state],
      );
      if (res.rows.length === 0) throw notFound('That item is not in your Later list');
      return json((await loadItems(tx, 'l.id = $1::uuid', [itemId], ctx.runtime.now()))[0]!);
    }),
  });

  ctx.http.route({
    ...removeLaterRoute,
    schema: { response: RemoveLaterResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { itemId } = LaterItemPathParams.parse(req.params);
      await callerPerson(tx);
      const res = await tx.query('DELETE FROM app.later_items WHERE id = $1::uuid AND person_id = app.person_id() RETURNING id', [itemId]);
      if (res.rows.length === 0) throw notFound('That item is not in your Later list');
      return json(RemoveLaterResponse.parse({ removed: true }));
    }),
  });
}
