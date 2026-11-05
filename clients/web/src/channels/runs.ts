import type { ChannelMessage } from '@manythreads/shared';
import { dayKey } from './format';

/** Messages by the same author this close together share one avatar and name (P21-01). */
export const RUN_GAP_MS = 5 * 60_000;

type RunMessage = Pick<ChannelMessage, 'authorId' | 'createdAt' | 'deletedAt' | 'replyCount' | 'reactions' | 'meta' | 'author' | 'forward' | 'poll'>;

/** A message that must show its own header: an Answer, a screen, a poll or a forward is a card, not a line of talk. */
const standsAlone = (m: RunMessage): boolean =>
  m.deletedAt !== null || m.meta.answer !== undefined || m.meta.surfaceRef !== undefined || m.poll !== undefined || m.forward !== undefined || m.author?.kind === 'system';

/**
 * Whether `cur` continues the run that `prev` is part of: the same author, at most five minutes later (exactly five still joins), on the same day,
 * and `prev` has nothing under it (no replies, no reactions) that would separate the two. Cards and deleted messages never join a run.
 */
export function continuesRun(prev: RunMessage | undefined | null, cur: RunMessage): boolean {
  if (!prev) return false;
  if (prev.authorId !== cur.authorId || prev.author?.kind !== cur.author?.kind) return false;
  if (standsAlone(prev) || standsAlone(cur)) return false;
  if (prev.replyCount !== 0 || prev.reactions.length > 0) return false;
  const gap = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
  if (!(gap >= 0 && gap <= RUN_GAP_MS)) return false;
  return dayKey(prev.createdAt) === dayKey(cur.createdAt);
}
