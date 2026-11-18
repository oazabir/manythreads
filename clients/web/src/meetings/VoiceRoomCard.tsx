import { useState } from 'react';
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
  const facts = roomCardFacts(room, channelStore.selfActor, inCall ? (call.meeting?.id ?? null) : null);
  const joining = call.phase === 'starting' || call.phase === 'connecting';

  const end = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await endMeeting(room.meeting.id);
      setAsking(false);
      void liveRooms().refresh();
    } catch {
      setProblem('Could not end the voice room. Try again.');
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
        <EndRoomConfirm inRoom={facts.faces.length + facts.more} busy={busy} onEnd={() => void end()} onCancel={() => setAsking(false)} />
      ) : (
        <div className="room-card-actions">
          {facts.inRoom ? (
            <span className="room-card-in" data-testid="room-card-in"><WaveIcon /> You are in this room</span>
          ) : (
            <button type="button" className="btn primary s room-card-join" data-testid="room-card-join" disabled={joining} onClick={() => void callController().joinRoom(room.meeting.id, channelId)}>Join</button>
          )}
          {facts.canEnd ? <button type="button" className="btn s room-card-end" data-testid="room-card-end" onClick={() => setAsking(true)}>End room</button> : null}
        </div>
      )}
      {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
    </div>
  );
}
