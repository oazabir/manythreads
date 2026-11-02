import { useState } from 'react';
import { Link } from 'react-router';
import type { Connection } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { PlainFrame } from '../../components/frames';
import { QueryView } from '../../components/states';
import { fetchMyConnections } from './api';
import { RemoveConnectionDialog } from './dialogs';
import { ConnectionRow } from './parts';

/*
 * Account → Connections (PLAN P8-06). The connections that belong to you alone: nobody else sees them, and a bot uses them only in a conversation you start.
 * You can look at them and remove one. Adding one waits for the services that need it; the mail option below says so in plain words rather than hide.
 * A credential is never shown: a row says only that one is stored.
 */

export function AccountConnections() {
  const q = useQuery('account-connections', fetchMyConnections);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [note, setNote] = useState<string | null>(null);

  return (
    <PlainFrame title="Connections">
      <p className="cn-back"><Link to="/account">← Back to your account</Link></p>
      <p className="lede">
        These connections are yours alone. Nobody else can see them, and a bot uses them only when you are the one asking. Credentials are stored sealed and cannot be
        shown again.
      </p>
      <p className="cn-back" data-testid="account-connected-link">
        To let a bot use your Google, Microsoft or Notion account, see <Link to="/settings/connections">your connected accounts</Link>.
      </p>
      <div className="cn-status" role="status" aria-live="polite" data-testid="connection-status">{note ? <p className="notice ok">{note}</p> : null}</div>

      <QueryView q={q}>
        {({ connections }) => {
          const mine = connections.filter((c) => c.scope === 'person');
          return (
            <>
              <section className="block" aria-labelledby="my-connections" data-testid="my-connections">
                <h2 className="bh" id="my-connections">Your connections <span className="cnt">{mine.length}</span></h2>
                {mine.length === 0 ? (
                  <div className="block-body">
                    <p className="faint" data-testid="my-connections-empty">You have not connected anything of your own yet.</p>
                  </div>
                ) : (
                  <ul className="cn-list" data-testid="connection-list">
                    {mine.map((c) => (
                      <ConnectionRow key={c.id} connection={c} busy={false} canSwitch={false} onSwitch={() => undefined}>
                        <button type="button" className="btn sm" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`} data-testid="connection-remove">Remove</button>
                      </ConnectionRow>
                    ))}
                  </ul>
                )}
              </section>

              <section className="block" aria-labelledby="my-mail" data-testid="my-mail">
                <h2 className="bh" id="my-mail">Your mail</h2>
                <div className="block-body">
                  <p>
                    Letting a bot read and draft mail from your own mailbox is not available yet. Mail arrives with the mail transport, the part that sends and
                    receives email for the workspace. When it is ready, you will be able to switch it on here, and nothing is shared until you do.
                  </p>
                  <label className="check cn-check">
                    <input type="checkbox" disabled checked={false} readOnly data-testid="my-mail-optin" />
                    <span>Let bots read and draft in my mailbox (not available yet)</span>
                  </label>
                </div>
              </section>

              {removing ? (
                <RemoveConnectionDialog
                  connection={removing}
                  mine
                  onClose={() => setRemoving(null)}
                  onDone={(c) => {
                    setRemoving(null);
                    setNote(`${c.name} was removed.`);
                    q.reload();
                  }}
                />
              ) : null}
            </>
          );
        }}
      </QueryView>
    </PlainFrame>
  );
}
