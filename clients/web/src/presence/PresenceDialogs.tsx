import { Link } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useMyDnd } from './hooks';
import { PauseControls, StatusEditor } from './PresencePanels';

/** "Set status" from the account menu: the status editor in a dialog. Closes after a save or a clear. */
export function StatusDialog({ onClose }: { onClose: () => void }) {
  const dnd = useMyDnd();
  return (
    <Dialog title="Set your status" onClose={onClose} testId="status-dialog" footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      {dnd.me ? <StatusEditor me={dnd.me} onDone={onClose} autoFocus /> : <p className="dlg-hint">Loading…</p>}
    </Dialog>
  );
}

/** "Pause notifications" from the account menu: ready-made lengths, a time of the person's own, and the way to the weekly schedule. */
export function PauseDialog({ onClose }: { onClose: () => void }) {
  const dnd = useMyDnd();
  return (
    <Dialog
      title="Pause notifications"
      onClose={onClose}
      testId="pause-dialog"
      footer={
        <>
          <Link className="btn quiet" to="/account#status-and-dnd" onClick={onClose} data-testid="pause-settings-link">Weekly schedule…</Link>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <PauseControls banner={dnd.banner} onDone={onClose} autoFocus />
    </Dialog>
  );
}
