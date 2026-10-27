import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Board, Task, TaskState } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { isApiError } from '../../api/client';
import { Alert } from '../../components/ui';
import { STATE_LABEL, boardFilter, boardLabel, branchFor, cardRequest, columnsWithCards, emptyCard, moveProblem, ownerLabel, refusalText, type CardDraft, type LoadedColumn } from './board';
import { createBoard, createTask, fetchColumnTasks, moveTask } from './api';
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
  const [over, setOver] = useState<TaskState | null>(null);
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
  const q = useQuery(`board-cards:${slug}:${board?.id ?? 'none'}:${filterKey}:${revision}`, async (): Promise<LoadedColumn[]> => {
    if (!board) return [];
    const reads = await Promise.all(board.columns.map((c) => fetchColumnTasks(slug, { state: c.state, ...filter })));
    return board.columns.map((c, i) => ({ state: c.state, items: reads[i]?.items ?? [], total: reads[i]?.total ?? 0 }));
  });

  const columns = board && q.status === 'ok' ? columnsWithCards(board, q.data) : [];
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

  const move = async (task: Task, to: TaskState): Promise<void> => {
    if (!board) return;
    const problem = moveProblem(task, board, to);
    if (problem) {
      setNotice(problem);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await moveTask(slug, board.id, task.id, to);
      changed();
    } catch (err) {
      setNotice(refusalText(err));
    } finally {
      setBusy(false);
      setOver(null);
      setDrag(null);
    }
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
            {columns.map(({ column, cards, total }) => (
              <section
                key={column.state}
                className={`bd-col ${over === column.state ? 'over' : ''}`}
                data-testid="board-column"
                data-state={column.state}
                aria-label={column.title}
                onDragOver={(e) => {
                  if (drag && moveProblem(drag, board, column.state) === null) {
                    e.preventDefault();
                    setOver(column.state);
                  }
                }}
                onDragLeave={() => setOver((s) => (s === column.state ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) void move(drag, column.state);
                }}
              >
                <header className="bd-col-head">
                  <h3>{column.title}</h3>
                  <span className="bd-col-count" data-testid="column-total" data-vt-mask>
                    {cardCount(total)}
                  </span>
                </header>
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
                    <p className="bd-card-title">{card.title}</p>
                    <p className="bd-card-meta">
                      <span data-testid="card-owner-label">{ownerLabel(card.ownerId, people.roster, people.bots)}</span>
                      <span className="mono">{card.branch}</span>
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
          </div>
        )}
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
          revision={revision}
          onMove={move}
          onChanged={changed}
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
