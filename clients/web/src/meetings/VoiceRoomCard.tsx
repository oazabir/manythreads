import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/client';
import { usePeople } from '../channels/hooks';
import { channelStore } from '../channels/store';
import { Avatar } from '../components/ui';
import { isMockMode } from '../api/setup';
import { endMeeting } from './api';
import { EndRoomConfirm } from './EndRoomConfirm';
import { WaveIcon } from './icons';
import { roomCardFacts } from './roomCard';
import { callController, liveRooms, useCall, useRoomOfMessage } from './store';

/**
 * The card under a "Started a voice room" message while that room is live (P33-03): the room's title, who is in it, a Join button (or "You are in this room"), and for
 * the person who started it End room, which asks once. It draws nothing for any other message and after the room has ended: the message is plain text again.
 */
export function VoiceRoomCard({ messageId, channelId }: { messageId: string; channelId: string }) {
  const room = useRoomOfMessage(messageId);
  if (!room || isMockMode()) return null;
  return <RoomCardBody room={room} channelId={channelId} />;
}

export function RoomCardBody({ room, channelId }: { room: NonNullable<ReturnType<typeof useRoomOfMessage>>; channelId: string }) {
  const call = useCall();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inCall = call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost';
  // the reader's actor id: from the roster once it has answered (the card may be drawn before), else what the store already knows
  const people = usePeople();
  const facts = roomCardFacts(room, people.me?.actorId ?? channelStore.selfActor, inCall ? (call.meeting?.id ?? null) : null);
  const joining = call.phase === 'starting' || call.phase === 'connecting';
  const endButton = useRef<HTMLButtonElement>(null);
  const focusEnd = useRef(false);
  // Cancel and Esc put the keyboard back on the End room button that asked
  useEffect(() => {
    if (!asking && focusEnd.current) {
      focusEnd.current = false;
      endButton.current?.focus();
    }
  }, [asking]);
  const cancel = (): void => {
    focusEnd.current = true;
    setAsking(false);
  };

  const stillLive = (): boolean => liveRooms().snapshot().rooms.some((r) => r.meeting.id === room.meeting.id && r.meeting.state === 'live');
  const end = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      // the starter is in the room: ending it from the card must also close their own call, which only the call controller does
      if (facts.inRoom) await callController().endForAll();
      else await endMeeting(room.meeting.id);
      // the card stays "Ending…" until the list of live rooms has heard of it, so it never flashes back to Join
      await liveRooms().refresh();
      if (stillLive()) setProblem('Could not end the voice room. Try again.');
      else setAsking(false);
    } catch (e) {
      if (isApiError(e) && (e.status === 404 || e.status === 409)) {
        // someone else ended it first (or it is already over): the card goes with the next list
        await liveRooms().refresh();
        setAsking(false);
      } else {
        setProblem('Could not end the voice room. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="room-card" data-testid="room-card" data-meeting-id={room.meeting.id}>
      <div className="room-card-head">
        <span className="room-card-ico" aria-hidden="true"><WaveIcon /></span>
        <div className="room-card-text">
          <p className="room-card-title" title={facts.title}>{facts.title}</p>
          <p className="room-card-count" data-testid="room-card-count">
            {facts.faces.length > 0 ? (
              <span className="room-card-faces" aria-hidden="true">
                {facts.faces.map((p) => <Avatar key={p.actorId} name={p.displayName} personId={p.personId} />)}
              </span>
            ) : null}
            <span>{facts.countText}{facts.more > 0 ? ` (+${facts.more})` : ''}</span>
          </p>
        </div>
      </div>
      {asking ? (
        <EndRoomConfirm inRoom={facts.faces.length + facts.more} busy={busy} onEnd={() => void end()} onCancel={cancel} />
      ) : (
        <div className="room-card-actions">
          {facts.inRoom ? (
            <span className="room-card-in" data-testid="room-card-in"><WaveIcon /> You are in this room</span>
          ) : (
            <button type="button" className="btn primary s room-card-join" data-testid="room-card-join" disabled={joining} onClick={() => void callController().joinRoom(room.meeting.id, channelId)}>Join</button>
          )}
          {facts.canEnd ? <button type="button" ref={endButton} className="btn s room-card-end" data-testid="room-card-end" onClick={() => setAsking(true)}>End room</button> : null}
        </div>
      )}
      {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
    </div>
  );
}
