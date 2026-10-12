import { useMemo } from 'react';
import { useUnread } from '../channels/hooks';
import { useApprovalsWaiting } from '../screens/approvals/count';

/**
 * Counters the sidebar badges read, by source name (`threads.unread`, `approvals.waiting`). The read-state service feeds
 * `threads.unread` (threads with replies the person has not read); the approvals plugin feeds `approvals.waiting` (what waits in
 * the team, kept live by its push); a source with no count shows nothing.
 */
export type NavCounts = Readonly<Record<string, number>>;

export function useNavCounts(teamSlug: string | null): NavCounts {
  const { threadsUnread } = useUnread();
  const waiting = useApprovalsWaiting(teamSlug);
  return useMemo(() => ({ 'threads.unread': threadsUnread, 'approvals.waiting': waiting }), [threadsUnread, waiting]);
}
