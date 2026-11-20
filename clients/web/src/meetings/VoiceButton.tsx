import { isMockMode } from '../api/setup';
import { useHeaderItem } from '../shell/headerMenu';
import { HeadphonesIcon, PhoneIcon, WaveIcon } from './icons';
import { voiceIconAction } from './roomCard';
import { callController, useCall, useLiveRoom } from './store';

/** The card's Join button of this room takes the keyboard once the message has been scrolled into view (the list may draw it a moment later). */
function focusRoomJoin(meetingId: string): void {
  const until = Date.now() + 800;
  const look = (): void => {
    const btn = document.querySelector<HTMLButtonElement>(`[data-testid="room-card"][data-meeting-id="${CSS.escape(meetingId)}"] [data-testid="room-card-join"]`);
    if (btn) btn.focus({ preventScroll: true });
    else if (Date.now() < until) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * The voice icon in a channel's header, "Call" in a direct message's (P33-01). One square icon button like its neighbours; the words are its name and tooltip.
 * With no room live it starts one. With a room live in a channel it scrolls to the message that started it, whose card has Join (`messageLoaded` answers whether
 * that message is in the list, `showMessage` brings it into view and marks it); when the message is not loaded, and in a direct message, it joins the room straight away. A small green dot says a room is live.
 * While the person is in the room it is a state, not a button: "In this call". Asking the server to start a room that is live joins that room, so two people
 * pressing Start at once end up together.
 */
export function VoiceButton({ channelId, dm, messageLoaded, showMessage }: { channelId: string; dm: boolean; messageLoaded?: (messageId: string) => boolean; showMessage?: (messageId: string) => void }) {
  const call = useCall();
  const live = useLiveRoom(channelId);
  const mock = isMockMode();
  const inHere = call.meeting?.channelId === channelId && (call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost');
  const busy = call.phase === 'starting' || call.phase === 'connecting';
  const root = live?.meeting.threadRootId ?? null;
  const action = voiceIconAction({ live: live !== undefined, dm, messageLoaded: root !== null && messageLoaded !== undefined && showMessage !== undefined && messageLoaded(root) });
  const found = action === 'show-message';
  const label = dm ? (live ? 'Join the call' : 'Call') : live ? (found ? 'A voice room is live: join it from its message' : 'Join the voice room') : 'Start a voice room';
  const title = live ? `${label} (${live.present.length} in it now)` : dm ? 'Call by voice' : label;
  const here = dm ? 'In this call' : 'In the voice room';
  const press = (): void => {
    if (action === 'show-message' && root !== null) {
      showMessage?.(root);
      if (live) focusRoomJoin(live.meeting.id);
      return;
    }
    // a live room is joined, not started: a guest may join a room of a channel they are in but may not start one (the server refuses the start with 403)
    void (live ? callController().joinRoom(live.meeting.id, channelId) : callController().start(channelId));
  };
  // on a phone the icon is not in the header: the details menu carries the same action under the same name (P34-05); while in the room it is a state there too
  useHeaderItem(channelId, mock ? null : inHere ? { key: 'voice', label: here, testId: 'details-voice', disabled: true } : { key: 'voice', label, testId: 'details-voice', disabled: busy }, press);
  if (mock) return null;
  if (inHere) {
    return (
      <span className="call-here chv-tool chv-voice" data-testid="call-in-here" role="status">
        <WaveIcon />
        <span>{here}</span>
      </span>
    );
  }
  return (
    <button type="button" className={`icon-btn chv-tool chv-voice call-start ${live ? 'chv-live' : ''}`} data-testid="call-start" data-action={action} disabled={busy} aria-label={label} title={title} onClick={press}>
      {dm ? <PhoneIcon /> : <HeadphonesIcon />}
      {live ? <span className="chv-live-dot" aria-hidden="true" /> : null}
    </button>
  );
}
