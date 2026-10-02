import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  DEFAULT_NOTIFICATION_PREFS,
  GetNotificationPrefsResponse,
  GetNotificationSummaryResponse,
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadRequest,
  MarkNotificationsReadResponse,
  NotificationReadPush,
  UpdateNotificationPrefsRequest,
  UpdateNotificationPrefsResponse,
  getNotificationPrefsRoute,
  getNotificationSummaryRoute,
  listNotificationsRoute,
  markNotificationsReadRoute,
  notificationReadPushType,
  updateNotificationPrefsRoute,
} from '@manythreads/shared';
import { json, route } from './http.ts';
import { normalizePrefs } from './prefs.ts';
import { NOTIFICATION_COLUMNS, toNotification, type NotificationRow } from './rows.ts';

/** The signed-in person (people.id); an inbox belongs to a person, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Notifications belong to people');
  return row.id;
}

async function unreadCount(tx: PluginTx, personId: string): Promise<number> {
  const res = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.notifications WHERE person_id = $1::uuid AND read_at IS NULL', [personId]);
  return res.rows[0]?.n ?? 0;
}

/**
 * The HTTP face of the inbox. Every route acts on the caller's own rows (row level security enforces it; the explicit person id only
 * helps the planner). The list is newest first by id (uuid v7), so a cursor is just the last id of the page.
 */
export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listNotificationsRoute.method,
    path: listNotificationsRoute.path,
    schema: { query: ListNotificationsQuery, response: ListNotificationsResponse },
    handler: route(async (req, tx) => {
      const q = ListNotificationsQuery.parse(req.query);
      const person = await callerPerson(tx);
      const res = await tx.query<NotificationRow>(
        `SELECT ${NOTIFICATION_COLUMNS} FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id
          WHERE n.person_id = $1::uuid AND ($2::uuid IS NULL OR n.id < $2::uuid) AND ($3::boolean = false OR n.read_at IS NULL)
          ORDER BY n.id DESC LIMIT $4`,
        [person, q.cursor ?? null, q.unread === 'true', q.limit + 1],
      );
      const more = res.rows.length > q.limit;
      const page = more ? res.rows.slice(0, q.limit) : res.rows;
      const last = page[page.length - 1];
      return json({ items: page.map(toNotification), nextCursor: more && last ? last.id : null });
    }),
  });

  ctx.http.route({
    method: getNotificationSummaryRoute.method,
    path: getNotificationSummaryRoute.path,
    schema: { response: GetNotificationSummaryResponse },
    handler: route(async (_req, tx) => json({ unreadCount: await unreadCount(tx, await callerPerson(tx)) })),
  });

  ctx.http.route({
    method: markNotificationsReadRoute.method,
    path: markNotificationsReadRoute.path,
    rateLimit: { limit: 300, windowMs: 60_000 },
    schema: { body: MarkNotificationsReadRequest, response: MarkNotificationsReadResponse },
    handler: route(async (req, tx) => {
      const body = MarkNotificationsReadRequest.parse(req.body);
      const person = await callerPerson(tx);
      const all = 'all' in body;
      // Rows that are not the caller's, are in a channel they can no longer read, or are already read are simply not matched.
      const res = await tx.query<{ id: string }>(
        `UPDATE app.notifications SET read_at = now()
          WHERE person_id = $1::uuid AND read_at IS NULL AND ($2::boolean OR id = ANY ($3::uuid[])) RETURNING id`,
        [person, all, all ? [] : body.ids],
      );
      const left = await unreadCount(tx, person);
      if (res.rows.length > 0) {
        // The person's other tabs and devices drop their badge.
        await ctx.realtime.pushToPerson(
          tx,
          person,
          notificationReadPushType,
          NotificationReadPush.parse({ ids: all ? [] : res.rows.map((r) => r.id), all, unreadCount: left }),
        );
      }
      return json({ updated: res.rows.length, unreadCount: left });
    }),
  });

  ctx.http.route({
    method: getNotificationPrefsRoute.method,
    path: getNotificationPrefsRoute.path,
    schema: { response: GetNotificationPrefsResponse },
    handler: route(async (_req, tx) => {
      const person = await callerPerson(tx);
      const res = await tx.query<{ prefs: unknown }>('SELECT prefs FROM app.notification_prefs WHERE person_id = $1::uuid', [person]);
      return json(res.rows[0] ? normalizePrefs(res.rows[0].prefs) : DEFAULT_NOTIFICATION_PREFS);
    }),
  });

  ctx.http.route({
    method: updateNotificationPrefsRoute.method,
    path: updateNotificationPrefsRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: UpdateNotificationPrefsRequest, response: UpdateNotificationPrefsResponse },
    handler: route(async (req, tx) => {
      const body = UpdateNotificationPrefsRequest.parse(req.body);
      const person = await callerPerson(tx);
      const prefs = normalizePrefs({ ...body, mutedChannels: [...new Set(body.mutedChannels)] });
      await tx.query(
        `INSERT INTO app.notification_prefs (person_id, workspace_id, prefs) VALUES ($1::uuid, app.workspace_id(), $2::jsonb)
         ON CONFLICT (person_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
        [person, JSON.stringify(prefs)],
      );
      return json(prefs);
    }),
  });
}
