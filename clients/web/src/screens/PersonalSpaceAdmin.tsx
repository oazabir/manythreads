import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { PERSONAL_KEEP_DAYS_DEFAULT, PERSONAL_OPEN_MINUTES } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { updateWorkspaceMember } from '../api/endpoints';
import { useSession } from '../app/session';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { sayToast } from '../kernel/toast';
import { openPersonalSpace } from './files/personalApi';

/*
 * What an owner or admin does with another person's account on the Members page: look into their Personal space (read-only, a reason is required,
 * the person is told) and deactivate or reactivate them. The server decides what is allowed; these dialogs say it in words first.
 */

const REASON_MAX = 300;

/** "Open Personal space": asks for the reason, opens the space for an hour, and goes to the read-only view of it. */
export function OpenSpaceDialog({ personId, name, onClose }: { personId: string; name: string; onClose: () => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const id = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  async function submit(): Promise<void> {
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await openPersonalSpace(personId, trimmed, session.person.name);
      void navigate(`/files/person/${encodeURIComponent(personId)}`);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The space could not be opened. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Open ${name}’s Personal space`}
      onClose={onClose}
      testId="open-space-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || trimmed === ''} data-testid="open-space-submit" onClick={() => void submit()}>Open the space</button>
        </>
      }
    >
      <p className="dlg-text">
        You will be able to read {name}’s files for {PERSONAL_OPEN_MINUTES} minutes. You cannot change anything. {name} will see that you opened it, when, and the reason you give here.
      </p>
      <div className="fld">
        <label htmlFor={id}>Why do you need to look?</label>
        <textarea
          id={id}
          value={reason}
          maxLength={REASON_MAX}
          rows={3}
          onChange={(e) => setReason(e.target.value)}
          placeholder="For example: they are away and we need the handover notes"
          data-testid="open-space-reason"
          data-autofocus
        />
        <div className="fld-hint" data-testid="open-space-count">{reason.length} of {REASON_MAX} characters</div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </Dialog>
  );
}

/** "Deactivate": says what happens before it does. */
export function DeactivateDialog({ personId, name, onClose, onDone }: { personId: string; name: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateWorkspaceMember(personId, { status: 'suspended' });
      sayToast(`${name} is deactivated.`, { testId: 'member-note' });
      onDone();
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not deactivate them. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Deactivate ${name}?`}
      onClose={onClose}
      testId="deactivate-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy} data-testid="deactivate-confirm" onClick={() => void submit()}>Deactivate</button>
        </>
      }
    >
      <p className="dlg-text">{name} will not be able to sign in, and every browser they are signed in on is signed out now.</p>
      <p className="dlg-text">Their Personal space is deleted {PERSONAL_KEEP_DAYS_DEFAULT} days from now. Until then you can open it, download it, or reactivate them to keep it.</p>
      {error ? <Alert>{error}</Alert> : null}
    </Dialog>
  );
}

/** "Reactivate": the person can sign in again and the {PERSONAL_KEEP_DAYS_DEFAULT}-day clock stops. */
export async function reactivate(personId: string, name: string, onDone: () => void): Promise<void> {
  try {
    await updateWorkspaceMember(personId, { status: 'active' });
    sayToast(`${name} can sign in again.`, { testId: 'member-note' });
    onDone();
  } catch (e) {
    sayToast(isApiError(e) ? e.message : 'Could not reactivate them. Try again.', { testId: 'member-note' });
  }
}
