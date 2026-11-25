import { useMeetingSpaces } from './spaces';
import { useLive } from './store';

/** In the sidebar, on the Meetings entry: a live dot while a call is going in any of the person's meeting spaces, with how many when more than one. Nothing otherwise. */
export function MeetingsNavBadge() {
  const spaces = useMeetingSpaces();
  const live = useLive();
  const n = spaces.status === 'ok' ? spaces.data.spaces.filter((s) => live.byChannel.has(s.channelId)).length : 0;
  if (n === 0) return null;
  const label = n === 1 ? 'A meeting is live' : `${String(n)} meetings are live`;
  return (
    <span className="live-badge" data-testid="meetings-live" role="img" aria-label={label} title={label}>
      <span className="live-dot" aria-hidden="true" />
      {n > 1 ? <span className="live-more" aria-hidden="true">{n}</span> : null}
    </span>
  );
}
