import { isAdmin, useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { useShell } from '../../shell/context';
import { useHeaderTopic } from '../../shell/topic';
import { fetchBoards } from './api';
import { BoardView } from './BoardView';

/*
 * Boards (SPEC §6.5, PLAN P6-07): the team's saved views over the task substrate. The org chart and Rhythms are their own screens
 * now, each with a sidebar entry (`/t/<team>/org` and `/t/<team>/rhythms`); this page is only the board.
 */

export function BoardsScreen() {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  useHeaderTopic('Boards');

  const canManage = isAdmin(session) || team?.myRole === 'lead';
  const boardsQ = useQuery(`boards:${slug}`, () => fetchBoards(slug));

  return (
    <div className="bd-screen" data-testid="boards-screen">
      <header className="bd-head">
        <div>
          <h2 className="bd-title">Boards</h2>
          <p className="bd-sub">Saved views over the team&apos;s cards; every drag is a task move the rules decide.</p>
        </div>
      </header>

      <QueryView q={boardsQ}>{({ items }) => <BoardView slug={slug} boards={items} canManage={canManage} onBoardsChanged={boardsQ.reload} />}</QueryView>
    </div>
  );
}
