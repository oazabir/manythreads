import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { isMockMode } from '../api/setup';
import { usePanel } from '../kernel/panel/usePanel';
import { useShell } from '../shell/context';
import { useNarrow } from '../shell/useNarrow';
import { CallDock } from './CallDock';
import { isMuteShortcut, isPushToTalkKey, ringText } from './model';
import { callController, liveRooms, useCall, useLive } from './store';

/*
 * Mounted once in the app shell. It wires the call to the page: the chat thread opens in the right panel, the keyboard (Ctrl/Cmd+Shift+Space mutes, holding Space
 * talks in push-to-talk), the unread count follows whether the chat is on screen, and an incoming call in a direct message rings. Draws the docked bar.
 */

function IncomingCalls() {
  const live = useLive();
  const call = useCall();
  const navigate = useNavigate();
  const { teamSlug, team } = useShell();
  const slug = teamSlug ?? team?.slug ?? null;
  if (live.rings.length === 0) return null;
  return (
    <div className="ring-stack" role="region" aria-label="Incoming calls">
      {live.rings.map((r) => (
        <div key={r.meetingId} className="ring-card" role="alertdialog" aria-label={ringText(r)} data-testid="incoming-call">
          <div className="ring-text">
            <b className="ring-title">{ringText(r)}</b>
            <span className="ring-sub">{call.meeting ? 'Answering leaves your current call.' : 'Ringing for 30 seconds.'}</span>
          </div>
          <div className="ring-actions">
            <button
              type="button"
              className="btn primary s"
              data-testid="incoming-accept"
              onClick={() => {
                liveRooms().stopRinging(r.meetingId);
                void callController().joinRoom(r.meetingId, r.channelId);
                if (slug) navigate(`/t/${slug}/dm/${r.channelId}`);
              }}
            >
              Answer
            </button>
            <button type="button" className="btn s" data-testid="incoming-decline" onClick={() => liveRooms().stopRinging(r.meetingId)}>Decline</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MeetingHost() {
  const panel = usePanel();
  const call = useCall();
  const c = callController();
  const top = panel.top();
  const narrow = useNarrow();

  // the chat opens beside the call; on a phone the panel is a full sheet that would hide the call bar, so there it opens only when the person presses Chat
  useEffect(() => {
    c.setHooks({
      openChat: (threadRootId, _channelId, opts) => {
        if (opts?.automatic && narrow) return;
        panel.push({ type: 'thread', id: threadRootId });
      },
    });
  });

  // the unread count follows whether the call's thread is on screen
  const root = call.meeting?.threadRootId ?? null;
  const chatShown = root !== null && top?.type === 'thread' && top.id === root;
  useEffect(() => {
    c.setChatOpen(chatShown);
  }, [c, chatShown]);

  // keyboard: mute from anywhere, hold Space to talk
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      const s = c.getState();
      const inCall = s.phase === 'connected' || s.phase === 'reconnecting';
      if (!inCall) return;
      if (isMuteShortcut(e)) {
        e.preventDefault();
        if (!e.repeat) c.toggleMute();
        return;
      }
      if (s.pushToTalk && isPushToTalkKey(e, e.target as HTMLElement | null)) {
        e.preventDefault();
        if (!e.repeat) c.talk(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (c.getState().pushToTalk && (e.code === 'Space' || e.key === ' ')) c.talk(false);
    };
    const blur = (): void => c.talk(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [c]);

  // leaving the page ends the person's side of the call; the server also counts a silent person as gone after three minutes
  useEffect(() => {
    const bye = (): void => {
      const s = c.getState();
      if (s.meeting && (s.phase === 'connected' || s.phase === 'reconnecting')) void c.leave();
    };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, [c]);

  if (isMockMode()) return null;
  return (
    <>
      <IncomingCalls />
      <CallDock />
    </>
  );
}
