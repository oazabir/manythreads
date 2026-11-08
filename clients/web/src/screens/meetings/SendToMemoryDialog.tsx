import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { sendMeetingToMemory } from '../../meetings/api';
import { actionFailure } from './words';

/**
 * Send to memory (PLAN P15-11, decision C8): a private-channel or direct-message meeting is never filed to memory by itself. The server's first answer carries the warning, in its
 * own words, that is read before anything is sent; the second call confirms.
 */
export function SendToMemoryDialog({ meetingId, onClose, onSent }: { meetingId: string; onClose: () => void; onSent: (memoryItemId: string | null) => void }) {
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    sendMeetingToMemory(meetingId, { confirmed: false }).then(
      (r) => live && setWarning(r.warning),
      (e: unknown) => live && setError(actionFailure(e, 'Could not check what sending would do. Try again.')),
    );
    return () => {
      live = false;
    };
  }, [meetingId]);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendMeetingToMemory(meetingId, { confirmed: true });
      if (!r.sent) {
        setError('The notes were not sent. Try again.');
        return;
      }
      onSent(r.memoryItemId);
    } catch (e) {
      setError(actionFailure(e, 'The notes could not be sent. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Send to the team’s memory"
      onClose={onClose}
      testId="send-memory-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || warning === null} onClick={() => void send()} data-testid="send-memory-go">{busy ? 'Sending…' : 'Send to memory'}</button>
        </>
      }
    >
      {warning === null && error === null ? <p className="dlg-hint" role="status" aria-busy="true">Checking what this does…</p> : null}
      {warning !== null ? <p className="dlg-text" data-testid="send-memory-warning">{warning}</p> : null}
      {error ? <p className="dlg-error" role="alert" data-testid="send-memory-error">{error}</p> : null}
    </Dialog>
  );
}
