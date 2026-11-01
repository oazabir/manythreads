import type { PluginTx } from '@manythreads/sdk';
import type { PollView } from '@manythreads/shared';
import { POLL_MINE_JOIN, POLL_SELECT, toPollView, type PollRow } from './rows.ts';

// The read side of polls, kept apart from the write side (polls.ts) because the message feed needs it and polls.ts needs the feed's post door.

/** A message is a poll when its `meta` carries the poll's id (written once, when the poll is posted). */
export function pollIdOf(meta: Record<string, unknown>): string | undefined {
  const p = meta['poll'];
  if (typeof p !== 'object' || p === null) return undefined;
  const id = (p as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * The polls of these messages as the caller sees them, by message id: the totals, whether the poll counts as closed, and the caller's own ballot.
 * A deleted message shows no poll. The caller's row-level security decides which polls exist for them; asks the database only when a message is a poll.
 */
export async function pollsFor(
  tx: PluginTx,
  messages: readonly { id: string; meta: Record<string, unknown>; deleted_at: Date | null }[],
): Promise<Map<string, PollView>> {
  const out = new Map<string, PollView>();
  const ids = messages.filter((m) => !m.deleted_at && pollIdOf(m.meta) !== undefined).map((m) => m.id);
  if (ids.length === 0) return out;
  const res = await tx.query<PollRow>(`SELECT ${POLL_SELECT} FROM app.polls p ${POLL_MINE_JOIN} WHERE p.message_id = ANY ($1::uuid[])`, [ids]);
  for (const r of res.rows) out.set(r.message_id, toPollView(r));
  return out;
}

/** A poll with whether its message was deleted (a deleted message keeps its row, and so its poll; the poll is then not shown and takes no action). */
export type PollWithState = PollRow & { message_deleted: boolean };

/**
 * One poll of a channel by its id, as the caller sees it; undefined when it is not there for them. One query: the poll, the caller's ballot, and whether
 * the poll's message was deleted.
 */
export async function findPoll(tx: PluginTx, channelId: string, pollId: string): Promise<PollWithState | undefined> {
  const res = await tx.query<PollWithState>(
    `SELECT ${POLL_SELECT}, (m.deleted_at IS NOT NULL) AS message_deleted
       FROM app.polls p ${POLL_MINE_JOIN} JOIN app.messages m ON m.id = p.message_id
      WHERE p.id = $1 AND p.channel_id = $2`,
    [pollId, channelId],
  );
  return res.rows[0];
}
