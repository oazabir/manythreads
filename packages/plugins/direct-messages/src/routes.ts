import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  ChannelCreatedPush,
  ListDmsQuery,
  ListDmsResponse,
  OpenDmRequest,
  OpenDmResponse,
  WS_CHANNEL_CREATED,
  listDmsRoute,
  openDmRoute,
} from '@manythreads/shared';
import { invalid, json, route } from './http.ts';
import { toSummary, type DmRow } from './rows.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * My conversations as the DM list shows them, most recently active first (the latest top-level message, else the channel's own id,
 * both uuid v7 so they sort by time). Row level security decides which DMs exist for the caller: only members see one, a workspace
 * admin included, so a listing for another person is just empty. `channelIds` limits it to given channels; `before` is the keyset.
 */
async function loadDms(
  tx: PluginTx,
  input: { personId: string; channelIds?: readonly string[]; before?: string | undefined; limit: number },
): Promise<DmRow[]> {
  const res = await tx.query<DmRow>(
    `SELECT c.id, c.workspace_id, c.team_id, c.group_id, c.name, c.kind, c.private, c.purpose, c.dm_key, c.bot_id, c.position, c.archived_at, c.created_at,
            lm.id AS lm_id, lm.author_id AS lm_author, left(lm.body_plain, 140) AS lm_preview, lm.created_at AS lm_created,
            coalesce(rs.unread_count, 0) AS unread, coalesce(lm.id, c.id) AS sort_key,
            (SELECT jsonb_agg(jsonb_build_object('personId', p.id, 'displayName', p.display_name) ORDER BY p.display_name, p.id)
               FROM app.channel_members cm JOIN app.people p ON p.id = cm.person_id WHERE cm.channel_id = c.id) AS participants
       FROM app.channels c
       LEFT JOIN LATERAL (
         SELECT m.id, m.author_id, m.body_plain, m.created_at FROM app.messages m
          WHERE m.channel_id = c.id AND m.thread_root_id IS NULL AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) lm ON true
       LEFT JOIN app.read_state rs ON rs.person_id = $1 AND rs.target_type = 'channel' AND rs.target_id = c.id
      WHERE c.kind = 'dm' AND ($2::uuid[] IS NULL OR c.id = ANY ($2)) AND ($3::uuid IS NULL OR coalesce(lm.id, c.id) < $3)
      ORDER BY coalesce(lm.id, c.id) DESC
      LIMIT $4`,
    [input.personId, input.channelIds ?? null, input.before ?? null, input.limit],
  );
  return res.rows;
}

async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Direct messages belong to people');
  return row.id;
}

/**
 * Direct messages (SPEC 6.1, PLAN P3-06): get-or-create a private conversation by the set of people, and list mine. Reading and
 * posting use the channel routes with the DM's channel id. See docs/plugins/direct-messages.md.
 */
export function registerDmRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...openDmRoute,
    schema: { body: OpenDmRequest, response: OpenDmResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { personIds } = OpenDmRequest.parse(req.body);
      const person = await callerPerson(tx);
      // One statement makes (or finds) the channel and its members; see migration 0001. A guest is refused there (403).
      const made = await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.dms_get_or_create($1::uuid[])', [personIds]);
      const { channel_id: channelId, created } = made.rows[0]!;
      const dm = (await loadDms(tx, { personId: person, channelIds: [channelId], limit: 1 }))[0];
      if (!dm) throw new HttpError(500, 'internal', 'The conversation was made but cannot be read');
      const summary = toSummary(dm);
      if (created) {
        await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId, teamId: null, name: '', kind: 'dm', private: true });
        // The other people see the conversation appear in their sidebar.
        const push = ChannelCreatedPush.parse({ channel: summary.channel });
        for (const p of summary.participants) if (p.personId !== person) await ctx.realtime.pushToPerson(tx, p.personId, WS_CHANNEL_CREATED, push);
      }
      return json(OpenDmResponse.parse({ dm: summary, created }), created ? 201 : 200);
    }),
  });

  ctx.http.route({
    ...listDmsRoute,
    schema: { query: ListDmsQuery, response: ListDmsResponse },
    handler: route(async (req, tx) => {
      const q = ListDmsQuery.parse(req.query);
      if (q.cursor !== undefined && !UUID.test(q.cursor)) throw invalid('cursor: not a cursor of this list');
      const person = await callerPerson(tx);
      const rows = await loadDms(tx, { personId: person, before: q.cursor, limit: q.limit + 1 });
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      return json(ListDmsResponse.parse({ items: page.map(toSummary), nextCursor: more && last ? last.sort_key : null }));
    }),
  });
}
