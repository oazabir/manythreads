import { Avatar } from '../components/ui';
import { badgeFaces, liveLabel } from './model';
import { useLiveRoom } from './store';

/** In the sidebar, on a channel or a conversation with a live voice room: a small live mark and the faces of the people in it. Nothing when there is no room. */
export function LiveBadge({ channelId, dm = false }: { channelId: string; dm?: boolean }) {
  const room = useLiveRoom(channelId);
  if (!room) return null;
  const { faces, more } = badgeFaces(room.present);
  return (
    <span className="live-badge" data-testid="live-badge" role="img" aria-label={liveLabel(room, dm ? 'conversation' : 'channel')} title={liveLabel(room, dm ? 'conversation' : 'channel')}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-faces" aria-hidden="true">
        {faces.map((p) => (
          <Avatar key={p.actorId} name={p.displayName} personId={p.personId} />
        ))}
        {more > 0 ? <span className="live-more">+{more}</span> : null}
      </span>
    </span>
  );
}
