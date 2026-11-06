import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { MAX_BOARD_COLUMNS, type Board, type BoardColumn, type Task } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { isApiError } from '../../api/client';
import { Alert } from '../../components/ui';
import { STATE_LABEL, boardFilter, boardLabel, branchFor, cardRequest, columnMovedText, columnOf, emptyCard, moveProblem, noPlacement, ownerLabel, placeCards, refusalText, reorder, type CardDraft, type LoadedColumn, type Placement } from './board';
import { addColumn, createBoard, createTask, deleteColumn, fetchColumnTasks, fetchPlaces, moveTask, renameColumn, reorderColumns } from './api';
import { useCardActivity } from './activity';
import { AddColumn } from './AddColumn';
import { BotActivity } from './BotActivity';
import { ColumnHeader } from './ColumnHeader';
import { useTeamPeople } from './people';
import { CardPanel } from './CardPanel';
import { useChannelFeed } from '../../shell/channelFeed';

/*
 * The board itself (SPEC §6.5, PLAN P6-07): a saved view's columns, the cards in each, and a drag that is a task call. A card may only
 * be dropped where the transition table and the board's own column set allow it; anything else is refused before the request, and if the
 * server refuses anyway its sentence is what the board says. The card on the right is the same task row, with its history and actions.
 */

type Props = {
  slug: string;
  boards: Board[];
  /** A lead or a workspace admin: the two who may create a board (the route's own `requireManage`). */
  canManage: boolean;
  onBoardsChanged: () => void;
};

const cardCount = (n: number): string => `${n} card${n === 1 ? '' : 's'}`;

