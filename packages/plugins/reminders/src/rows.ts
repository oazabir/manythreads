import { LATER_SNIPPET_MAX, LaterItem, type LaterMessage } from '@manythreads/shared';

// The one place a `later_items` row, joined with the message it points at, becomes the shared `LaterItem`.

/** `later_items` joined to its message and channel as the caller's own row-level security lets them see it. */
export interface LaterRow extends Record<string, unknown> {
  id: string;
  message_id: string;
  state: 'open' | 'done';
  remind_at: Date | null;
  created_at: Date;
  done_at: Date | null;
  /** The message can be read by the caller right now and is not deleted. */
  readable: boolean;
  author_id: string | null;
  body_plain: string | null;
  message_created_at: Date | null;
  thread_root_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  channel_kind: string | null;
  channel_team_id: string | null;
}

/** `FROM app.later_items l LEFT JOIN app.messages m ... LEFT JOIN app.channels c ...`: every column `toLaterItem` reads. */
export const LATER_COLUMNS = `l.id, l.message_id, l.state, l.remind_at, l.created_at, l.done_at,
  (m.id IS NOT NULL AND m.deleted_at IS NULL AND c.id IS NOT NULL) AS readable,
  m.author_id, left(m.body_plain, 600) AS body_plain, m.created_at AS message_created_at, m.thread_root_id,
  c.id AS channel_id, c.name AS channel_name, c.kind AS channel_kind, c.team_id AS channel_team_id`;

/** One line of at most 200 characters from a message's plain text. */
export function snippetOf(plain: string): string {
  const line = plain.replace(/\s+/g, ' ').trim();
  if (line === '') return '(no text)';
  const chars = [...line];
  return chars.length > LATER_SNIPPET_MAX ? `${chars.slice(0, LATER_SNIPPET_MAX - 1).join('')}…` : line;
}

/**
 * `authors` maps an author's actor id to a name (the channels plugin's `app.message_authors`, which names only authors of messages the caller can
 * read). A message that is deleted, gone or unreadable becomes `message: null`: none of its text, author or channel is carried.
 */
export function toLaterItem(r: LaterRow, authors: ReadonlyMap<string, string>, now: Date): LaterItem {
  let message: LaterMessage | null = null;
  if (r.readable && r.author_id && r.channel_id && r.channel_kind && r.message_created_at) {
    message = {
      channel: { id: r.channel_id, name: r.channel_name ?? '', kind: r.channel_kind, teamId: r.channel_team_id },
      threadRootId: r.thread_root_id,
      authorId: r.author_id,
      authorName: authors.get(r.author_id) ?? 'Someone',
      snippet: snippetOf(r.body_plain ?? ''),
      messageCreatedAt: r.message_created_at.toISOString(),
    } as LaterMessage;
  }
  return LaterItem.parse({
    id: r.id,
    messageId: r.message_id,
    state: r.state,
    remindAt: r.remind_at ? r.remind_at.toISOString() : null,
    due: r.state === 'open' && r.remind_at !== null && r.remind_at.getTime() <= now.getTime(),
    createdAt: r.created_at.toISOString(),
    doneAt: r.done_at ? r.done_at.toISOString() : null,
    message,
  });
}
