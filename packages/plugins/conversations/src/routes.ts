import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ConversationPathParams,
  ListConversationsQuery,
  ListConversationsResponse,
  OpenConversationResponse,
  listConversationsRoute,
  openConversationRoute,
  type ConversationScope,
} from '@manythreads/shared';
import { HttpError, conflict, forbidden, invalid, json, notFound, requireTeam, route } from './http.ts';
import { promptsOf } from './prompts.ts';
import { toListItem, type AuthorKinds, type ListRow } from './rows.ts';

// The two routes of the conversation view (SPEC §6.2). Reading a thread and sending into it are the channels plugin's routes, with the id of
// the channel `open` returns: the first message of a conversation is an ordinary channel message, and the bot's reply an ordinary reply.

/**
 * `<microseconds>:<root id>`: the keyset of every list (newest activity first, the thread id breaks a tie). At most 16 digits: a time in
 * microseconds reaches 16 digits in 2001 and 17 only in the year 2286, and a longer number could exceed the bigint it is cast to (22003, a 500).
 */
const CURSOR = /^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface BotRow {
  id: string;
  slug: string;
  name: string;
  role: string;
  status: string;
  definition_sha: string;
  /** The BOT.md triggers include `conversation`: the only trigger a message in a conversation channel fires. */
  conversational: boolean;
  [key: string]: unknown;
}

/** The bot of the team, or 404: an unknown slug and one of another team answer alike. */
async function requireBot(tx: PluginTx, teamId: string, botSlug: string): Promise<BotRow> {
  const res = await tx.query<BotRow>(
    `SELECT id, slug, name, role, status, definition_sha, jsonb_path_exists(triggers, '$[*] ? (@.type == "conversation")') AS conversational
       FROM app.bots WHERE team_id = $1 AND slug = $2`,
    [teamId, botSlug],
  );
  const bot = res.rows[0];
  if (!bot) throw notFound(`No bot "${botSlug}"`);
  return bot;
}

async function callerPersonId(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw forbidden('Conversations belong to people');
  return row.id;
}

// What a list row is made of, in three shapes with the same columns (see ListRow). Constant SQL, never built from input. Every table read
// here is read with the caller's own row level security, so a row of somebody else's private conversation is simply not there.
//
//  * mine: the caller's own conversations with this bot. The title is their own first message.
//  * shared: the conversations shared with the team. Somebody else's is read through the copy that was posted into a channel
//    (`shared_root_id`), never through the private thread; with no readable copy it has no title and its thread is the private root,
//    which the caller cannot open (the row says so).
//  * mentions: threads where the caller named the bot in a team channel and the bot was asked to answer: the runs the mention fired,
//    one per thread, in channels the caller can read.
const BASE: Record<ConversationScope, string> = {
  mine: `
    SELECT c.thread_root_id AS thread_id, c.channel_id, 'conversation'::text AS source, NULL::text AS channel_name,
           c.person_id, c.visibility, sc.id AS shared_to, CASE WHEN sc.kind = 'channel' THEN sc.name END AS shared_name,
           c.shared_root_id AS shared_root, left(m.body_plain, 120) AS title, m.created_at
      FROM app.conversations c
      JOIN app.messages m ON m.id = c.thread_root_id AND m.deleted_at IS NULL
      LEFT JOIN app.channels sc ON sc.id = c.shared_to
     WHERE c.bot_id = $2 AND c.person_id = $1`,
  shared: `
    SELECT CASE WHEN c.person_id = $1 THEN c.thread_root_id ELSE coalesce(sm.id, c.thread_root_id) END AS thread_id,
           CASE WHEN c.person_id = $1 OR sm.id IS NULL THEN c.channel_id ELSE sm.channel_id END AS channel_id,
           'conversation'::text AS source, NULL::text AS channel_name,
           c.person_id, c.visibility, sc.id AS shared_to, CASE WHEN sc.kind = 'channel' THEN sc.name END AS shared_name,
           c.shared_root_id AS shared_root,
           left(CASE WHEN c.person_id = $1 THEN m.body_plain ELSE sm.body_plain END, 120) AS title,
           coalesce(m.created_at, sm.created_at, c.shared_at) AS created_at
      FROM app.conversations c
      LEFT JOIN app.messages m ON m.id = c.thread_root_id AND m.deleted_at IS NULL
      LEFT JOIN app.messages sm ON sm.id = c.shared_root_id AND sm.deleted_at IS NULL
      LEFT JOIN app.channels sc ON sc.id = c.shared_to
     WHERE c.bot_id = $2 AND c.visibility = 'shared' AND (c.person_id <> $1 OR m.id IS NOT NULL)`,
  mentions: `
    SELECT r.reply_root_id AS thread_id, r.channel_id, 'mention'::text AS source, ch.name AS channel_name,
           $1::uuid AS person_id, NULL::text AS visibility, NULL::uuid AS shared_to, NULL::text AS shared_name,
           NULL::uuid AS shared_root, left(m.body_plain, 120) AS title, m.created_at
      FROM (SELECT DISTINCT ON (reply_root_id) reply_root_id, channel_id
              FROM app.bot_runs
             WHERE bot_id = $2 AND trigger_type = 'mention' AND asker_id = app.actor()
               AND channel_id IS NOT NULL AND reply_root_id IS NOT NULL
             ORDER BY reply_root_id, id DESC) r
      JOIN app.channels ch ON ch.id = r.channel_id AND ch.kind = 'channel'
      JOIN app.messages m ON m.id = r.reply_root_id AND m.channel_id = r.channel_id AND m.deleted_at IS NULL`,
};

