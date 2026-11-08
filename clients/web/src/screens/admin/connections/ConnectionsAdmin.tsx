import { useRef, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '../../../components/PageHeader';
import '../../../styles/admin-connections.css';
import { ConnectorsAdmin } from './ConnectorsAdmin';
import { PeopleScopes } from './PeopleScopes';

/** True once the admin page for connected apps is built (PLAN Bundle D, P16-11): its entry is in the settings menu. */
export const CONNECTIONS_ADMIN_READY = true;

const TABS = [
  { id: 'connectors', label: 'Connectors' },
  { id: 'people', label: 'People' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * `/settings/workspace/connections`: per service, how many people are connected, who needs to sign in again, failures and the permissions asked (Connectors), and who connected
 * what with a Disconnect action (People). Removing a leaving person's connections is on Members. Workspace owners and admins only; the server says 403 to anyone else.
 */
export function ConnectionsAdmin() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = params.get('tab') === 'people' ? 'people' : 'connectors';
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (id: TabId): void => setParams(id === 'connectors' ? {} : { tab: id }, { replace: true });
  const onKey = (e: KeyboardEvent): void => {
    const at = TABS.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % TABS.length : e.key === 'ArrowLeft' ? (at + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    go(TABS[to]!.id);
    refs.current[to]?.focus();
  };
  return (
    <section className="ac-screen" data-testid="connections-admin">
      <PageHeader title="Connected apps" description="How the apps people and teams connect are being used, and who connected what." />
      <div className="ac-tabs" role="tablist" aria-label="Connected apps" onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`ac-tab-${t.id}`}
            ref={(el) => { refs.current[i] = el; }}
            aria-selected={tab === t.id}
            aria-controls="ac-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`ac-tab${tab === t.id ? ' on' : ''}`}
            data-testid={`connections-admin-tab-${t.id}`}
            onClick={() => go(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="ac-panel" role="tabpanel" aria-labelledby={`ac-tab-${tab}`}>
        {tab === 'people' ? <PeopleScopes /> : <ConnectorsAdmin />}
      </div>
    </section>
  );
}
