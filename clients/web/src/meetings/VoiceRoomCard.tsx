import { useContext, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { CallCard } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { RowGestureContext } from '../channels/gestures';
import { usePeople } from '../channels/hooks';
import { channelStore } from '../channels/store';
import { Avatar } from '../components/ui';
import { isMockMode } from '../api/setup';
import { endMeeting } from './api';
import { callCards, useCallCard } from './callCards';
import { EndRoomConfirm } from './EndRoomConfirm';
import { BotIcon, EventHeadphonesIcon, WaveIcon } from './icons';
import { callCardFacts, cardFromSummary, eventLine, runningTime, startLine } from './roomCard';
import { callController, liveRooms, useCall, useRoomOfMessage } from './store';

/*
 * The call card (P33-03, grown in P15-26). A message stamped with `meta.meeting` draws, in place of its text:
 * - while the call is live, the card: title, Audio, Live with the running time, who started it and when, the faces of who is in it, the note-taker while it
 *   listens, Join (the whole card joins) or "You are in this call", and for the starter End call, which asks once;
 * - once it is over, one muted event line: "Omar started a call · 22:14 · 14 min · 3 joined", with Notes for a reader who may read them;
 * - before the card has loaded (or for a call the reader may not read), the start of that line at the same height, so the row never jumps.
 * A start message written before the stamp (none should be left after migration 0007) keeps P33's card from the live list (`VoiceRoomCard`) until S7.
 */

/** The card or the event line of a stamped start message. `starterName` and `startedAt` come from the message, for the line drawn before the card loads. */
export function CallCardMessage({ meetingId, channelId, starterName, startedAt }: { meetingId: string; channelId: string; starterName: string; startedAt: string }) {
  const entry = useCallCard(meetingId);
  if (entry?.status === 'ok') {
    const card = entry.card;
    if (card.state === 'live') {
      return (
        <CallCardBody
          card={card}
          channelId={channelId}
          // End call waits for a fresh card (and the live list behind the header icon) before it lets go of "Ending…"; if that ask fails, the end route's answer
          // is enough: the card turns into its event line here
          freshen={() => Promise.all([callCards().refresh(card.meetingId), liveRooms().refresh()]).then(() => undefined)}
          endedHere={() => callCards().markEnded(card.meetingId)}
        />
      );
    }
    return <CallEventLine card={card} />;
  }
  return (
    <p className="ev-line" data-testid="call-event" data-state="start" data-meeting-id={meetingId}>
      <span className="ev-ic" aria-hidden="true"><EventHeadphonesIcon /></span>
      <span className="ev-text" title={startLine(starterName, startedAt)}>{startLine(starterName, startedAt)}</span>
    </p>
  );
}

/** The ended call as one muted line, with Notes when the reader may read them and they are written. */
export function CallEventLine({ card }: { card: CallCard }) {
  const text = eventLine(card);
  return (
    <p className="ev-line" data-testid="call-event" data-state={card.state} data-meeting-id={card.meetingId}>
      <span className="ev-ic" aria-hidden="true"><EventHeadphonesIcon /></span>
      <span className="ev-text" title={text}>{text}</span>
      {card.notesLink ? (
        <>
          <span className="ev-sep" aria-hidden="true">·</span>
          <Link className="ev-link" to={card.notesLink} data-testid="call-event-notes" aria-label={`Notes of ${card.title}`}>Notes</Link>
        </>
      ) : null}
    </p>
  );
}

/**
 * The card under an older "Started a voice room" message that carries no stamp, while that room is live (P33-03): drawn from the live list. It draws nothing for
 * any other message and after the room has ended.
 */
export function VoiceRoomCard({ messageId, channelId, starterName = 'Someone' }: { messageId: string; channelId: string; starterName?: string }) {
  const room = useRoomOfMessage(messageId);
  if (!room || isMockMode()) return null;
  // the live list drops the room with its next answer; nothing is kept here to mark
  return <CallCardBody card={cardFromSummary(room, starterName)} channelId={channelId} freshen={() => liveRooms().refresh()} endedHere={() => undefined} />;
}

/** The time a live call has run, again every second while it is drawn. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const PROBLEM = 'Could not end the call. Try again.';

/**
 * The live card. `freshen` asks again for what the card is drawn from (End call waits for it); `endedHere` turns the card into its ended state without the
 * server, once the end route has answered.
 */
export function CallCardBody({ card, channelId, freshen, endedHere }: { card: CallCard; channelId: string; freshen: () => Promise<void>; endedHere: () => void }) {
  const call = useCall();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inCall = call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost';
  // the reader's actor id: from the roster once it has answered (the card may be drawn before), else what the store already knows
  const people = usePeople();
  const facts = callCardFacts(card, { selfActor: people.me?.actorId ?? channelStore.selfActor, joinedMeetingId: inCall ? (call.meeting?.id ?? null) : null });
  const joining = call.phase === 'starting' || call.phase === 'connecting';
  const now = useNow();
  const box = useRef<HTMLDivElement>(null);
  const endButton = useRef<HTMLButtonElement>(null);
  const focusEnd = useRef(false);
  // Cancel and Esc put the keyboard back on the End call button that asked
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
  const join = (): void => void callController().joinRoom(card.meetingId, channelId);
  const joinable = !facts.inCall && !joining && !asking;

  const end = async (): Promise<void> => {
    // the card goes once the call is over: the keyboard goes to the message row, which then holds the event line
    const row = box.current?.closest<HTMLElement>('.msg') ?? null;
    setBusy(true);
    setProblem(null);
    let over = false;
    try {
      // the starter is in the call: ending it from the card must also close their own call, which only the call controller does
      if (facts.inCall) await callController().endForAll();
      else await endMeeting(card.meetingId);
      over = true;
    } catch (e) {
      // someone else ended it first (404, 409): it is over all the same. Only a refused or failed end request is a problem
      if (isApiError(e) && (e.status === 404 || e.status === 409)) over = true;
      else setProblem(PROBLEM);
    }
    if (over) {
      // the card stays "Ending…" until it has been asked again, so it never flashes back to Join; a failed ask does not undo an end the server confirmed
      await freshen().catch(() => undefined);
      endedHere();
      setAsking(false);
      row?.focus();
    }
    setBusy(false);
  };
  // the whole card joins: a press anywhere on it that is not one of its buttons or links, not the click a held finger or a swipe leaves behind, and not a
  // click that selected words of the card (a double click on the title)
  const justFired = useContext(RowGestureContext);
  const onCard = (e: MouseEvent<HTMLDivElement>): void => {
    if (!joinable || justFired() || (e.target as HTMLElement).closest('button,a,[role=group]')) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (e.detail > 1 || (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode) && sel.toString() !== '')) return;
    join();
  };

  return (
    <div ref={box} className="room-card" data-testid="room-card" data-meeting-id={card.meetingId} data-joinable={joinable ? '' : undefined} onClick={onCard}>
      <div className="room-card-head">
        <span className="room-card-ico" aria-hidden="true"><WaveIcon /></span>
        <div className="room-card-text">
          <p className="room-card-title" title={facts.title}>{facts.title}</p>
          <p className="room-card-meta">
            <span className="room-card-chip" data-testid="room-card-kind">{facts.kind}</span>
            <span className="room-card-chip room-card-livechip" data-testid="room-card-live">
              Live <time data-vt-mask>{runningTime(card.startedAt, now)}</time>
            </span>
            <span className="room-card-by" data-testid="room-card-by">{facts.started}</span>
          </p>
        </div>
      </div>
      <p className="room-card-count" data-testid="room-card-count">
        {facts.faces.length > 0 ? (
          <span className="room-card-faces" aria-hidden="true">
            {facts.faces.map((p) => {
              const person = people.byActor(p.actorId);
              return <Avatar key={p.actorId} name={p.displayName} avatar={person?.avatar} personId={person?.personId} />;
            })}
          </span>
        ) : null}
        <span>{facts.countText}</span>
        {facts.more > 0 ? <span className="room-card-more">{`+${facts.more}`}</span> : null}
        {facts.notetaker !== null ? (
          <span className="room-card-chip room-card-notes" data-testid="room-card-notetaker" title={`${facts.notetaker} is taking notes`}>
            <BotIcon /> Note-taker listening
          </span>
        ) : null}
      </p>
      {/* S6 (P15-27): the invited names and Invite more come here, under who is in the call */}
      {asking ? (
        <EndRoomConfirm inRoom={facts.presentCount} busy={busy} onEnd={() => void end()} onCancel={cancel} />
      ) : (
        <div className="room-card-actions">
          {facts.inCall ? (
            <span className="room-card-in" data-testid="room-card-in"><WaveIcon /> You are in this call</span>
          ) : (
            <button type="button" className="btn primary s room-card-join" data-testid="room-card-join" disabled={joining} onClick={join}>Join call</button>
          )}
          {facts.canEnd ? <button type="button" ref={endButton} className="btn s room-card-end" data-testid="room-card-end" onClick={() => setAsking(true)}>End call</button> : null}
        </div>
      )}
      {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
    </div>
  );
}
