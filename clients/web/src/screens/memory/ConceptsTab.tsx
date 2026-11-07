import { useEffect, useRef, useState } from 'react';
import { confirmConceptRoute, deprecateConceptRoute, ConfirmConceptResponse, DeprecateConceptResponse, type MemoryConceptSummary } from '@manythreads/shared';
import { call } from '../../api/client';
import { ago } from '../../channels/format';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonRows } from '../../components/Skeleton';
import { useQuery } from '../../app/useQuery';
import { SettingsMemoryIcon } from '../../shell/icons';
import { useNarrow } from '../../shell/useNarrow';
import { TEAM_TRUST_WORDS, conceptAt, isStaleConcept, rowNote } from './conceptWords';
import { PreviewEmptyIcon, TrustIcon } from './icons';
import { fetchConcepts } from './inboxApi';

/*
 * The team's Concepts tab (PLAN P21-15): one line per concept, its title and a single trust icon, and the concept itself in a preview pane on
 * the right when the window is wide enough (1024 px and up) with "Select a concept" until one is picked. Under that width the pane sits below the
 * list; on a phone it is a sheet that rises over the list. The list is read once and again after a Confirm or a Deprecate, so the icon follows.
 */

type Say = { tone: 'bad'; text: string } | null;

export function ConceptsTab({ slug, wanted, onOpenInbox }: { slug: string; wanted: string | null; onOpenInbox: () => void }) {
  const q = useQuery(`team-concepts:${slug}`, () => fetchConcepts(slug));
  const narrow = useNarrow();
  const [picked, setPicked] = useState<string | null>(wanted);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Say>(null);
  // The index follows a commit a moment after the call returns (the outbox), so one read right after it can still show the old row: the list is read
  // again a few times, and the timers are dropped when the tab goes away.
  const later = useRef<number[]>([]);
  useEffect(() => () => later.current.forEach((t) => window.clearTimeout(t)), []);

  // a link to another concept replaces the person's pick
  useEffect(() => {
    setPicked(wanted);
    setSaid(null);
  }, [wanted]);

  const concepts = q.status === 'ok' ? q.data.items : [];
  const selected = conceptAt(concepts, picked);

  const pick = (path: string): void => {
    setPicked(path);
    setSaid(null);
  };

  async function act(kind: 'confirm' | 'deprecate'): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setSaid(null);
    try {
      if (kind === 'confirm') await call(confirmConceptRoute, { response: ConfirmConceptResponse }, undefined, { slug, path: selected.path });
      else await call(deprecateConceptRoute, { response: DeprecateConceptResponse }, undefined, { slug, path: selected.path });
      // the list is read again, so a change the server made shows in the icon; nothing is claimed here that the list does not show
      q.reload();
      later.current.forEach((t) => window.clearTimeout(t));
      later.current = [800, 2000, 4500].map((ms) => window.setTimeout(q.reload, ms));
    } catch {
      setSaid({ tone: 'bad', text: kind === 'confirm' ? 'It could not be marked as reviewed. Try again.' : 'It could not be marked as deprecated. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (q.status === 'loading') return <SkeletonRows rows={6} label="Loading concepts" />;
  if (q.status === 'error') return <div className="view-empty" role="alert">Could not load memory concepts: {q.error.message}</div>;

  if (concepts.length === 0) {
    return (
      <EmptyState icon={SettingsMemoryIcon} title="No concepts yet" action={{ label: 'Open the inbox', onClick: onOpenInbox }} testId="concepts-empty">
        Drop a file into the team&apos;s inbox or ask a bot to write one, and it shows up here.
      </EmptyState>
    );
  }

  const detail = selected ? <ConceptDetail c={selected} busy={busy} said={said} onAct={(k) => void act(k)} showTitle={!narrow} /> : null;

  return (
    <div className="mc-body" data-testid="concepts">
      <ul className="mc-list" data-testid="concept-list" aria-label="Concepts">
        {concepts.map((c) => {
          const note = rowNote(c);
          return (
            <li key={c.path} className={`mc-item${selected?.path === c.path ? ' on' : ''}${c.status === 'deprecated' ? ' deprecated' : ''}`} data-testid="concept-row" data-path={c.path}>
              <button type="button" className="mc-row" aria-current={selected?.path === c.path ? 'true' : undefined} onClick={() => pick(c.path)}>
                <TrustIcon tier={c.trustTier} />
                <span className="mc-row-text">
                  <span className="mc-row-title" title={c.path}>{c.title}</span>
                  {c.description ? <span className="mc-row-desc">{c.description}</span> : null}
                </span>
                {note ? <span className="sr-only">{note}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {narrow ? null : (
        <aside className={`mc-preview${selected ? '' : ' none'}`} data-testid="concept-preview" aria-label="Concept preview">
          {detail ?? (
            <p className="mc-preview-none" data-testid="concept-preview-none">
              <PreviewEmptyIcon />
              <span>Select a concept</span>
            </p>
          )}
        </aside>
      )}
      {narrow && selected ? (
        <Dialog title={selected.title} onClose={() => setPicked(null)} sheet testId="concept-sheet" footer={<button type="button" className="btn" onClick={() => setPicked(null)}>Close</button>}>
          {detail}
        </Dialog>
      ) : null}
    </div>
  );
}

function ConceptDetail({ c, busy, said, onAct, showTitle }: { c: MemoryConceptSummary; busy: boolean; said: Say; onAct: (kind: 'confirm' | 'deprecate') => void; showTitle: boolean }) {
  const stale = isStaleConcept(c);
  return (
    <div className="mc-detail" data-testid="concept-detail" data-path={c.path}>
      {showTitle ? <h2 className="mc-detail-title">{c.title}</h2> : null}
      {c.description ? <p className="mc-detail-desc">{c.description}</p> : null}
      <div className="mc-detail-meta">
        <span className="mm-chip mm-chip-type">{c.type}</span>
        <TrustIcon tier={c.trustTier} withWords />
        {stale ? <span className="mm-chip mm-chip-stale">stale</span> : null}
        {c.status === 'deprecated' ? <span className="mm-chip mm-chip-deprecated">deprecated</span> : null}
        {c.fromTeam ? <span className="mm-chip mm-chip-from">from a shared digest</span> : null}
      </div>
      {c.tags.length > 0 ? <div className="mm-tags">{c.tags.join(', ')}</div> : null}
      {c.generatedAt ? <p className="mc-detail-when">Written {ago(c.generatedAt)}</p> : null}
      <div className="mm-actions">
        <button type="button" onClick={() => onAct('confirm')} disabled={busy || c.trustTier === 'human-reviewed'} title={TEAM_TRUST_WORDS['human-reviewed']} data-testid="concept-confirm">Confirm</button>
        <button type="button" onClick={() => onAct('deprecate')} disabled={busy || c.status === 'deprecated'} data-testid="concept-deprecate">Deprecate</button>
      </div>
      <p className={`mc-say${said ? ` ${said.tone}` : ''}`} role="status" aria-live="polite" data-testid="concept-said">{said?.text}</p>
    </div>
  );
}
