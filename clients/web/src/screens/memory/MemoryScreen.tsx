import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { confirmConceptRoute, deprecateConceptRoute, ConfirmConceptResponse, DeprecateConceptResponse, type MemoryConceptSummary } from '@manythreads/shared';
import { call } from '../../api/client';
import { fetchConcepts } from './inboxApi';
import { InboxTab } from './InboxTab';

type TabId = 'concepts' | 'inbox';

const isStale = (c: MemoryConceptSummary): boolean => c.staleAfter !== null && Date.parse(c.staleAfter) < Date.now();

/** The Memory screen: the team's memory as concepts (the first tab) and the team's inbox (the second), where files, notes and messages are dropped (PLAN P5-28, P8-21). */
export function MemoryScreen() {
  const { team } = useParams<{ team: string }>();
  const [params, setParams] = useSearchParams();
  // a link to a concept (`?concept=`) opens the concepts tab; `?tab=inbox` opens the inbox
  const wantedConcept = params.get('concept');
  const tab: TabId = params.get('tab') === 'inbox' && !wantedConcept ? 'inbox' : 'concepts';

  const go = (next: TabId): void => {
    const q = new URLSearchParams(params);
    q.delete('concept');
    if (next === 'inbox') q.set('tab', 'inbox');
    else q.delete('tab');
    setParams(q, { replace: false });
  };

  return (
    <section className="mm-screen">
      <header className="mm-header">
        <h1 className="mm-title">Memory</h1>
        <p className="mm-subtitle">The team's OKF memory bundle — concepts, trust tiers, and provenance.</p>
      </header>
      <div className="mm-tabs" role="tablist" aria-label="Memory" data-testid="memory-tabs">
        <button type="button" role="tab" id="mm-tab-concepts" aria-selected={tab === 'concepts'} aria-controls="mm-panel" className={`mm-tab ${tab === 'concepts' ? 'on' : ''}`} onClick={() => go('concepts')} data-testid="memory-tab-concepts">Concepts</button>
        <button type="button" role="tab" id="mm-tab-inbox" aria-selected={tab === 'inbox'} aria-controls="mm-panel" className={`mm-tab ${tab === 'inbox' ? 'on' : ''}`} onClick={() => go('inbox')} data-testid="memory-tab-inbox">Inbox</button>
      </div>
      <div id="mm-panel" role="tabpanel" aria-labelledby={tab === 'inbox' ? 'mm-tab-inbox' : 'mm-tab-concepts'}>
        {team ? tab === 'inbox' ? <InboxTab slug={team} /> : <ConceptsTab slug={team} wanted={wantedConcept} /> : null}
      </div>
    </section>
  );
}

function ConceptsTab({ slug, wanted }: { slug: string; wanted: string | null }) {
  const [concepts, setConcepts] = useState<MemoryConceptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<MemoryConceptSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchConcepts(slug)
      .then((data) => { if (!cancelled) setConcepts(data.items); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  // a link to another concept replaces the person's pick
  useEffect(() => setPicked(null), [wanted]);
  // the concept a link names, until the person picks another
  const selected = picked ?? concepts.find((c) => c.path === wanted) ?? null;

  async function act(kind: 'confirm' | 'deprecate') {
    if (!selected) return;
    setBusy(true);
    try {
      if (kind === 'confirm') await call(confirmConceptRoute, { response: ConfirmConceptResponse }, undefined, { slug, path: selected.path });
      else await call(deprecateConceptRoute, { response: DeprecateConceptResponse }, undefined, { slug, path: selected.path });
    } catch {
      /* the buttons stay as they were; the list is read again on the next visit */
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="view-empty" aria-busy="true" />;
  if (error) return <div className="view-empty">Could not load memory concepts: {error}</div>;

  return (
    <>
      <div className="mm-body">
        <ul className="mm-tree" data-testid="concept-list">
          {concepts.map((c) => (
            <li key={c.path} className={`mm-concept ${selected?.path === c.path ? 'mm-concept-selected' : ''}`} onClick={() => setPicked(c)} data-testid="concept-row" data-path={c.path}>
              <span className="mm-concept-path">{c.path}</span>
              <span className="mm-chip mm-chip-type">{c.type}</span>
              <span className={`mm-chip mm-chip-trust mm-trust-${c.trustTier}`}>{c.trustTier}</span>
              {isStale(c) && <span className="mm-chip mm-chip-stale">stale</span>}
              {c.status === 'deprecated' && <span className="mm-chip mm-chip-deprecated">deprecated</span>}
              {c.fromTeam && <span className="mm-chip mm-chip-from">from a shared digest</span>}
            </li>
          ))}
        </ul>
        {selected && (
          <aside className="mm-detail" data-testid="concept-detail">
            <h2 className="mm-detail-title">{selected.title}</h2>
            <p className="mm-detail-desc">{selected.description}</p>
            <div className="mm-detail-meta">
              <span className="mm-chip mm-chip-type">{selected.type}</span>
              <span className={`mm-chip mm-chip-trust mm-trust-${selected.trustTier}`}>{selected.trustTier}</span>
              {isStale(selected) && <span className="mm-chip mm-chip-stale">stale</span>}
              {selected.status === 'deprecated' && <span className="mm-chip mm-chip-deprecated">deprecated</span>}
              {selected.fromTeam && <span className="mm-chip mm-chip-from">from a shared digest</span>}
            </div>
            {selected.tags.length > 0 && <div className="mm-tags">{selected.tags.join(', ')}</div>}
            <div className="mm-actions">
              <button type="button" onClick={() => act('confirm')} disabled={busy}>Confirm</button>
              <button type="button" onClick={() => act('deprecate')} disabled={busy}>Deprecate</button>
            </div>
          </aside>
        )}
      </div>
      {concepts.length === 0 && <div className="view-empty">No concepts yet. Drop a file into the team's inbox or ask a bot to write one.</div>}
    </>
  );
}

export default MemoryScreen;
