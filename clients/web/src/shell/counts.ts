import { useMemo } from 'react';
import { useUnread } from '../channels/hooks';

/**
 * Counters the sidebar badges read, by source name (`threads.unread`, `approvals.waiting`). The read-state service feeds
 * `threads.unread` (threads with replies the person has not read); a source with no count shows nothing.
 */
export type NavCounts = Readonly<Record<string, number>>;

export function useNavCounts(): NavCounts {
  const { threadsUnread } = useUnread();
  return useMemo(() => ({ 'threads.unread': threadsUnread }), [threadsUnread]);
}