function listSql(scope: ConversationScope): string {
  return `
    WITH base AS (${BASE[scope]}),
    act AS (
      SELECT b.*, t.reply_count, t.last_reply_at,
             (extract(epoch FROM coalesce(t.last_reply_at, b.created_at)) * 1000000)::bigint AS act_n
        FROM base b LEFT JOIN app.threads t ON t.root_message_id = b.thread_id)
    SELECT a.thread_id, a.channel_id, a.source, a.channel_name, a.person_id, a.visibility, a.shared_to, a.shared_name, a.shared_root,
           a.title, a.created_at, a.reply_count, a.last_reply_at, a.act_n::text AS act_us,
           lm.id AS lm_id, lm.author_id AS lm_author, left(lm.body_plain, 140) AS lm_preview,
           coalesce(rs.unread_count, 0)::int AS unread
      FROM act a
      LEFT JOIN LATERAL (
        SELECT m2.id, m2.author_id, m2.body_plain FROM app.messages m2
         WHERE m2.thread_root_id = a.thread_id AND m2.deleted_at IS NULL ORDER BY m2.id DESC LIMIT 1) lm ON true
      LEFT JOIN app.read_state rs ON rs.person_id = $1 AND rs.target_type = 'thread' AND rs.target_id = a.thread_id
     WHERE ($3::bigint IS NULL OR (a.act_n, a.thread_id) < ($3::bigint, $4::uuid))
     ORDER BY a.act_n DESC, a.thread_id DESC
     LIMIT $5`;
}

async function authorKinds(tx: PluginTx, messageIds: readonly string[]): Promise<AuthorKinds> {
  if (messageIds.length === 0) return new Map();
  const res = await tx.query<{ actor_id: string; kind: 'person' | 'bot' | 'system' }>(
    'SELECT actor_id, kind FROM app.message_authors($1::uuid[])',
    [messageIds],
  );
  return new Map(res.rows.map((r) => [r.actor_id, r.kind]));
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...openConversationRoute,
    schema: { response: OpenConversationResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ConversationPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      if (bot.status !== 'active') {
        throw conflict(
          bot.status === 'disabled' ? 'This bot is turned off, so it cannot answer.' : "This bot's BOT.md is invalid, so it cannot answer until it is fixed.",
        );
      }
      // The router fires a message in a conversation channel only for the bot's `conversation` trigger (runtime-hermes' matchTrigger): without
      // one nothing would ever answer, so there is no conversation to open (the roster says so, and the clients offer no Talk button).
      if (!bot.conversational) {
        throw new HttpError(
          409,
          'bot_has_no_conversation_trigger',
          `${bot.name} does not take part in conversations: its definition has no conversation trigger.`,
        );
      }
      // One statement makes (or finds) the channel and its one member; a person who is not on the bot's team is refused there (403).
      const made = (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [bot.id])).rows[0]!;
      if (made.created) {
        await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: made.channel_id, teamId: null, name: '', kind: 'bot_conversation', private: true });
      }
      const chips = await promptsOf(ctx, tx, { teamId: team.id, slug: bot.slug, definitionSha: bot.definition_sha });
      return json(
        OpenConversationResponse.parse({
          botId: bot.id,
          botName: bot.name,
          botRole: bot.role,
          channelId: made.channel_id,
          created: made.created,
          prompts: chips.prompts,
          promptSource: chips.source,
        }),
        made.created ? 201 : 200,
      );
    }),
  });

  ctx.http.route({
    ...listConversationsRoute,
    schema: { query: ListConversationsQuery, response: ListConversationsResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = ConversationPathParams.parse(req.params);
      const q = ListConversationsQuery.parse(req.query);
      const cursor = q.cursor === undefined ? null : CURSOR.exec(q.cursor);
      if (q.cursor !== undefined && cursor === null) throw invalid('cursor: not a cursor of this list');
      const team = await requireTeam(tx, slug);
      const bot = await requireBot(tx, team.id, botSlug);
      const me = await callerPersonId(tx);
      const rows = (
        await tx.query<ListRow>(listSql(q.scope), [me, bot.id, cursor?.[1] ?? null, cursor?.[2] ?? null, q.limit + 1])
      ).rows;
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const kinds = await authorKinds(tx, page.flatMap((r) => (r.lm_id === null ? [] : [r.lm_id])));
      const last = page[page.length - 1];
      return json(
        ListConversationsResponse.parse({
          items: page.map((r) => toListItem(r, me, kinds)),
          nextCursor: more && last ? `${last.act_us}:${last.thread_id}` : null,
        }),
      );
    }),
  });
}
