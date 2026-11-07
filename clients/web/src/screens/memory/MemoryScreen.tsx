import { PageHeader } from '../../components/PageHeader';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { confirmConceptRoute, deprecateConceptRoute, ConfirmConceptResponse, DeprecateConceptResponse, type MemoryConceptSummary } from '@manythreads/shared';
import { call } from '../../api/client';
import { ago } from '../../channels/format';
import { ForbiddenBody } from '../../components/states';
import { useShell } from '../../shell/context';
import { fetchConcepts } from './inboxApi';
import { InboxTab } from './InboxTab';
import { PERSONAL_TABS, TABS, nextTab, tabFromParams, type TabId } from './memoryTabs';
import { PersonalConceptsTab } from './PersonalConceptsTab';
import { PersonalInboxTab } from './PersonalInboxTab';
import { PERSONAL_MEMORY_HREF } from './personalWords';
import { SharingTab } from './SharingTab';
import { SpaceSwitch } from './SpaceSwitch';

const isStale = (c: MemoryConceptSummary): boolean => c.staleAfter !== null && Date.parse(c.staleAfter) < Date.now();

/**
 * The Memory screen has two sides, chosen by the switch at the top. Personal (`/memory`) is your own memory and your own inbox: only you see it and it is never
 * shared. Teams (`/t/<team>/memory`) is the team's memory as concepts (the first tab), the team's inbox (the second), where files, notes and messages are dropped,
 * and Sharing (the third), where memory is passed to and received from other teams (PLAN P5-28, P8-21, P8-26, P20-05). A guest has no Personal side.
 */
export function MemoryScreen() {
  const { team } = useParams<{ team: string }>();
  const { guest, teams } = useShell();
  const personal = team === undefined;
  const tabs = personal ? PERSONAL_TABS : TABS;
  const [params, setParams] = useSearchParams();
  // a link to a concept (`?concept=`) opens the concepts tab; `?tab=inbox` and `?tab=sharing` open the others
  const wantedConcept = params.get('concept');
  const tab: TabId = tabFromParams(params.get('tab'), wantedConcept, tabs);

  const go = (next: TabId): void => {
    const q = new URLSearchParams(params);
    q.delete('concept');
    if (next === 'concepts') q.delete('tab');
    else q.set('tab', next);
    setParams(q, { replace: false });
  };

  // arrow keys move between the tabs (and select them), Home and End jump to the first and last, as a tab list does
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = nextTab(tab, e.key, tabs);
    if (!target) return;
    e.preventDefault();
    go(target);
    document.getElementById(`mm-tab-${target}`)?.focus();
  };

  if (personal && guest) return <ForbiddenBody />;

  // the other side keeps the open tab where it exists there (the inbox is on both; Sharing is a team's only)
  const keepTab = tab === 'inbox' ? '?tab=inbox' : '';
  const firstTeam = teams[0]?.slug ?? null;
  const space = guest ? null : (
    <SpaceSwitch
      space={personal ? 'personal' : 'teams'}
      label="Whose memory"
      personalHref={`${PERSONAL_MEMORY_HREF}${keepTab}`}
      teamsHref={personal ? (firstTeam ? `/t/${encodeURIComponent(firstTeam)}/memory${keepTab}` : null) : `/t/${encodeURIComponent(team)}/memory${keepTab}`}
    />
  );

  return (
    <section className="mm-screen" data-space={personal ? 'personal' : 'teams'}>
      <PageHeader
        title="Memory"
        description={personal ? 'What you have kept, and what bots remember with you. Only you can see it.' : "What the team's bots remember, and how sure they are"}
        actions={space}
      />
      <div className="mm-tabs" role="tablist" aria-label="Memory" data-testid="memory-tabs" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`mm-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="mm-panel" tabIndex={tab === t.id ? 0 : -1} className={`mm-tab ${tab === t.id ? 'on' : ''}`} onClick={() => go(t.id)} data-testid={`memory-tab-${t.id}`}>{t.label}</button>
        ))}
      </div>
      <div id="mm-panel" role="tabpanel" aria-labelledby={`mm-tab-${tab}`}>
        {personal ? (
          tab === 'inbox' ? <PersonalInboxTab /> : <PersonalConceptsTab wanted={wantedConcept} />
        ) : tab === 'inbox' ? (
          <InboxTab slug={team} />
        ) : tab === 'sharing' ? (
          <SharingTab slug={team} />
        ) : (
          <ConceptsTab slug={team} wanted={wantedConcept} />
        )}
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
              <span className="mm-concept-path" title={c.path}>{c.title}</span>
              {c.description ? <span className="mm-concept-desc">{c.description}</span> : null}
              {c.generatedAt ? <span className="mm-concept-ago">{ago(c.generatedAt)}</span> : null}
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
