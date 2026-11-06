import { PageHeader } from '../../components/PageHeader';
import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { CONNECTION_ADMIN_ONLY, type Connection } from '@manythreads/shared';
import { isAdmin, useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert } from '../../components/ui';
import { fetchTeamConnections, updateConnection } from './api';
import { AddConnectionDialog, ChangeConnectionDialog, RemoveConnectionDialog, type AddResult } from './dialogs';
import { ConnectionRow } from './parts';
import { message } from './words';

/*
 * Team settings → Connections (PLAN P8-06, docs/plugins/connections.md). A connection links the team to an outside service; a bot is given tools that work
 * through it by naming it in its definition. Every member of the team can read the list. Only a workspace admin adds, changes, switches or removes a team’s
 * connection, so anyone else sees the list and one plain sentence that says who can. A credential is typed once and never shown again: a row says only
 * that one is stored.
 */

type Dialogs = { kind: 'add' } | { kind: 'change'; connection: Connection } | { kind: 'remove'; connection: Connection } | null;

export function TeamConnections() {
  const { slug = '' } = useParams();
  const session = useSession();
  const admin = isAdmin(session);
  const q = useQuery(`team-connections:${slug}`, () => fetchTeamConnections(slug));
  const heading = useRef<HTMLHeadingElement>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const working = useRef(new Set<string>());

  const say = (text: string, problem: string | null = null): void => {
    setError(problem);
    setNote(text);
  };
  const close = (): void => setDialog(null);

  async function switchTo(c: Connection, on: boolean): Promise<void> {
    if (working.current.has(c.id)) return;
    working.current.add(c.id);
    setBusy(new Set(working.current));
    setError(null);
    try {
      await updateConnection(c.id, { status: on ? 'enabled' : 'disabled' });
      say(on ? `${c.name} is on. Bots that were given its tools can use it.` : `${c.name} is off. Its tools are not offered to any bot.`);
      q.reload();
    } catch (e) {
      setNote(null);
      setError(message(e));
    } finally {
      working.current.delete(c.id);
      setBusy(new Set(working.current));
    }
  }

  function added(r: AddResult): void {
    close();
    q.reload();
    if (r.problem) say(`${r.connection.name} was added, but it is not finished.`, r.problem);
    else say(r.on ? `${r.connection.name} was added and is on.` : `${r.connection.name} was added. It is off until a credential is stored and it is switched on.`);
  }

  return (
    <>
      <div className="cn-head">
        <PageHeader
          title="Connections"
          headingRef={heading}
          description="A connection links this team to an outside service, such as a mailbox. A bot is given tools that work through it by naming it in its definition (see the Capabilities tab of the bot). The password or key is stored sealed and cannot be shown again."
          actions={admin ? <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add' })} data-testid="connection-add">Add connection</button> : null}
        />
      </div>

      {!admin ? <p className="notice" data-testid="connection-admin-only">{CONNECTION_ADMIN_ONLY}</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      {/* one polite status line for every change, so a screen reader hears what happened */}
      <div className="cn-status" role="status" aria-live="polite" data-testid="connection-status">{note ? <p className="notice ok">{note}</p> : null}</div>

      <QueryView q={q}>
        {({ connections }) => {
          const list = connections.filter((c) => c.scope === 'team');
          return (
            <>
              {list.length === 0 ? (
                <section className="block" aria-labelledby="connections-empty" data-testid="connection-empty">
                  <h2 className="bh" id="connections-empty">No connection yet</h2>
                  <div className="block-body">
                    <p className="lede">This team has not connected anything yet. Bots of the team have no tools that reach outside until it does.</p>
                    {admin ? <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add' })}>Add connection</button> : null}
                  </div>
                </section>
              ) : (
                <section className="block" aria-labelledby="connections-list">
                  <h2 className="bh" id="connections-list">Connected <span className="cnt">{list.length}</span></h2>
                  <ul className="cn-list" data-testid="connection-list">
                    {list.map((c) => (
                      <ConnectionRow key={c.id} connection={c} busy={busy.has(c.id)} canSwitch={admin} onSwitch={(on) => void switchTo(c, on)}>
                        {admin ? (
                          <>
                            <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'change', connection: c })} disabled={busy.has(c.id)} aria-label={`Change ${c.name}`} data-testid="connection-change">Change</button>
                            <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'remove', connection: c })} disabled={busy.has(c.id)} aria-label={`Remove ${c.name}`} data-testid="connection-remove">Remove</button>
                          </>
                        ) : null}
                      </ConnectionRow>
                    ))}
                  </ul>
                </section>
              )}

              {dialog?.kind === 'add' ? <AddConnectionDialog teamSlug={slug} onClose={close} onDone={added} /> : null}
              {dialog?.kind === 'change' ? (
                <ChangeConnectionDialog
                  connection={dialog.connection}
                  onClose={close}
                  onDone={(_c, text) => {
                    close();
                    say(text);
                    q.reload();
                  }}
                />
              ) : null}
              {dialog?.kind === 'remove' ? (
                <RemoveConnectionDialog
                  connection={dialog.connection}
                  onClose={close}
                  onDone={(c) => {
                    close();
                    say(`${c.name} was removed.`);
                    q.reload();
                    // the row is gone: keep keyboard focus on the page rather than let it fall to the start
                    setTimeout(() => heading.current?.focus(), 0);
                  }}
                />
              ) : null}
            </>
          );
        }}
      </QueryView>
    </>
  );
}
