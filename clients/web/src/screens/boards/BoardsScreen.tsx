import { useSearchParams } from 'react-router';
import { isAdmin, useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { useShell } from '../../shell/context';
import { useHeaderTopic } from '../../shell/topic';
import { fetchBoards } from './api';
import { BoardView } from './BoardView';
import { OrgChart } from './OrgChart';
import { RhythmsTab } from './RhythmsTab';

/*
 * Boards (SPEC §6.5, PLAN P6-07/P6-08, `[proto §11]`): the team's saved views over the task substrate, the org chart behind them, and
 * Rhythms as the third tab — the timers that put work on the board without a person. The tab lives in the URL so a board or a rhythm
 * can be linked to, and the sidebar's Boards entry lands here with whatever tab it names.
 */

type Tab = 'board' | 'org' | 'rhythms';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'board', label: 'Board' },
  { id: 'org', label: 'Org chart' },
  { id: 'rhythms', label: 'Rhythms' },
];

export function BoardsScreen() {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const slug = team?.slug ?? teamSlug ?? '';
  useHeaderTopic('Boards');

  const raw = params.get('tab');
  const tab: Tab = raw === 'org' || raw === 'rhythms' ? raw : 'board';
  const canManage = isAdmin(session) || team?.myRole === 'lead';
  const boardsQ = useQuery(`boards:${slug}`, () => fetchBoards(slug));

  const setTab = (t: Tab): void => {
    const next = new URLSearchParams(params);
    if (t === 'board') next.delete('tab');
    else next.set('tab', t);
    // a card or board chosen in one tab is not a selection in another
    next.delete('card');
    setParams(next);
  };

  return (
    <div className="bd-screen" data-testid="boards-screen">
      <header className="bd-head">
        <div>
          <h2 className="bd-title">Boards</h2>
          <p className="bd-sub">Saved views over the team&apos;s cards; every drag is a task move the rules decide.</p>
        </div>
        <div className="tabs2" role="tablist" aria-label="Boards">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              data-testid={`boards-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'board' ? (
        <QueryView q={boardsQ}>{({ items }) => <BoardView slug={slug} boards={items} canManage={canManage} onBoardsChanged={boardsQ.reload} />}</QueryView>
      ) : tab === 'org' ? (
        <OrgChart slug={slug} />
      ) : (
        <RhythmsTab slug={slug} canManage={canManage} />
      )}
    </div>
  );
}
