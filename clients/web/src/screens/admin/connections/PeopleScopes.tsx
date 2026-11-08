import { useId, useState } from 'react';
import type { ConnectionPersonRow } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { Dialog } from '../../../components/Dialog';
import { EmptyState, QueryView } from '../../../components/states';
import { Alert } from '../../../components/ui';
import { sayToast } from '../../../kernel/toast';
import { SearchIcon } from '../../../shell/icons';
import { adminDisconnectConnection, fetchConnectionPeople } from '../../connections/api';
import { connectorName, lastUsedLine, servicesLine, stateLook } from './words';

/*
 * The "People" tab of `/settings/workspace/connections` (PLAN Bundle D, P16-11, decision D32): who connected what and with which permissions (the services granted), whether it still
 * works and when a bot last used it, with one action: Disconnect. Content-blind: never an account address, a token or what a call read. A leaving person's whole set of
 * connections is removed from Members, not here.
 */

const matches = (r: ConnectionPersonRow, term: string): boolean => {
  const t = term.trim().toLowerCase();
  return t === '' || r.personName.toLowerCase().includes(t) || connectorName(r.connector).toLowerCase().includes(t);
};

export function PeopleScopes() {
  const q = useQuery('connection-people', fetchConnectionPeople);
  const [search, setSearch] = useState('');
  const [leaving, setLeaving] = useState<ConnectionPersonRow | null>(null);
  const searchId = useId();
  return (
    <div className="ac-people" data-testid="people-scopes">
      <p className="ac-lede">Each person’s own sign-ins, and the permissions they gave. You can disconnect one if it should not be used any more; the person can connect it again themselves.</p>
      <QueryView q={q}>
        {({ people }) => {
          if (people.length === 0) return <EmptyState title="No one has connected an account yet">Each person connects their own Google, Microsoft or other accounts from their connections page.</EmptyState>;
          const shown = people.filter((r) => matches(r, search));
          return (
            <>
              <div className="ac-search">
                <label htmlFor={searchId} className="sr-only">Search by person or service</label>
                <span className="ac-search-ico" aria-hidden="true"><SearchIcon size={14} /></span>
                <input id={searchId} className="ac-input" type="search" placeholder="Search by person or service" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" data-testid="people-search" />
              </div>
              <div className="block ac-wrap">
                <table className="table ac-table">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Service</th>
                      <th scope="col">Permissions given</th>
                      <th scope="col">State</th>
                      <th scope="col">Last used</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const look = stateLook(r.state);
                      return (
                        <tr key={r.connectionId} data-testid="person-connection" data-connector={r.connector} data-state={r.state}>
                          <td data-label="Person" className="ac-c"><strong>{r.personName}</strong></td>
                          <td data-label="Service" className="ac-c">{connectorName(r.connector)}</td>
                          <td data-label="Permissions given" className="ac-c">{servicesLine(r.services)}</td>
                          <td data-label="State" className="ac-c"><span className={`cn-state ${look.tone}`}><span aria-hidden="true">{look.glyph}</span> {look.label}</span></td>
                          <td data-label="Last used" className="ac-c ac-d">{lastUsedLine(r.lastUsedOn)}</td>
                          <td className="ac-c ac-act">
                            <button type="button" className="btn s" aria-label={`Disconnect ${r.personName}’s ${connectorName(r.connector)}`} data-testid="person-disconnect" onClick={() => setLeaving(r)}>Disconnect</button>
                          </td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 ? <tr><td colSpan={6} className="faint" data-testid="people-none">No one matches "{search.trim()}".</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </QueryView>
      {leaving ? <DisconnectDialog row={leaving} onClose={() => setLeaving(null)} onDone={q.reload} /> : null}
    </div>
  );
}

function DisconnectDialog({ row, onClose, onDone }: { row: ConnectionPersonRow; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const service = connectorName(row.connector);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { providerRevoked } = await adminDisconnectConnection(row.connectionId);
      sayToast(providerRevoked ? `${row.personName}’s ${service} is disconnected, and ${service} was told to forget it.` : `${row.personName}’s ${service} is disconnected.`, { testId: 'connection-note' });
      onDone();
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not disconnect it. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Disconnect ${row.personName}’s ${service}?`}
      onClose={onClose}
      testId="disconnect-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy} data-testid="disconnect-confirm" onClick={() => void submit()}>Disconnect</button>
        </>
      }
    >
      <p className="dlg-text">Bots can no longer use {row.personName}’s {service} for them. We ask {service} to forget the sign-in, and the stored sign-in is deleted.</p>
      <p className="dlg-text">{row.personName} can connect it again from their own connections page.</p>
      {error ? <Alert>{error}</Alert> : null}
    </Dialog>
  );
}
