import { useMemo } from 'react';
import { useUnread } from '../channels/hooks';
import { useApprovalsWaiting } from '../screens/approvals/count';
import { useChatUnread } from '../screens/chat/unread';
import { useThreadsBadge } from '../inbox/useThreadsBadge';

/**
 * Counters the sidebar badges read, by source name (`chat.unread`, `threads.unread`, `approvals.waiting`). The read-state service feeds
 * `threads.unread` (threads with replies the person has not read), `threads.mentions` (threads that wait on the person because a message names them) and `threads.running` (threads where a run is going); the approvals plugin feeds `approvals.waiting` (what waits in
 * the team, kept live by its push) and `approvals.overdue` (how many of those have waited over a day: the badge turns amber); a source with no count shows nothing.
 */
export type NavCounts = Readonly<Record<string, number>>;

export function useNavCounts(teamSlug: string | null): NavCounts {
  const { threadsUnread } = useUnread();
  const { waiting, overdue } = useApprovalsWaiting(teamSlug);
  const chat = useChatUnread(teamSlug);
  const threads = useThreadsBadge(teamSlug);
  return useMemo(
    () => ({ 'chat.unread': chat, 'threads.unread': threadsUnread, 'threads.mentions': threads.mentions, 'threads.running': threads.running, 'approvals.waiting': waiting, 'approvals.overdue': overdue }),
    [chat, threadsUnread, threads.mentions, threads.running, waiting, overdue],
  );
}
