import { isMockMode } from '../api/setup';
import { PhoneIcon, WaveIcon } from './icons';
import { callController, useCall, useLiveRoom } from './store';

/**
 * "Start voice room" in a channel's header, "Call" in a direct message's. When a room is already live there it says "Join voice room" (or "Join call"); while the
 * person is in it, it says so and does nothing. Asking the server to start a room that is live joins that room, so two people pressing Start at once end up together.
 */
export function StartButton({ channelId, dm }: { channelId: string; dm: boolean }) {
  const call = useCall();
  const live = useLiveRoom(channelId);
  if (isMockMode()) return null;
  const inHere = call.meeting?.channelId === channelId && (call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost');
  const busy = call.phase === 'starting' || call.phase === 'connecting';
  if (inHere) {
    return (
      <span className="call-here" data-testid="call-in-here">
        <WaveIcon />
        <span>{dm ? 'In this call' : 'In the voice room'}</span>
      </span>
    );
  }
  const label = live ? (dm ? 'Join call' : 'Join voice room') : dm ? 'Call' : 'Start voice room';
  return (
    <button
      type="button"
      className={`btn call-start ${live ? 'live' : ''}`}
      data-testid="call-start"
      disabled={busy}
      aria-label={dm ? (live ? 'Join the call' : 'Call') : label}
      title={live ? `${live.present.length} in the room now` : dm ? 'Call by voice' : 'Open a voice room for this channel'}
      onClick={() => void callController().start(channelId)}
    >
      <PhoneIcon />
      <span className="call-start-label">{label}</span>
    </button>
  );
}
