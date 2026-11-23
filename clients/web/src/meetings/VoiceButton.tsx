import { useState } from 'react';
import { isMockMode } from '../api/setup';
import { useShell } from '../shell/context';
import { useHeaderItem } from '../shell/headerMenu';
import { CameraIcon, HeadphonesIcon, PhoneIcon, WaveIcon } from './icons';
import { voiceIconAction } from './roomCard';
import { StartCallDialog } from './StartCallDialog';
import { callButtonWords } from './startCall';
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
 * After a start from the dialog the header button is disabled and then replaced by "In this call", so the keyboard would be left on nothing: it goes to the call
 * bar's microphone button once that can be pressed (to Captions, which never waits, if it has not after a few seconds). A person who has already moved the
 * keyboard somewhere else keeps it there.
 */
export function focusCallBar(): void {
  const until = Date.now() + 6_000;
  const free = (): boolean => {
    const a = document.activeElement;
    return a === null || a === document.body || (a instanceof HTMLElement && a.closest('.chv-voice') !== null);
  };
  const look = (): void => {
    if (!free()) return;
    const mic = document.querySelector<HTMLButtonElement>('[data-testid="call-dock"] [data-testid="call-mute"]');
    if (mic && !mic.disabled) {
      mic.focus();
      return;
    }
    if (Date.now() < until) {
      requestAnimationFrame(look);
      return;
    }
    document.querySelector<HTMLButtonElement>('[data-testid="call-dock"] [data-testid="call-captions"]')?.focus();
  };
  requestAnimationFrame(look);
}

/**
 * The call button in a channel's header ("Audio call", P15-25; P33-01 before it). One square icon button like its neighbours; the words are its name and tooltip.
 * With no call live it opens the start dialog (title, who to invite, the note-taker). With a call live it is "Join call": in a channel it scrolls to the message
 * that started it, whose card has Join (`messageLoaded` answers whether that message is in the list, `showMessage` brings it into view and marks it); when the
 * message is not loaded, and in a direct message, it joins straight away. A small green dot says a call is live. A guest cannot start one: the button says so
 * and does nothing. While the person is in the call it is a state, not a button: "In this call". Asking the server to start a call that is live joins that call,
 * so two people pressing Start at once end up together.
 */
export function VoiceButton({ channelId, dm, messageLoaded, showMessage }: { channelId: string; dm: boolean; messageLoaded?: (messageId: string) => boolean; showMessage?: (messageId: string) => void }) {
  const call = useCall();
  const live = useLiveRoom(channelId);
  const { guest } = useShell();
  const mock = isMockMode();
  // which start dialog is open: an audio call, a video call (P36-02), or none
  const [dialog, setDialog] = useState<false | 'audio' | 'video'>(false);
  const inHere = call.meeting?.channelId === channelId && (call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost');
  const busy = call.phase === 'starting' || call.phase === 'connecting';
  const root = live?.meeting.threadRootId ?? null;
  const action = voiceIconAction({ live: live !== undefined, dm, messageLoaded: root !== null && messageLoaded !== undefined && showMessage !== undefined && messageLoaded(root) });
  const words = callButtonWords({ live: live !== undefined, guest, dm });
  const title = live ? `${words.label} (${live.present.length} in it now)` : words.title;
  const here = 'In this call';
  const press = (): void => {
    if (action === 'show-message' && root !== null) {
      showMessage?.(root);
      if (live) focusRoomJoin(live.meeting.id);
      return;
    }
    // a live call is joined, not started: a guest may join a call of a channel they are in but may not start one
    if (live) {
      void callController().joinRoom(live.meeting.id, channelId);
      return;
    }
    if (words.blocked !== null) return;
    setDialog('audio');
  };
  // on a phone the icon is not in the header: the details menu carries the same action under the same name (P34-05); while in the call it is a state there too
  useHeaderItem(
    channelId,
    mock
      ? null
      : inHere
        ? { key: 'voice', label: here, testId: 'details-voice', disabled: true }
        : { key: 'voice', label: words.blocked !== null ? `${words.label}: ${words.blocked.toLowerCase()}` : words.label, testId: 'details-voice', disabled: busy || words.blocked !== null, popup: !live },
    press,
  );
  if (mock) return null;
  const startDialog = dialog ? (
    <StartCallDialog
      channelId={channelId}
      kind={dialog}
      onClose={() => setDialog(false)}
      onStarted={() => {
        setDialog(false);
        focusCallBar();
      }}
    />
  ) : null;
  if (inHere) {
    return (
      <>
        <span className="call-here chv-tool chv-voice" data-testid="call-in-here" role="status">
          <WaveIcon />
          <span>{here}</span>
        </span>
        {startDialog}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`icon-btn chv-tool chv-voice call-start ${live ? 'chv-live' : ''}`}
        data-testid="call-start"
        data-action={action}
        disabled={busy}
        aria-disabled={words.blocked !== null || undefined}
        aria-haspopup={live ? undefined : 'dialog'}
        aria-label={words.label}
        title={title}
        onClick={press}
      >
        {dm ? <PhoneIcon /> : <HeadphonesIcon />}
        {live ? <span className="chv-live-dot" aria-hidden="true" /> : null}
      </button>
      {/* a video call (P36-02): only while no call is live here, since a channel has one call at a time (Join joins whichever kind is live) */}
      {!live && words.blocked === null ? (
        <button type="button" className="icon-btn chv-tool chv-voice call-start-video" data-testid="call-start-video" disabled={busy} aria-haspopup="dialog" aria-label="Video call" title={dm ? 'Video call: ring everyone in this conversation' : 'Video call: start a call with cameras here'} onClick={() => setDialog('video')}>
          <CameraIcon />
        </button>
      ) : null}
      {startDialog}
    </>
  );
}
