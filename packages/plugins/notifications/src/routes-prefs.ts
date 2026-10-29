import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  GetNotificationKeywordsResponse,
  GetNotificationLevelsResponse,
  GetPushStateResponse,
  KEYWORD_MAX_COUNT,
  KEYWORD_PROBLEM_TEXT,
  NotificationLevel,
  PutChannelLevelParams,
  PutChannelLevelRequest,
  PutChannelLevelResponse,
  PutNotificationKeywordsRequest,
  PutNotificationKeywordsResponse,
  PutWorkspaceLevelRequest,
  PutWorkspaceLevelResponse,
  SubscribePushRequest,
  SubscribePushResponse,
  UnsubscribePushRequest,
  UnsubscribePushResponse,
  effectiveLevel,
  firstWordOf,
  getNotificationKeywordsRoute,
  getNotificationLevelsRoute,
  getPushStateRoute,
  normalizeKeyword,
  putChannelLevelRoute,
  putNotificationKeywordsRoute,
  putWorkspaceLevelRoute,
  subscribePushRoute,
  unsubscribePushRoute,
} from '@manythreads/shared';
import { forbidden, invalid, json, route } from './http.ts';
import { workspaceDefaultLevel } from './levels.ts';
import { extraPushHosts, vapidFromEnv } from './push.ts';
import { isAllowedPushEndpoint } from './webpush.ts';

/** The signed-in person (people.id); these settings belong to a person, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Notification settings belong to people');
  return row.id;
}

const workspaceOf = (tx: PluginTx): string => tx.actor.workspaceId;

async function pushCount(tx: PluginTx, personId: string): Promise<number> {
  return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.push_subscriptions WHERE person_id = $1::uuid', [personId])).rows[0]?.n ?? 0;
}

const decodedLength = (s: string): number => Buffer.from(s, 'base64url').length;

/**
 * Channel levels, the workspace default, personal keywords and browser push: the settings half of the notifications plugin (docs/plugins/notifications.md).
 * Every route acts on the caller's own settings; row level security enforces it, the explicit person id only helps the planner.
 */
