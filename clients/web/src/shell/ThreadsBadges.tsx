import { AtBadgeIcon, RunningIcon } from './icons';
import { badgeText } from './unreadLook';

/** The accessible name of the Threads entry: only the counts that are not zero, in the order of the badges. */
export function threadsLabel({ mentions, unread, running }: { mentions: number; unread: number; running: number }): string {
  const parts = [
    mentions > 0 ? `${mentions} ${mentions === 1 ? 'mention' : 'mentions'}` : null,
    unread > 0 ? `${unread} unread` : null,
    running > 0 ? `${running} ${running === 1 ? 'task' : 'tasks'} in progress` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'Threads' : `Threads, ${parts.join(', ')}`;
}

/**
 * The Threads entry's badges (P29-19): up to three, in this order: threads that name you (an @), unread threads, tasks in progress (a play triangle). A zero draws nothing. The entry's own name and
 * tooltip say all of it in words (the badges are for the eye). Where the row is tight (a phone) CSS keeps the first and turns the rest into one dot.
 */
export function ThreadsBadges({ mentions, unread, running }: { mentions: number; unread: number; running: number }) {
  const shown = [mentions > 0, unread > 0, running > 0].filter(Boolean).length;
  if (shown === 0) return null;
  return (
    <span className="tbs" data-testid="threads-badges" data-count={shown} aria-hidden="true">
      {mentions > 0 ? (
        <span className="pill mention tb" data-testid="threads-badge-mentions" data-vt-mask>
          <AtBadgeIcon />
          {badgeText(mentions)}
        </span>
      ) : null}
      {unread > 0 ? (
        <span className="pill tb" data-testid="threads-badge-unread" data-vt-mask>
          {badgeText(unread)}
        </span>
      ) : null}
      {running > 0 ? (
        <span className="pill g tb" data-testid="threads-badge-running" data-vt-mask>
          <RunningIcon />
          {badgeText(running)}
        </span>
      ) : null}
      {shown > 1 ? <span className="tb-dot" /> : null}
    </span>
  );
}
