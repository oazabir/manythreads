import { useMemo } from 'react';
import { useUnread } from '../channels/hooks';
import { useApprovalsWaiting } from '../screens/approvals/count';
import { useChatUnread } from '../screens/chat/unread';

/**
 * Counters the sidebar badges read, by source name (`chat.unread`, `threads.unread`, `approvals.waiting`). The read-state service feeds
 * `threads.unread` (threads with replies the person has not read); the approvals plugin feeds `approvals.waiting` (what waits in
 * the team, kept live by its push) and `approvals.overdue` (how many of those have waited over a day: the badge turns amber); a source with no count shows nothing.
 */
export type NavCounts = Readonly<Record<string, number>>;

export function useNavCounts(teamSlug: string | null): NavCounts {
  const { threadsUnread } = useUnread();
  const { waiting, overdue } = useApprovalsWaiting(teamSlug);
  const chat = useChatUnread(teamSlug);
  return useMemo(() => ({ 'chat.unread': chat, 'threads.unread': threadsUnread, 'approvals.waiting': waiting, 'approvals.overdue': overdue }), [chat, threadsUnread, waiting, overdue]);
}
