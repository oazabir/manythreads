import { useEffect, useRef } from 'react';
import { endQuestion } from './roomCard';

/**
 * The one question before a call is ended for everyone (P33-03): the call card's End call and the call dock's End for everyone both show it in place of their
 * button. Cancel has the focus, so Enter does not end a call by habit; Esc says no.
 */
export function EndRoomConfirm({ inRoom, busy = false, onEnd, onCancel, testId = 'room-end-confirm' }: { inRoom: number; busy?: boolean; onEnd: () => void; onCancel: () => void; testId?: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="room-end" role="group" aria-label="End the call" data-testid={testId} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <p className="room-end-q">{endQuestion(inRoom)}</p>
      <div className="room-end-actions">
        <button type="button" className="btn s room-end-yes" data-testid={`${testId}-yes`} disabled={busy} onClick={onEnd}>{busy ? 'Ending…' : 'End call'}</button>
        <button type="button" ref={cancel} className="btn s" data-testid={`${testId}-no`} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
