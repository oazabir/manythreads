import type { PluginTx } from '@manythreads/sdk';
import { ListThreadsResponse, THREAD_PARTICIPANTS_SHOWN, type ThreadsTab } from '@manythreads/shared';
import { invalid } from './http.ts';
import { CHANNEL_REF_COLUMNS, toChannelRef, type ChannelRefRow } from './rows.ts';

// The Threads inbox (SPEC 6.1): one query shape for the three tabs, ordered by the latest reply, keyset paginated.

type InboxRow = ChannelRefRow & {
  root_message_id: string;
  title: string;
  author_id: string;
  reply_count: number;
  last_reply_at: Date;
  cursor_ts: string;
  followed: boolean;
  mine: boolean;
  unread_count: number | null;
  last_reply_id: string | null;
  last_reply_plain: string | null;
};

const encodeCursor = (ts: string, id: string): string => Buffer.from(`${ts}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { ts: string; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!ts || !id || rest.length > 0 || !/^[0-9a-f-]{36}$/.test(id) || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:?\d\d)?$/.test(ts)) throw invalid('cursor: not a cursor of this list');
  return { ts, id };
}

/**
 * Which threads count as "Mine" (a SQL boolean over `t` threads, `m` root messages): the ones the person started.
 *
 * PHASE 6 HOOK: "or holds a task in" (SPEC 6.1) is a second source. When the tasks plugin exists, add one more `OR` here, e.g.
 * `OR t.root_message_id IN (SELECT thread_root_id FROM app.tasks WHERE owner_id = $actor AND state <> 'done')`; nothing else in the
 * inbox changes (the tab, the ordering, the cursor and the item shape stay as they are). `$2` is the caller's actor id.
 */
const MINE = `(m.author_id = $2::uuid)`;

const TAB_PREDICATE: Record<ThreadsTab, string> = {
  followed: 'f.person_id IS NOT NULL',
  unread: 'rs.unread_count > 0',
  mine: MINE,
};

/**
 * The caller's threads for one tab, newest reply first. `teamId` limits it to the channels of one team (null: every channel the
 * caller can read, which is what a guest, who sits on no team, gets). A thread shows once it has a live reply. Direct-message
 * threads belong to no team, so only the unscoped inbox lists them.
 *
 * - `followed`: rows of `thread_follows` (the membership of a thread; see docs/plugins/threads.md);
 * - `unread`: threads with `read_state.unread_count > 0` (the partial index `read_state_unread`), followed or not, so the tab and the
 *   unread badge always agree;
 * - `mine`: threads whose root message the caller wrote.
 */
export async function listInbox(
  tx: PluginTx,
  input: { personId: string; tab: ThreadsTab; teamId: string | null; limit: number; cursor?: string | undefined },
): Promise<ListThreadsResponse> {
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const res = await tx.query<InboxRow>(
    `SELECT t.root_message_id, t.title, t.reply_count, t.last_reply_at, t.last_reply_at::text AS cursor_ts, m.author_id,
            (f.person_id IS NOT NULL) AS followed, (m.author_id = $2::uuid) AS mine, rs.unread_count,
            lr.id AS last_reply_id, left(lr.body_plain, 160) AS last_reply_plain, ${CHANNEL_REF_COLUMNS}
       FROM app.threads t
       JOIN app.messages m ON m.id = t.root_message_id
       JOIN app.channels c ON c.id = t.channel_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.body_plain FROM app.messages r
          WHERE r.thread_root_id = t.root_message_id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1
       ) lr ON true
       LEFT JOIN app.thread_follows f ON f.person_id = $1 AND f.thread_root_id = t.root_message_id
       LEFT JOIN app.read_state rs ON rs.person_id = $1 AND rs.target_type = 'thread' AND rs.target_id = t.root_message_id
      WHERE ${TAB_PREDICATE[input.tab]} AND t.reply_count > 0
        AND ($3::uuid IS NULL OR c.team_id = $3)
        AND ($4::text IS NULL OR (t.last_reply_at, t.root_message_id) < ($4::timestamptz, $5::uuid))
      ORDER BY t.last_reply_at DESC, t.root_message_id DESC
      LIMIT $6`,
    [input.personId, tx.actor.id, input.teamId, after?.ts ?? null, after?.id ?? null, input.limit + 1],
  );
  const more = res.rows.length > input.limit;
  const page = more ? res.rows.slice(0, input.limit) : res.rows;
  const last = page[page.length - 1];
  const rootIds = page.map((r) => r.root_message_id);
  // one transaction, so these run one after the other
  const participants = rootIds.length > 0 ? await listParticipants(tx, rootIds) : new Map<string, Participants>();
  const mentions = rootIds.length > 0 ? await countMentions(tx, input.personId, rootIds) : new Map<string, number>();
  // who wrote what: the channels plugin's definer function names only authors of messages the caller can read
  const lastIds = page.flatMap((r) => (r.last_reply_id ? [r.last_reply_id] : []));
  const names = new Map<string, string>();
  if (lastIds.length > 0) {
    const authors = await tx.query<{ message_id: string; display_name: string }>(
      `SELECT m.id AS message_id, a.display_name
         FROM app.messages m JOIN app.message_authors($1::uuid[]) a ON a.actor_id = m.author_id
        WHERE m.id = ANY ($1::uuid[])`,
      [lastIds],
    );
    for (const a of authors.rows) names.set(a.message_id, a.display_name);
  }
  const authorOf = await nameAuthors(tx, [...participants.values()].flatMap((p) => p.rows.map((x) => x.id)).concat(page.map((r) => r.root_message_id)));
  return ListThreadsResponse.parse({
    items: page.map((r) => ({
      rootMessageId: r.root_message_id,
      channel: toChannelRef(r),
      title: r.title,
      rootAuthorId: r.author_id,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at.toISOString(),
      followed: r.followed,
      unreadCount: r.unread_count ?? 0,
      mine: r.mine,
      rootAuthor: authorOf.get(r.author_id) ?? null,
      participants: (participants.get(r.root_message_id)?.rows ?? []).flatMap((p) => authorOf.get(p.author_id) ?? []),
      participantCount: participants.get(r.root_message_id)?.total ?? 0,
      mentionCount: Math.min(mentions.get(r.root_message_id) ?? 0, r.unread_count ?? 0),
      lastReply: r.last_reply_id && names.has(r.last_reply_id) ? { authorName: names.get(r.last_reply_id)!, preview: (r.last_reply_plain ?? '').replace(/\s+/g, ' ').trim() } : null,
    })),
    nextCursor: more && last ? encodeCursor(last.cursor_ts, last.root_message_id) : null,
  });
}

/** An author as the lookup names them; the response schema brands the id and checks the kind. */
type NamedAuthor = { actorId: string; displayName: string; kind: string };
type Participants = { total: number; rows: { id: string; author_id: string }[] };

/**
 * The authors of each thread's live messages (the root included): the root's author first, then the newest writers, at most
 * `THREAD_PARTICIPANTS_SHOWN` per thread, with the count of all of them. `id` is the author's newest message in the thread, which
 * `nameAuthors` needs to ask the visibility-checked author lookup.
 */
async function listParticipants(tx: PluginTx, rootIds: string[]): Promise<Map<string, Participants>> {
  const res = await tx.query<{ root_id: string; author_id: string; last_id: string; total: number }>(
    `SELECT t.root_id, w.author_id, w.last_id, w.total::int AS total
       FROM unnest($1::uuid[]) AS t(root_id)
       CROSS JOIN LATERAL (
         SELECT g.author_id, g.last_id, count(*) OVER () AS total
           FROM (
             SELECT r.author_id, (array_agg(r.id ORDER BY r.id DESC))[1] AS last_id, bool_or(r.id = t.root_id) AS is_root
               FROM app.messages r
              WHERE (r.thread_root_id = t.root_id OR r.id = t.root_id) AND r.deleted_at IS NULL
              GROUP BY r.author_id
           ) g
          ORDER BY g.is_root DESC, g.last_id DESC
          LIMIT ${String(THREAD_PARTICIPANTS_SHOWN)}
       ) w`,
    [rootIds],
  );
  const out = new Map<string, Participants>();
  for (const r of res.rows) {
    const entry = out.get(r.root_id) ?? { total: r.total, rows: [] };
    entry.rows.push({ id: r.last_id, author_id: r.author_id });
    out.set(r.root_id, entry);
  }
  return out;
}

/** Names the authors of the given messages the way the message list does; an author of messages the caller cannot read is left out. */
async function nameAuthors(tx: PluginTx, messageIds: string[]): Promise<Map<string, NamedAuthor>> {
  const out = new Map<string, NamedAuthor>();
  if (messageIds.length === 0) return out;
  const res = await tx.query<{ actor_id: string; display_name: string; kind: string }>('SELECT actor_id, display_name, kind FROM app.message_authors($1::uuid[])', [[...new Set(messageIds)]]);
  for (const a of res.rows) out.set(a.actor_id, { actorId: a.actor_id, displayName: a.display_name, kind: a.kind });
  return out;
}

/** Per thread, the replies the caller has not read that name them (a person mention; a tag of @channel is not counted). */
async function countMentions(tx: PluginTx, personId: string, rootIds: string[]): Promise<Map<string, number>> {
  const res = await tx.query<{ root_id: string; n: number }>(
    `SELECT r.thread_root_id AS root_id, count(*)::int AS n
       FROM app.messages r
       JOIN app.message_mentions mm ON mm.message_id = r.id AND mm.mentioned_id = $2::uuid AND mm.kind <> 'channel'
       JOIN app.read_state rs ON rs.person_id = $1 AND rs.target_type = 'thread' AND rs.target_id = r.thread_root_id AND rs.unread_count > 0
      WHERE r.thread_root_id = ANY ($3::uuid[]) AND r.deleted_at IS NULL AND r.author_id <> $2::uuid
        AND (rs.last_read_id IS NULL OR r.id > rs.last_read_id)
      GROUP BY r.thread_root_id`,
    [personId, tx.actor.id, rootIds],
  );
  return new Map(res.rows.map((r) => [r.root_id, r.n]));
}