export function registerPreferenceRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getNotificationLevelsRoute,
    schema: { response: GetNotificationLevelsResponse },
    handler: route(async (_req, tx) => {
      const person = await callerPerson(tx);
      const workspaceDefault = await workspaceDefaultLevel(tx, workspaceOf(tx));
      // The join with channels is as the caller: a channel they can no longer read drops out of the list.
      const res = await tx.query<{ channel_id: string; level: string; name: string; kind: string }>(
        `SELECT nl.channel_id, nl.level, c.name, c.kind
           FROM app.notification_levels nl JOIN app.channels c ON c.id = nl.channel_id
          WHERE nl.person_id = $1::uuid ORDER BY nl.updated_at DESC, nl.channel_id LIMIT 1000`,
        [person],
      );
      return json(
        GetNotificationLevelsResponse.parse({
          workspaceDefault,
          channels: res.rows.map((r) => ({ channelId: r.channel_id, channelName: r.name === '' ? null : r.name, channelKind: r.kind, level: r.level })),
        }),
      );
    }),
  });

  ctx.http.route({
    ...putChannelLevelRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { body: PutChannelLevelRequest, response: PutChannelLevelResponse },
    handler: route(async (req, tx) => {
      const { channelId } = PutChannelLevelParams.parse(req.params);
      const body = PutChannelLevelRequest.parse(req.body);
      const person = await callerPerson(tx);
      // Seen as the caller: a channel they cannot read looks like one that does not exist.
      const channel = (await tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
      if (!channel) throw forbidden();
      if (body.level === null) {
        await tx.query('DELETE FROM app.notification_levels WHERE person_id = $1::uuid AND channel_id = $2::uuid', [person, channelId]);
      } else {
        await tx.query(
          `INSERT INTO app.notification_levels (person_id, channel_id, workspace_id, level) VALUES ($1::uuid, $2::uuid, app.workspace_id(), $3)
           ON CONFLICT (person_id, channel_id) DO UPDATE SET level = EXCLUDED.level, updated_at = now() WHERE app.notification_levels.level IS DISTINCT FROM EXCLUDED.level`,
          [person, channelId, body.level],
        );
      }
      const workspaceDefault = await workspaceDefaultLevel(tx, workspaceOf(tx));
      return json(PutChannelLevelResponse.parse({ channelId, level: body.level, effective: effectiveLevel(body.level, channel.kind, workspaceDefault) }));
    }),
  });

  ctx.http.route({
    ...putWorkspaceLevelRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: PutWorkspaceLevelRequest, response: PutWorkspaceLevelResponse },
    handler: route(async (req, tx) => {
      const body = PutWorkspaceLevelRequest.parse(req.body);
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can change the default.');
      await tx.query(
        `INSERT INTO app.notification_workspace_settings (workspace_id, default_level, updated_by) VALUES (app.workspace_id(), $1, app.actor())
         ON CONFLICT (workspace_id) DO UPDATE SET default_level = EXCLUDED.default_level, updated_by = EXCLUDED.updated_by, updated_at = now()
           WHERE app.notification_workspace_settings.default_level IS DISTINCT FROM EXCLUDED.default_level`,
        [body.level],
      );
      return json(PutWorkspaceLevelResponse.parse({ workspaceDefault: NotificationLevel.parse(body.level) }));
    }),
  });

  ctx.http.route({
    ...getNotificationKeywordsRoute,
    schema: { response: GetNotificationKeywordsResponse },
    handler: route(async (_req, tx) => {
      const person = await callerPerson(tx);
      const res = await tx.query<{ keyword: string }>('SELECT keyword FROM app.notification_keywords WHERE person_id = $1::uuid ORDER BY keyword', [person]);
      return json({ keywords: res.rows.map((r) => r.keyword) });
    }),
  });

  ctx.http.route({
    ...putNotificationKeywordsRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: PutNotificationKeywordsRequest, response: PutNotificationKeywordsResponse },
    handler: route(async (req, tx) => {
      const body = PutNotificationKeywordsRequest.parse(req.body);
      const person = await callerPerson(tx);
      const keywords = new Set<string>();
      for (const raw of body.keywords) {
        if (raw.trim() === '') continue;
        const one = normalizeKeyword(raw);
        if ('problem' in one) throw invalid(`“${raw.slice(0, 40)}”: ${KEYWORD_PROBLEM_TEXT[one.problem]}`);
        keywords.add(one.keyword);
      }
      if (keywords.size > KEYWORD_MAX_COUNT) throw invalid(`You can keep at most ${KEYWORD_MAX_COUNT} keywords.`);
      const list = [...keywords].sort();
      await tx.query('DELETE FROM app.notification_keywords WHERE person_id = $1::uuid', [person]);
      if (list.length > 0) {
        await tx.query(
          `INSERT INTO app.notification_keywords (person_id, keyword, first_word, workspace_id)
           SELECT $1::uuid, k.keyword, k.first_word, app.workspace_id() FROM unnest($2::text[], $3::text[]) AS k(keyword, first_word)`,
          [person, list, list.map(firstWordOf)],
        );
      }
      return json({ keywords: list });
    }),
  });

  // Browser push ------------------------------------------------------------------------------------------------------------------

  ctx.http.route({
    ...getPushStateRoute,
    schema: { response: GetPushStateResponse },
    handler: route(async (_req, tx) => {
      const person = await callerPerson(tx);
      const keys = vapidFromEnv(process.env, ctx.runtime.publicUrl);
      return json({ available: keys !== null, publicKey: keys?.publicKey ?? null, subscriptions: await pushCount(tx, person) });
    }),
  });

  ctx.http.route({
    ...subscribePushRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: SubscribePushRequest, response: SubscribePushResponse },
    handler: route(async (req, tx) => {
      const body = SubscribePushRequest.parse(req.body);
      await callerPerson(tx);
      if (vapidFromEnv(process.env, ctx.runtime.publicUrl) === null) throw new HttpError(409, 'conflict', 'Browser push is not set up on this server.');
      if (!isAllowedPushEndpoint(body.endpoint, extraPushHosts(process.env))) throw invalid('This browser’s push service is not one the server can send to.');
      if (decodedLength(body.keys.p256dh) !== 65 || decodedLength(body.keys.auth) !== 16) throw invalid('The browser’s push keys are not valid.');
      const res = await tx.query<{ n: number }>('SELECT app.notifications_push_subscribe($1, $2, $3, $4) AS n', [body.endpoint, body.keys.p256dh, body.keys.auth, body.label ?? '']);
      return json({ subscriptions: res.rows[0]?.n ?? 0 });
    }),
  });

  ctx.http.route({
    ...unsubscribePushRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: UnsubscribePushRequest, response: UnsubscribePushResponse },
    handler: route(async (req, tx) => {
      const body = UnsubscribePushRequest.parse(req.body);
      const person = await callerPerson(tx);
      await tx.query('DELETE FROM app.push_subscriptions WHERE person_id = $1::uuid AND endpoint = $2', [person, body.endpoint]);
      return json({ subscriptions: await pushCount(tx, person) });
    }),
  });
}
