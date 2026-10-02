import type { PluginTx } from '@manythreads/sdk';
import { ListThreadsResponse, type ThreadsTab } from '@manythreads/shared';
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
            (f.person_id IS NOT NULL) AS followed, (m.author_id = $2::uuid) AS mine, rs.unread_count, ${CHANNEL_REF_COLUMNS}
       FROM app.threads t
       JOIN app.messages m ON m.id = t.root_message_id
       JOIN app.channels c ON c.id = t.channel_id
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
    })),
    nextCursor: more && last ? encodeCursor(last.cursor_ts, last.root_message_id) : null,
  });
}
