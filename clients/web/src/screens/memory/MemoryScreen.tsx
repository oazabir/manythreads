import { PageHeader } from '../../components/PageHeader';
import { type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ForbiddenBody } from '../../components/states';
import { useShell } from '../../shell/context';
import { ConceptsTab } from './ConceptsTab';
import { InboxTab } from './InboxTab';
import { PERSONAL_TABS, TABS, nextTab, tabFromParams, type TabId } from './memoryTabs';
import { PersonalConceptsTab } from './PersonalConceptsTab';
import { PersonalInboxTab } from './PersonalInboxTab';
import { PERSONAL_MEMORY_HREF } from './personalWords';
import { SharingTab } from './SharingTab';
import { SpaceSwitch } from './SpaceSwitch';

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
          <ConceptsTab slug={team} wanted={wantedConcept} onOpenInbox={() => go('inbox')} />
        )}
      </div>
    </section>
  );
}

export default MemoryScreen;
