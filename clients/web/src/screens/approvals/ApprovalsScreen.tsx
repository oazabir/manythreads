import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import type { Approval } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { ago } from '../../channels/format';
import { Bell } from '../../notifications/Bell';
import { useShell } from '../../shell/context';
import { BackIcon } from '../../shell/icons';
import { useNarrow } from '../../shell/useNarrow';
import { ApprovalCard } from './ApprovalCard';
import { fetchApprovals } from './api';
import { useApprovalsChanged, usePollWhileQueued } from './live';

/*
 * The Approvals inbox (SPEC §7.3, `[proto §11 plate 5]`): everything that waits for a person, in one place — a tool call flagged
 * needs-approval, a model call the guard held, a protected environment, a strict dispatch. Waiting on the left, oldest first, with the
 * selected one on the right and the buttons for whoever may decide it; Decided is the history. Nothing else waits.
 */

type Tab = 'waiting' | 'decided';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'decided', label: 'Decided' },
];
const EMPTY: Record<Tab, { title: string; body: string }> = {
  waiting: { title: 'Nothing waiting', body: 'Requests that need a person to decide show up here.' },
  decided: { title: 'Nothing decided yet', body: 'Approved and denied requests show up here.' },
};

const rowLabel = (a: Approval): string => (a.botName ? `${a.botName} · ${a.tool}` : a.tool);

export function ApprovalsScreen() {
  const { team } = useShell();
  const slug = team?.slug ?? '';
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'decided' ? 'decided' : 'waiting';
  const selected = params.get('approval');
  const q = useQuery(`approvals:${slug}:${tab}`, () => fetchApprovals(slug, tab === 'waiting' ? 'pending' : 'decided'));
  const items = q.status === 'ok' ? q.data.items : [];
  // The one being read may have just been settled and so left the Waiting list: it is then found in the decided history, so the card
  // goes on showing what happened to it (approved by whom, and whether the call ran).
  const gone = q.status === 'ok' && selected !== null && !items.some((a) => a.id === selected);
  const settled = useQuery(`approvals:${slug}:settled:${gone ? selected : 'none'}`, () => (gone ? fetchApprovals(slug, 'decided') : Promise.resolve(null)));
  useApprovalsChanged(() => {
    q.reload();
    settled.reload();
  });
  const waiting = q.status === 'ok' ? q.data.waiting : null;
  const absent = q.status === 'error' && isApiError(q.error) && q.error.status === 404;

  const open = (id: string | null, replace = false): void => {
    const next = new URLSearchParams(params);
    if (id) next.set('approval', id);
    else next.delete('approval');
    setParams(next, { replace });
  };
  const setTab = (t: Tab): void => {
    const next = new URLSearchParams(params);
    if (t === 'waiting') next.delete('tab');
    else next.set('tab', t);
    next.delete('approval');
    setParams(next);
  };

  // On a wide screen the first one is open, as the prototype shows it.
  const first = items[0]?.id ?? null;
  useEffect(() => {
    if (narrow || selected || !first) return;
    const next = new URLSearchParams(window.location.search);
    if (next.get('approval')) return;
    next.set('approval', first);
    setParams(next, { replace: true });
  }, [narrow, selected, first, setParams]);

  const settledItems = settled.status === 'ok' ? (settled.data?.items ?? []) : [];
  usePollWhileQueued([...items, ...settledItems].some((a) => a.id === selected && a.outcome === 'queued'), () => {
    q.reload();
    settled.reload();
  });
  const current = items.find((a) => a.id === selected) ?? (settled.status === 'ok' ? (settled.data?.items.find((a) => a.id === selected) ?? null) : null);
  const showList = !narrow || selected === null;
  const showMain = !narrow || selected !== null;

  return (
    <div className={`inbox ${narrow ? 'narrow' : ''}`} data-testid="approvals-inbox">
      {showList ? (
        <div className="inl" data-landmark="approval-list">
          <header className="inh" data-landmark={narrow ? undefined : 'header'}>
            <h1 className="inh-title">Approvals</h1>
            {waiting !== null ? <span className="apr-count" data-testid="approvals-count" data-vt-mask>{waiting} waiting</span> : null}
            <div className="tabs2" role="tablist" aria-label="Approvals">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} data-testid={`approvals-tab-${t.id}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </header>
          {q.status === 'loading' ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : absent || (q.status === 'ok' && items.length === 0) ? (
            <div className="inl-empty" data-testid="approvals-empty">
              <p className="view-empty-title">{EMPTY[tab].title}</p>
              <p className="view-empty-body">{EMPTY[tab].body}</p>
            </div>
          ) : q.status === 'error' ? (
            <div className="inl-empty" role="alert">
              <p className="view-empty-title">Could not load approvals.</p>
              <button type="button" className="btn s" onClick={q.reload}>Try again</button>
            </div>
          ) : (
            <ul className="inlist" role="listbox" aria-label={`${tab === 'waiting' ? 'Waiting' : 'Decided'} approvals`}>
              {items.map((a) => (
                <li key={a.id} role="option" aria-selected={a.id === selected} data-testid="approval-row" data-approval={a.id} data-status={a.status}>
                  <button type="button" className={`trow ${a.id === selected ? 'on' : ''}`} onClick={() => open(a.id)}>
                    <span className="trow-main">
                      <span className="ch">{rowLabel(a)}</span>
                      <span className="ttl">{a.summary}</span>
                      <span className="last">
                        {a.status === 'pending'
                          ? a.canDecide
                            ? `asked by ${a.requesterName} · you can decide`
                            : `asked by ${a.requesterName}`
                          : `${a.status} by ${a.decision?.deciderName ?? 'someone'}`}
                      </span>
                    </span>
                    <span className="meta">
                      <span data-vt-mask>{ago(a.status === 'pending' ? a.createdAt : (a.decision?.decidedAt ?? a.createdAt))}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {showMain ? (
        <div className="inr" data-landmark="approval-view">
          {narrow ? (
            <button type="button" className="btn s back-to-list" onClick={() => open(null)}>
              <BackIcon />
              <span>Approvals</span>
            </button>
          ) : (
            <div className="inr-bell"><Bell /></div>
          )}
          {current ? (
            <div className="apr-detail">
              <ApprovalCard key={`${current.id}:${current.status}:${current.outcome}`} approval={current} slug={slug} onDecided={q.reload} />
            </div>
          ) : items.length > 0 ? (
            <div className="inr-empty">
              <p className="view-empty-title">Pick a request</p>
              <p className="view-empty-body">What it is, who asked and who can decide show here.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
