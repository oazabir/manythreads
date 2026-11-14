/**
 * The thread panel's "Jump to latest" pill: how many replies from others arrived since the reader scrolled away from the bottom, and
 * what the pill says. Pure, so the panel computes the count at render (a resync that reloads the same replies gives the same count).
 */

/** Closer to the bottom than this (px) and the reader is at the newest reply: the list stays pinned there and no pill is drawn. */
export const AT_BOTTOM_PX = 40;

export const atBottom = (distance: number): boolean => distance < AT_BOTTOM_PX;

/**
 * Replies newer than `seenUpTo` (the newest reply id when the reader left the bottom) that are not deleted and not the reader's own.
 * Ids are time-ordered, so an older page loaded with "Earlier replies" is at or below the watermark and never counts. No reader: 0.
 */
export function newReplyCount(
  replies: readonly { id: string; deletedAt: string | null; authorId: string | null }[],
  seenUpTo: string | null,
  selfId: string | null,
): number {
  if (selfId === null) return 0;
  let n = 0;
  for (const r of replies) if ((seenUpTo === null || r.id > seenUpTo) && r.deletedAt === null && r.authorId !== selfId) n += 1;
  return n;
}

/** The pill's words, as the channel's own pill says them for messages. */
export const jumpLabel = (count: number): string => (count > 0 ? `${count} new ${count === 1 ? 'reply' : 'replies'}` : 'Jump to latest');

/** The pill's accessible name: what it does, and the count when there is one. */
export const jumpAriaLabel = (count: number): string => (count > 0 ? `Jump to latest, ${jumpLabel(count)}` : 'Jump to latest');
