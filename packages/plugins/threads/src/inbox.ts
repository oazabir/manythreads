import type { PluginTx } from '@manythreads/sdk';
import { ListThreadsResponse, THREAD_FILTER_RESULTS_MAX, THREAD_MENTION_DAYS, THREAD_PARTICIPANTS_SHOWN, type ThreadsTab } from '@manythreads/shared';
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
  last_reply_author: string | null;
  last_reply_at_ts: Date | null;
};

/**
 * Accents and case do not matter in the filter, as on the page (`fold` in the web client: NFD, marks removed, lower case). The words are folded here, and the text of the database is folded in
 * the query the same way by `translate` over the Latin letters that carry a mark (U+00C0..U+017F), so "cafe" finds "Café" and the client and the server agree.
 */
const foldWord = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const [FOLD_FROM, FOLD_TO] = (() => {
  let from = '';
  let to = '';
  for (let cp = 0xc0; cp <= 0x17f; cp++) {
    const ch = String.fromCodePoint(cp).toLowerCase();
    const base = foldWord(ch);
    if (base !== ch && /^[a-z]$/.test(base) && !from.includes(ch)) {
      from += ch;
      to += base;
    }
  }
  return [from, to];
})();
const folded = (expr: string): string => `translate(lower(${expr}), '${FOLD_FROM}', '${FOLD_TO}')`;

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

/**
 * "Waiting for you" (P29): a live message of the thread (the root included) names the caller (a mention row of the person, so a room word like @channel included, as the unread mention count does; a #channel link is another kind), was written by someone else, is at most
 * `THREAD_MENTION_DAYS` old, and the caller has not written in the thread since. `root` is the SQL expression of the thread's root id; `$2` is the caller's actor id.
 */
export const unanswered = (root: string): string => `EXISTS (
    SELECT 1 FROM app.messages um
      JOIN app.message_mentions umt ON umt.message_id = um.id AND umt.mentioned_id = $2::uuid AND umt.kind <> 'channel'
     WHERE (um.thread_root_id = ${root} OR um.id = ${root}) AND um.deleted_at IS NULL AND um.author_id <> $2::uuid
       AND um.created_at > now() - interval '${String(THREAD_MENTION_DAYS)} days'
       AND NOT EXISTS (SELECT 1 FROM app.messages me WHERE (me.thread_root_id = ${root} OR me.id = ${root}) AND me.author_id = $2::uuid AND me.deleted_at IS NULL AND me.id > um.id))`;

