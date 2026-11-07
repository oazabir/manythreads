import { useMemo } from 'react';
import { useQuery } from '../../app/useQuery';
import { useUnread } from '../../channels/hooks';
import { listChats } from './api';

/** The bot whose chats the sidebar's Chat badge counts. */
const BADGE_BOT = 'brain';

/**
 * How many of the person's chats with Brain have an answer they have not read: the Chat entry's badge (`chat.unread`). It is asked for again whenever the
 * count of threads with unread replies moves, which is when an answer arrives or is read. A team without that bot, counts nothing (a guest has no team here, so none is asked).
 */
export function useChatUnread(teamSlug: string | null): number {
  const { threadsUnread } = useUnread();
  const q = useQuery(`chat-unread:${teamSlug ?? ''}:${String(threadsUnread)}`, () =>
    teamSlug ? listChats({ team: teamSlug, bot: BADGE_BOT }, {}).catch(() => null) : Promise.resolve(null),
  );
  return useMemo(() => (q.status === 'ok' && q.data ? q.data.items.filter((i) => i.unreadCount > 0).length : 0), [q]);
}