export function BoardView({ slug, boards, canManage, onBoardsChanged }: Props) {
  const [params, setParams] = useSearchParams();
  const people = useTeamPeople(slug);
  const feed = useChannelFeed(slug);
  const channelNames = useMemo(() => new Map(feed.groups.flatMap((g) => g.channels.map((c): [string, string] => [c.id, c.name]))), [feed.groups]);
  const [drag, setDrag] = useState<Task | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [live, setLive] = useState('');
  /** The order the columns are drawn in while a reorder is on its way to the server (and after it, until the board is read again). */
  const [order, setOrder] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [boardName, setBoardName] = useState('');
  const [newBoard, setNewBoard] = useState(false);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);

  const selectedBoard = params.get('board');
  const board = boards.find((b) => b.id === selectedBoard) ?? boards[0] ?? null;
  const selectedCard = params.get('card');

  const filter = board ? boardFilter(board) : {};
  const filterKey = JSON.stringify(filter);
  const states = board ? [...new Set(board.columns.map((c) => c.state))] : [];
  const q = useQuery(`board-cards:${slug}:${board?.id ?? 'none'}:${filterKey}:${states.join(',')}:${revision}`, async (): Promise<{ loaded: LoadedColumn[]; placement: Placement }> => {
    if (!board) return { loaded: [], placement: noPlacement };
    // One read per distinct state (two columns of one state share it), and one read of where cards sit among the columns.
    const [reads, placed] = await Promise.all([
      Promise.all(states.map((state) => fetchColumnTasks(slug, { state, ...filter }))),
      fetchPlaces(slug, board.id),
    ]);
    return {
      loaded: states.map((state, i) => ({ state, items: reads[i]?.items ?? [], total: reads[i]?.total ?? 0 })),
      placement: { places: new Map(placed.places.map((p) => [p.taskId as string, p.columnId])), counts: new Map(placed.counts.map((c) => [c.columnId, c.total])) },
    };
  });

  const activity = useCardActivity(slug, board?.teamId ?? '');

  // The columns in the order being shown: the saved order, or the one a reorder just asked for.
  const shownBoard = useMemo((): Board | null => {
    if (!board) return null;
    if (!order || order.length !== board.columns.length) return board;
    const byId = new Map(board.columns.map((c) => [c.id as string, c]));
    if (!order.every((id) => byId.has(id))) return board;
    return { ...board, columns: order.map((id) => byId.get(id)!) };
  }, [board, order]);

  // Once the boards are read again the saved order is the truth: the optimistic one is dropped.
  const savedOrder = board?.columns.map((c) => c.id).join() ?? '';
  useEffect(() => setOrder(null), [savedOrder, board?.id]);

  const columns = shownBoard && q.status === 'ok' ? placeCards(shownBoard, q.data.loaded, q.data.placement) : [];
  const places = q.status === 'ok' ? q.data.placement.places : noPlacement.places;
  const allCards = columns.flatMap((c) => c.cards);
  const current = allCards.find((c) => c.id === selectedCard) ?? null;

  const changed = (): void => {
    setRevision((r) => r + 1);
    q.reload();
  };

  const selectBoard = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set('board', id);
    next.delete('card');
    setParams(next);
    setNotice(null);
  };

  const selectCard = (id: string | null): void => {
    const next = new URLSearchParams(params);
    if (id) next.set('card', id);
    else next.delete('card');
    setParams(next);
  };

  const move = async (task: Task, to: BoardColumn): Promise<void> => {
    if (!board) return;
    const problem = moveProblem(task, board, to, columnOf(board, task, places)?.id);
    if (problem) {
      setNotice(problem);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await moveTask(slug, board.id, task.id, to.id);
      changed();
    } catch (err) {
      setNotice(refusalText(err));
    } finally {
      setBusy(false);
      setOver(null);
      setDrag(null);
    }
  };

  /** A column edit: runs it, and reads the boards and cards again either way (a refusal says why; a stale tab catches up). */
  const editColumns = async (run: () => Promise<unknown>): Promise<boolean> => {
    setNotice(null);
    try {
      await run();
      return true;
    } catch (err) {
      setOrder(null);
      setNotice(isApiError(err) && err.status === 403 ? 'Only a team lead or a workspace admin can change a board\u2019s columns.' : refusalText(err));
      return false;
    } finally {
      onBoardsChanged();
      changed();
    }
  };

  const moveColumn = async (id: string, to: number): Promise<void> => {
    if (!shownBoard || !board) return;
    const ids = shownBoard.columns.map((c) => c.id as string);
    const delta = to - ids.indexOf(id);
    const next = reorder(ids, id, delta);
    if (next.join() === ids.join()) return;
    setOrder(next);
    const name = shownBoard.columns.find((c) => c.id === id)?.name ?? 'The column';
    setLive(columnMovedText(name, next, id));
    // The ids sent are exactly the board's current ones, so a tab that missed another tab's change is refused (409) and reads again.
    await editColumns(() => reorderColumns(slug, board.id, next));
  };

  const addBoard = async (): Promise<void> => {
    setFormProblem(null);
    try {
      const res = await createBoard(slug, { name: boardName.trim() });
      setBoardName('');
      setNewBoard(false);
      onBoardsChanged();
      selectBoard(res.board.id);
    } catch (err) {
      setFormProblem(isApiError(err) && err.status === 403 ? 'Only a team lead or a workspace admin can create a board.' : refusalText(err));
    }
  };

  const addCard = async (): Promise<void> => {
    if (!draft) return;
    const built = cardRequest(draft);
    if (!built.ok) {
      setFormProblem(built.message);
      return;
    }
    setFormProblem(null);
    try {
      const res = await createTask(slug, built.body);
      setDraft(null);
      changed();
      selectCard(res.task.id);
    } catch (err) {
      setFormProblem(refusalText(err));
    }
  };

  if (boards.length === 0) {
    return (
      <div className="bd-empty" data-testid="boards-empty">
        <p className="bd-empty-title">No boards yet</p>
        <p className="bd-empty-body">
          A board is a saved view over the team&apos;s cards: Open · In progress · Verify · Waiting on a person · Done. A team lead or a
          workspace admin creates the first one.
        </p>
        {canManage ? (
          <div className="bd-new-board">
            <input value={boardName} onChange={(e) => setBoardName(e.target.value)} placeholder="Board name" aria-label="Board name" data-testid="new-board-name" />
            <button type="button" className="btn primary" disabled={boardName.trim() === ''} onClick={() => void addBoard()} data-testid="create-board">
              Create board
            </button>
          </div>
        ) : null}
        {formProblem ? <Alert>{formProblem}</Alert> : null}
      </div>
    );
  }

  if (!board) return null;

  return (
    <div className={`bd-body${selectedCard ? ' with-panel' : ''}`} data-testid="board-view" data-board={board.id}>
      <div className="bd-main">
        <div className="bd-toolbar">
          <label className="bd-field inline">
            <span>Board</span>
            <select value={board.id} onChange={(e) => selectBoard(e.target.value)} data-testid="board-select">
              {boards.map((b) => (
                <option key={b.id} value={b.id} data-channel-board={b.channelId ?? undefined}>
                  {boardLabel(b, channelNames)}
                </option>
              ))}
            </select>
          </label>
          <span className="bd-hint">Drag a card to move it; the task rules decide where it may go.</span>
          <div className="bd-toolbar-act">
            <button type="button" className="btn s" onClick={() => { setDraft(emptyCard()); setFormProblem(null); }} data-testid="new-card">
              New card
            </button>
            {canManage ? (
              <button type="button" className="btn s" onClick={() => setNewBoard((v) => !v)} data-testid="new-board">
                New board
              </button>
            ) : null}
          </div>
        </div>

        {newBoard ? (
          <div className="bd-new-board">
            <input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              placeholder="Board name"
              aria-label="Board name"
              data-testid="new-board-name"
              onKeyDown={(e) => e.key === 'Enter' && boardName.trim() !== '' && void addBoard()}
            />
            <button type="button" className="btn s" disabled={boardName.trim() === ''} onClick={() => void addBoard()} data-testid="create-board">
              Create
            </button>
          </div>
        ) : null}

        {notice ? (
          <div data-testid="board-refusal">
            <Alert>{notice}</Alert>
          </div>
        ) : null}

        {draft ? (
          <div className="bd-new-card" data-testid="new-card-form">
            <label className="bd-field">
              <span>Title</span>
              <input
                value={draft.title}
                onChange={(e) => {
                  const title = e.target.value;
                  // The branch follows the title until someone types their own: a card is about a branch, so neither field starts empty.
                  const auto = draft.branch === '' || draft.branch === branchFor(draft.title);
                  setDraft({ ...draft, title, ...(auto ? { branch: branchFor(title) } : {}) });
                }}
                placeholder="What the card is"
                data-testid="new-card-title"
              />
            </label>
            <label className="bd-field">
              <span>Branch</span>
              <input
                value={draft.branch}
                onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                placeholder="task/what-it-is"
                className="mono"
                data-testid="new-card-branch"
              />
            </label>
            <div className="bd-row2">
              <label className="bd-field">
                <span>Kind</span>
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as CardDraft['kind'] })} data-testid="new-card-kind">
                  {(['code', 'content', 'ops', 'other'] as const).map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="bd-field">
                <span>Priority</span>
                <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as CardDraft['priority'] })} data-testid="new-card-priority">
                  {(['low', 'normal', 'high'] as const).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="bd-field">
              <span>Description</span>
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} data-testid="new-card-description" />
            </label>
            {formProblem ? <Alert>{formProblem}</Alert> : null}
            <div className="bd-toolbar-act">
              <button type="button" className="btn s" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={draft.title.trim() === ''} onClick={() => void addCard()} data-testid="create-card">
                Create card
              </button>
            </div>
          </div>
        ) : null}

        {q.status === 'loading' ? (
          <p className="loading" aria-busy="true">Loading…</p>
        ) : q.status === 'error' ? (
          <div>
            <Alert>{q.error.message}</Alert>
            <button type="button" className="btn" onClick={q.reload}>Try again</button>
          </div>
        ) : (
          <div className="bd-cols" data-landmark="board">
            {columns.map(({ column, cards, total }, index) => (
              <section
                key={column.id}
                className={`bd-col ${over === column.id ? 'over' : ''}`}
                data-testid="board-column"
                data-state={column.state}
                data-column={column.id}
                aria-label={column.name}
                onDragOver={(e) => {
                  if (colDrag) {
                    e.preventDefault();
                    return;
                  }
                  if (drag && moveProblem(drag, board, column, columnOf(board, drag, places)?.id) === null) {
                    e.preventDefault();
                    setOver(column.id);
                  }
                }}
                onDragLeave={() => setOver((s) => (s === column.id ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (colDrag) {
                    const id = colDrag;
                    setColDrag(null);
                    void moveColumn(id, index);
                    return;
                  }
                  if (drag) void move(drag, column);
                }}
              >
                <ColumnHeader
                  column={column}
                  index={index}
                  last={index === columns.length - 1}
                  total={cardCount(total)}
                  canManage={canManage}
                  onRename={(name) => editColumns(() => renameColumn(slug, board.id, column.id, { name })).then(() => undefined)}
                  onMove={(delta) => void moveColumn(column.id, index + delta)}
                  onDelete={() => editColumns(() => deleteColumn(slug, board.id, column.id)).then(() => undefined)}
                  onGripDragStart={(e) => {
                    e.dataTransfer.setData('application/x-mt-column', column.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setColDrag(column.id);
                  }}
                  onGripDragEnd={() => setColDrag(null)}
                />
                {total > cards.length ? <p className="bd-muted">Newest {cards.length} shown.</p> : null}
                {cards.length === 0 ? <p className="bd-col-empty">Nothing here.</p> : null}
                {cards.map((card) => (
                  <article
                    key={card.id}
                    className={`bd-card ${selectedCard === card.id ? 'on' : ''} ${drag?.id === card.id ? 'drag' : ''}`}
                    draggable
                    tabIndex={0}
                    role="button"
                    aria-pressed={selectedCard === card.id}
                    data-testid="board-card"
                    data-task={card.id}
                    data-state={card.state}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', card.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag(card);
                      setNotice(null);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                    onClick={() => selectCard(card.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectCard(card.id);
                      }
                    }}
                  >
                    <div className="bd-card-top">
                      <span className={`bd-kind ${card.kind}`}>{card.kind}</span>
                      {card.priority !== 'normal' ? <span className={`bd-prio ${card.priority}`}>{card.priority}</span> : null}
                      <span className="bd-card-state">{STATE_LABEL[card.state]}</span>
                    </div>
                    <BotActivity bots={activity.get(card.id) ?? []} roster={people.bots} className="bd-card-bot" />
                    <p className="bd-card-title">{card.title}</p>
                    <p className="bd-card-meta" title={`Work branch: ${card.branch}`}>
                      <span data-testid="card-owner-label">{ownerLabel(card.ownerId, people.roster, people.bots)}</span>
                    </p>
                    {card.blockerReason ? <p className="bd-card-blocker">{card.blockerReason}</p> : null}
                    {card.reworkCount > 0 || card.handoffCount > 0 ? (
                      <p className="bd-card-bounds">
                        {card.reworkCount > 0 ? `${card.reworkCount} rework${card.reworkCount === 1 ? '' : 's'}` : ''}
                        {card.reworkCount > 0 && card.handoffCount > 0 ? ' · ' : ''}
                        {card.handoffCount > 0 ? `${card.handoffCount} handoff${card.handoffCount === 1 ? '' : 's'}` : ''}
                      </p>
                    ) : null}
                  </article>
                ))}
              </section>
            ))}
            {canManage ? <AddColumn full={board.columns.length >= MAX_BOARD_COLUMNS} onAdd={(name, state) => editColumns(() => addColumn(slug, board.id, { name, state })).then(() => undefined)} /> : null}
          </div>
        )}
        <p className="sr-only bd-live" role="status" aria-live="polite" data-testid="board-live">{live}</p>
        {busy ? <p className="bd-muted" role="status">Moving…</p> : null}
      </div>

      {board && current ? (
        <CardPanel
          key={`${current.id}:${revision}`}
          slug={slug}
          task={current}
          board={board}
          roster={people.roster}
          bots={people.bots}
          botsAtWork={activity.get(current.id) ?? []}
          placeId={columnOf(board, current, places)?.id}
          revision={revision}
          onMove={move}
          onChanged={changed}
          onRefresh={q.reload}
        />
      ) : board && selectedCard ? (
        <aside className="bd-panel">
          <p className="bd-muted">This card is no longer on this board.</p>
          <button type="button" className="btn s" onClick={() => selectCard(null)}>Close</button>
        </aside>
      ) : null}
    </div>
  );
}
