import { useEffect, useSyncExternalStore } from 'react';
import { useDms } from '../dms/store';
import { useSession } from '../app/session';
import { useUnread } from '../channels/hooks';
import { levelsStore } from '../notifications/levelsStore';
import { notificationStore } from '../notifications/store';
import { levelOf } from '../notifications/settingsModel';
import { useMyDnd } from '../presence/hooks';
import { drawFavicon } from './favicon';
import { attentionCount, documentTitle, faviconState } from './tabState';

/**
 * Keeps the browser tab honest (P21-09): the title and the icon say what waits. Unread, unmuted DMs come from the read state; channel
 * mentions come from the bell's unread count (the server does not yet send a separate `mentionCount`, so the larger of the two is used
 * and nothing is counted twice). Do not disturb makes the count zero.
 */
export function useTabState({ place, team, enabled }: { place: string; team: string | null; enabled: boolean }): void {
  const session = useSession();
  const dms = useDms(enabled);
  const { unread } = useUnread();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  const bell = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  useEffect(() => {
    if (enabled) void levelsStore.load();
  }, [enabled]);
  const dnd = useMyDnd().banner !== null;
  const dmUnread = dms.items
    .filter((d) => levelOf(levels, d.channel.id, 'dm').effective !== 'nothing')
    .map((d) => unread[d.channel.id] ?? d.unreadCount);
  const dmTotal = dmUnread.reduce((a, b) => a + b, 0);
  const count = attentionCount({ dmUnread, mentionCount: Math.max(0, bell.unread - dmTotal), dnd });
  const title = documentTitle({ count, place, team, workspace: session.workspace.name });
  const fav = faviconState(count, dnd);
  useEffect(() => {
    if (enabled) document.title = title;
  }, [title, enabled]);
  useEffect(() => {
    if (enabled) void drawFavicon({ dot: fav.dot, text: fav.text });
  }, [fav.dot, fav.text, enabled]);
  // leaving the shell (sign-out, a page with its own frame): the plain icon and title come back, so no stale dot or count is left behind
  useEffect(() => {
    const before = document.title;
    return () => {
      void drawFavicon({ dot: false, text: null });
      document.title = before;
    };
  }, []);
}

