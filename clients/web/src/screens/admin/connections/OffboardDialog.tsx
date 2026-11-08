import { useState } from 'react';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { Dialog } from '../../../components/Dialog';
import { QueryView } from '../../../components/states';
import { Alert } from '../../../components/ui';
import { sayToast } from '../../../kernel/toast';
import { fetchOffboardPreview, offboardConnections } from '../../connections/api';
import { connectorName, servicesLine } from './words';

/*
 * "Remove their connections" (PLAN Bundle D, P16-11, decisions D33 and D34): says what will happen before it does. The person's own connections are switched off now and then
 * removed, and each service is asked to forget them; a team or workspace connection they set up moves to the team's longest-serving lead, else to the admin pressing the button.
 * This also happens by itself when a person is deactivated. Reactivating them brings nothing back.
 */
export function OffboardDialog({ personId, name, onClose, onDone }: { personId: string; name: string; onClose: () => void; onDone?: () => void }) {
  const q = useQuery(`offboard-preview-${personId}`, () => fetchOffboardPreview(personId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nothing = q.status === 'ok' && q.data.preview.own.length === 0 && q.data.preview.moving.length === 0;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await offboardConnections(personId);
      sayToast(`${name}’s connections are switched off. They are removed within a minute.`, { testId: 'connection-note' });
      onDone?.();
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not remove their connections. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Remove ${name}’s connections?`}
      onClose={onClose}
      testId="offboard-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>{nothing ? 'Close' : 'Cancel'}</button>
          {nothing ? null : (
            <button type="button" className="btn danger" disabled={busy || q.status !== 'ok'} data-testid="offboard-confirm" onClick={() => void submit()}>Remove connections</button>
          )}
        </>
      }
    >
      <QueryView q={q}>
        {({ preview }) => (
          <div className="ac-offboard">
            {nothing ? <p className="dlg-text" data-testid="offboard-nothing">{name} has no connections, and has not set up any for a team or the workspace. There is nothing to remove.</p> : null}
            {preview.own.length > 0 ? (
              <>
                <p className="dlg-text">These are removed. Each service is asked to forget them, and the stored sign-ins are deleted:</p>
                <ul className="ac-list" data-testid="offboard-own">
                  {preview.own.map((o) => (
                    <li key={o.connector}><strong>{connectorName(o.connector)}</strong> <span className="faint">{servicesLine(o.services)}</span></li>
                  ))}
                </ul>
              </>
            ) : null}
            {preview.moving.length > 0 ? (
              <>
                <p className="dlg-text">These were set up for a team or the workspace. They stay, and move to a new owner:</p>
                <ul className="ac-list" data-testid="offboard-moving">
                  {preview.moving.map((m) => (
                    <li key={m.slug}><strong>{m.slug}</strong> <span className="faint">({connectorName(m.connector)})</span> goes to {m.newOwnerName}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {nothing ? null : <p className="dlg-text">Their own connections stop working right away. Reactivating {name} later does not bring any of this back.</p>}
          </div>
        )}
      </QueryView>
      {error ? <Alert>{error}</Alert> : null}
    </Dialog>
  );
}
