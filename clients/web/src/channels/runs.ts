import type { ChannelMessage } from '@manythreads/shared';
import { dayKey } from './format';

/** Messages by the same author this close together share one avatar and name (P21-01). */
export const RUN_GAP_MS = 5 * 60_000;

type RunMessage = Pick<ChannelMessage, 'authorId' | 'createdAt' | 'deletedAt' | 'replyCount' | 'reactions' | 'meta' | 'author' | 'forward' | 'poll'>;

/** A message that must show its own header: an Answer, a screen, a poll or a forward is a card, not a line of talk. */
const standsAlone = (m: RunMessage): boolean =>
  m.deletedAt !== null || m.meta.answer !== undefined || m.meta.surfaceRef !== undefined || m.poll !== undefined || m.forward !== undefined || m.author?.kind === 'system';

/**
 * Whether a message this tab is still sending (`createdAt` is the tab's clock) continues the run of `prev`, the message or sending row above it: the reader's
 * own message (`selfActor`), within the window, on the same day, and nothing under `prev` that would separate the two. It is the delivered message's own
 * answer, so the header does not appear while it sends and vanish when it arrives (P32-11). The two clocks may differ a little, so the gap is absolute.
 */
export function pendingContinues(prev: RunMessage | { createdAt: string } | undefined | null, selfActor: string | null, createdAt: string): boolean {
  if (!prev || selfActor === null) return false;
  if ('authorId' in prev && (prev.authorId !== selfActor || standsAlone(prev) || prev.replyCount !== 0 || prev.reactions.length > 0)) return false;
  const gap = Math.abs(new Date(createdAt).getTime() - new Date(prev.createdAt).getTime());
  return gap <= RUN_GAP_MS && dayKey(prev.createdAt) === dayKey(createdAt);
}

/**
 * Whether `cur` continues the run that `prev` is part of: the same author, at most five minutes later (exactly five still joins), on the same day,
 * and `prev` has nothing under it (no replies, no reactions) that would separate the two. Cards and deleted messages never join a run.
 */
export function continuesRun(prev: RunMessage | undefined | null, cur: RunMessage): boolean {
  if (!prev) return false;
  // the answer to our own POST has no `author`, a push and a fetch do: the kinds are compared only when both are known
  if (prev.authorId !== cur.authorId || (prev.author && cur.author && prev.author.kind !== cur.author.kind)) return false;
  if (standsAlone(prev) || standsAlone(cur)) return false;
  if (prev.replyCount !== 0 || prev.reactions.length > 0) return false;
  const gap = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
  if (!(gap >= 0 && gap <= RUN_GAP_MS)) return false;
  return dayKey(prev.createdAt) === dayKey(cur.createdAt);
}