// Followed also holds a thread that waits on the caller because of a mention, followed or not: the Needs-you rows are always in the default tab and the sidebar count agrees with it.
const TAB_PREDICATE: Record<ThreadsTab, string> = {
  followed: `(f.person_id IS NOT NULL OR ${unanswered('t.root_message_id')})`,
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
  input: {
    personId: string;
    tab: ThreadsTab;
    teamId: string | null;
    limit: number;
    cursor?: string | undefined;
    q?: string | undefined;
    mentions?: readonly (readonly string[])[] | undefined;
    who?: 'people' | undefined;
    /** Only these threads (the caller's bookmarked ones, P36-08). On Followed they are listed whether followed or not. */
    bookmarked?: readonly string[] | undefined;
  },
): Promise<ListThreadsResponse> {
  const filtered = input.q !== undefined || (input.mentions?.length ?? 0) > 0;
  const after = !filtered && input.cursor ? decodeCursor(input.cursor) : null;
  const params: unknown[] = [input.personId, tx.actor.id, input.teamId, after?.ts ?? null, after?.id ?? null, 0];
  // the filter (P29): every word must be in the channel's name or in a live message of the thread; every `@name` must be mentioned somewhere in it
  const where: string[] = [];
  const patterns: string[] = [];
  for (const word of (input.q ?? '').split(/\s+/).filter((w) => w !== '').slice(0, 6)) {
    params.push(`%${foldWord(word).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const at = `$${String(params.length)}`;
    patterns.push(at);
    where.push(`(${folded("coalesce(c.name, '')")} LIKE ${at} OR EXISTS (SELECT 1 FROM app.messages fm WHERE (fm.thread_root_id = t.root_message_id OR fm.id = t.root_message_id) AND fm.deleted_at IS NULL AND ${folded('fm.body_plain')} LIKE ${at}))`);
  }
  for (const group of input.mentions ?? []) {
    params.push(group);
    const at = `$${String(params.length)}::uuid[]`;
    where.push(`EXISTS (SELECT 1 FROM app.messages xm JOIN app.message_mentions xmt ON xmt.message_id = xm.id AND xmt.mentioned_id = ANY (${at}) AND xmt.kind <> 'channel' WHERE (xm.thread_root_id = t.root_message_id OR xm.id = t.root_message_id) AND xm.deleted_at IS NULL)`);
  }
  // people only (owner, 2026-11-19): every author of a live message of the thread (the root included) is a person. `actors` shows a caller only their own row, so the
  // people among the authors come from the visibility-checked author lookup, asked ONCE per request (not per thread): `personAuthors`. An author it does not name counts
  // as not a person, so it fails closed. A plain predicate: the list keeps its pages.
  if (input.who === 'people') {
    params.push(await personAuthors(tx));
    const at = `$${String(params.length)}::uuid[]`;
    where.push(`(m.deleted_at IS NOT NULL OR m.author_id = ANY (${at}))`);
    where.push(`NOT EXISTS (SELECT 1 FROM app.messages pm WHERE pm.thread_root_id = t.root_message_id AND pm.deleted_at IS NULL AND NOT (pm.author_id = ANY (${at})))`);
  }
  // Bookmarked (P36-08): the caller's bookmarked threads, a plain predicate (the list keeps its pages). On Followed every bookmarked thread is listed, followed or not;
  // the other tabs keep their own rule. A thread has a `threads` row only from its first reply, so a bookmarked first message with no reply yet joins the list from
  // `messages` (read under the caller's own policies, live roots only), shaped as a thread with no replies whose time is the message's own.
  const bookmarked = input.bookmarked !== undefined;
  let source = 'app.threads';
  if (bookmarked) {
    params.push(input.bookmarked);
    const at = `$${String(params.length)}::uuid[]`;
    where.push(`t.root_message_id = ANY (${at})`);
    source = `(SELECT th.root_message_id, th.channel_id, th.title, th.reply_count, th.last_reply_at FROM app.threads th
                UNION ALL
                SELECT bm.id, bm.channel_id, left(bm.body_plain, 120), 0, bm.created_at FROM app.messages bm
                 WHERE bm.id = ANY (${at}) AND bm.thread_root_id IS NULL AND bm.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM app.threads tn WHERE tn.root_message_id = bm.id))`;
  }
  const tabRule = bookmarked && input.tab === 'followed' ? 'true' : TAB_PREDICATE[input.tab];
  // a bookmarked thread is listed with or without replies; every other list shows a thread once it has a live reply
  const replied = bookmarked ? 'true' : 't.reply_count > 0';
  const limit = filtered ? THREAD_FILTER_RESULTS_MAX : input.limit;
  params[5] = limit + 1;
  // channel-name matches first, then the threads whose messages match, each newest first
  const nameFirst = patterns.length > 0 ? `(${patterns.map((p) => `${folded("coalesce(c.name, '')")} LIKE ${p}`).join(' OR ')}) DESC, ` : '';
  const res = await tx.query<InboxRow>(
    `SELECT t.root_message_id, t.title, t.reply_count, t.last_reply_at, t.last_reply_at::text AS cursor_ts, m.author_id,
            (f.person_id IS NOT NULL) AS followed, (m.author_id = $2::uuid) AS mine, rs.unread_count,
            lr.id AS last_reply_id, left(lr.body_plain, 240) AS last_reply_plain, lr.author_id AS last_reply_author, lr.created_at AS last_reply_at_ts, ${CHANNEL_REF_COLUMNS}
       FROM ${source} t
       JOIN app.messages m ON m.id = t.root_message_id
       JOIN app.channels c ON c.id = t.channel_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.body_plain, r.author_id, r.created_at FROM app.messages r
          WHERE r.thread_root_id = t.root_message_id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1
       ) lr ON true
       LEFT JOIN app.thread_follows f ON f.person_id = $1 AND f.thread_root_id = t.root_message_id
       LEFT JOIN app.read_state rs ON rs.person_id = $1 AND rs.target_type = 'thread' AND rs.target_id = t.root_message_id
      WHERE ${tabRule} AND ${replied}
        AND ($3::uuid IS NULL OR c.team_id = $3)
        AND ($4::text IS NULL OR (t.last_reply_at, t.root_message_id) < ($4::timestamptz, $5::uuid))
        ${where.map((w) => `AND ${w}`).join('\n        ')}
      ORDER BY ${nameFirst}t.last_reply_at DESC, t.root_message_id DESC
      LIMIT $6`,
    params,
  );
  const more = res.rows.length > limit;
  const page = more ? res.rows.slice(0, limit) : res.rows;
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
  const waiting = rootIds.length > 0 ? await newestWaitingMentions(tx, rootIds) : new Map<string, WaitingMention>();
  const authorOf = await nameAuthors(
    tx,
    [...participants.values()].flatMap((p) => p.rows.map((x) => x.id)).concat(page.map((r) => r.root_message_id), lastIds, [...waiting.values()].map((w) => w.id)),
  );
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
      lastReply: r.last_reply_id && names.has(r.last_reply_id) ? lastReplyOf(r, names.get(r.last_reply_id)!, authorOf) : null,
      mention: mentionOf(waiting.get(r.root_message_id), authorOf),
    })),
    // a filtered answer is the best matches up to a cap, not a page: there is no next page to ask for
    nextCursor: !filtered && more && last ? encodeCursor(last.cursor_ts, last.root_message_id) : null,
  });
}

const oneLine = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

function lastReplyOf(r: InboxRow, authorName: string, authorOf: Map<string, NamedAuthor>): Record<string, unknown> {
  const author = r.last_reply_author ? authorOf.get(r.last_reply_author) : undefined;
  return {
    authorName,
    preview: oneLine(r.last_reply_plain),
    ...(author ? { authorId: author.actorId, kind: author.kind } : {}),
    ...(r.last_reply_at_ts ? { at: r.last_reply_at_ts.toISOString() } : {}),
    ...(r.last_reply_id ? { messageId: r.last_reply_id } : {}),
  };
}

type WaitingMention = { id: string; author_id: string; at: Date; plain: string };

/** Per thread, the newest message that waits on the caller (`unanswered`). One read for the page. */
async function newestWaitingMentions(tx: PluginTx, rootIds: string[]): Promise<Map<string, WaitingMention>> {
  const res = await tx.query<WaitingMention & { root_id: string }>(
    `SELECT DISTINCT ON (t.root_id) t.root_id, um.id, um.author_id, um.created_at AS at, left(um.body_plain, 240) AS plain
       FROM unnest($1::uuid[]) AS t(root_id)
       JOIN app.messages um ON (um.thread_root_id = t.root_id OR um.id = t.root_id)
       JOIN app.message_mentions umt ON umt.message_id = um.id AND umt.mentioned_id = $2::uuid AND umt.kind <> 'channel'
      WHERE um.deleted_at IS NULL AND um.author_id <> $2::uuid AND um.created_at > now() - interval '${String(THREAD_MENTION_DAYS)} days'
        AND NOT EXISTS (SELECT 1 FROM app.messages me WHERE (me.thread_root_id = t.root_id OR me.id = t.root_id) AND me.author_id = $2::uuid AND me.deleted_at IS NULL AND me.id > um.id)
      ORDER BY t.root_id, um.id DESC`,
    [rootIds, tx.actor.id],
  );
  return new Map(res.rows.map((r) => [r.root_id, { id: r.id, author_id: r.author_id, at: r.at, plain: r.plain }]));
}

function mentionOf(w: WaitingMention | undefined, authorOf: Map<string, NamedAuthor>): Record<string, unknown> | null {
  const author = w ? authorOf.get(w.author_id) : undefined;
  if (!w || !author) return null;
  return { messageId: w.id, authorId: author.actorId, authorName: author.displayName, kind: author.kind, at: w.at.toISOString(), preview: oneLine(w.plain) };
}

/** An author as the lookup names them; the response schema brands the id and checks the kind. */
type NamedAuthor = { actorId: string; displayName: string; kind: string };
/** The most authors `personAuthors` asks about (the author lookup looks at 500 messages at most); a person past it is left out, and so are their threads (fails closed). */
const PERSON_AUTHORS_MAX = 500;

/**
 * The authors of the messages the caller can read who are people: each distinct author found by a skip scan of the `messages_author` index (one step per author, not one
 * per message), one readable message of each given to the visibility-checked author lookup, which says each one's kind. One query, whatever the number of threads.
 */
async function personAuthors(tx: PluginTx): Promise<string[]> {
  const res = await tx.query<{ actor_id: string }>(
    `WITH RECURSIVE a(id) AS (
       (SELECT author_id FROM app.messages ORDER BY author_id LIMIT 1)
       UNION ALL
       SELECT (SELECT m.author_id FROM app.messages m WHERE m.author_id > a.id ORDER BY m.author_id LIMIT 1) FROM a WHERE a.id IS NOT NULL
     )
     SELECT ma.actor_id FROM app.message_authors(ARRAY(
       SELECT (SELECT m.id FROM app.messages m WHERE m.author_id = a.id LIMIT 1) FROM a WHERE a.id IS NOT NULL LIMIT ${String(PERSON_AUTHORS_MAX)}
     )) ma WHERE ma.kind = 'person'`,
  );
  return res.rows.map((r) => r.actor_id);
}

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
