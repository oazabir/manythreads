import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { personalRecipeById, recipeToDraft, type ActionItemView, type ChangeActionItemRequest, type ListActionItemsResponse, type TeamSummary } from '@manythreads/shared';
import { fetchTeams } from '../../../api/endpoints';
import { TaskListIcon } from '@proicons/react';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { proIcon } from '../../../components/proicon';
import { ForbiddenBody, QueryView } from '../../../components/states';
import { Time } from '../../../components/ui';
import { useSession } from '../../../app/session';
import { useQuery } from '../../../app/useQuery';
import { message } from '../../memory/inboxWords';
import { createRoutine } from '../routines/routinesApi';
import { localTimeZone, sourcesSentence } from '../routines/routinesWords';
import { addItemToBoard, changeActionItem, fetchActionItems } from './actionItemsApi';
import { CHANGED_UNDER_YOU, countLine, dueLabel, dueProblem, isConflict, splitItems, todayIso } from './actionItemsWords';

const ActionItemsIcon = proIcon(TaskListIcon);

/**
 * Account → Action items (PLAN P20-12): the person's own list, the file "Action items/action-items.md" in their Personal space. The list can be ticked, edited, added to
 * and turned into cards on a board; every change is a new version of the file. A routine ("Keep my action items") can keep it up to date, but it never deletes an
 * item and it marks one done only with a line that says what showed it. A change made while someone else's save landed is refused and the list reloads.
 */
/**
 * A day that may be left empty. The browser draws an empty date box as "mm/dd/yyyy", which reads as an error to a person who has not chosen anything; while it is empty
 * and not in use the box says "Optional" instead (the text of the box is hidden by `.ai-date.unset`).
 */
function OptionalDate({ id, value, onChange, label, testId }: { id?: string; value: string; onChange: (v: string) => void; label: string; testId: string }) {
  return (
    <span className={`ai-date ${value === '' ? 'unset' : ''}`}>
      <input id={id} className="dlg-input" type="date" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} data-testid={testId} />
      {value === '' ? <span className="ai-date-hint" aria-hidden="true">Optional</span> : null}
    </span>
  );
}

export function ActionItemsView() {
  const guest = useSession().role === 'guest';
  if (guest) return <div className="inline-state"><ForbiddenBody /></div>;
  return <ActionItemsBody />;
}

function ActionItemsBody() {
  const q = useQuery('my-action-items', fetchActionItems);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Your action items" description="Things you have to do, kept in your own files. You can change the list yourself, or let a routine keep it up to date." />
      {notice ? <p className="rt-notice" role="status" data-testid="action-items-notice">{notice}</p> : null}
      <QueryView q={q}>
        {(data) => (
          <ListBody
            key={`${data.revision ?? "none"}-${data.keeperRoutineId ?? "no-keeper"}`}
            initial={data}
            onConflict={() => {
              setNotice(CHANGED_UNDER_YOU);
              q.reload();
            }}
            onKeeper={q.reload}
          />
        )}
      </QueryView>
    </>
  );
}

function ListBody({ initial, onConflict, onKeeper }: { initial: ListActionItemsResponse; onConflict: () => void; onKeeper: () => void }) {
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const teamsQ = useQuery('action-items-teams', () => fetchTeams());
  const teams = teamsQ.status === 'ok' ? teamsQ.data.teams.filter((t) => t.myRole !== null) : [];
  const today = todayIso();
  const { open, done } = splitItems(list.items);

  /** Sends one change at the revision the list was read at. A conflict reloads; any other refusal is said under the list and the list stays as it was. */
  const change = async (c: ChangeActionItemRequest['change']): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await changeActionItem(list.revision, c);
      setList(answer.list);
      return true;
    } catch (e) {
      if (isConflict(e)) onConflict();
      else setError(message(e, 'That could not be saved. Your list is as it was.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const board = async (item: ActionItemView, slug: string): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await addItemToBoard(slug, list.revision, item);
      if (r.list) setList(r.list);
      return r.recorded ? null : (r.problem ?? 'The card was made, but the list could not note it.');
    } catch (e) {
      return message(e, 'The card could not be made.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="block" aria-labelledby="ai-keeper" data-testid="action-items-keeper">
        <h2 className="bh" id="ai-keeper">Keeping it up to date</h2>
        <Keeper routineId={list.keeperRoutineId} onChanged={onKeeper} />
      </section>

      <section className="block" aria-labelledby="ai-list" data-testid="action-items">
        <h2 className="bh" id="ai-list">Your list</h2>
        <div className="block-body">
          <AddForm busy={busy} onAdd={(what, owner, due) => change({ op: 'add', what, ...(owner ? { owner } : {}), ...(due ? { due } : {}) })} />
          <p className="rt-line" data-testid="action-items-count">{countLine(list.items)}{list.updatedAt ? <> Last saved <Time iso={list.updatedAt} />.</> : null}</p>
          {error ? <p className="rt-error" role="alert" data-testid="action-items-error">{error}</p> : null}
        </div>
        {list.items.length === 0 ? (
          <div className="block-body">
            <EmptyState icon={ActionItemsIcon} testId="action-items-none" title="Nothing on your list yet" action={{ label: 'Add the first one', onClick: () => document.getElementById('ai-what')?.focus() }}>
              Things you have to do show up here, from you or from a routine.
            </EmptyState>
          </div>
        ) : null}
        {open.length === 0 && list.items.length > 0 ? <p className="rt-quiet-line" data-testid="action-items-allclear">Everything on your list is done.</p> : null}
        <ul className="ai-list" data-testid="action-items-open">
          {open.map((i) => <Row key={i.id} item={i} today={today} busy={busy} teams={teams} onChange={change} onBoard={board} />)}
        </ul>
        {done.length > 0 ? (
          <details className="ai-done" data-testid="action-items-done-group">
            <summary>{done.length} done</summary>
            <ul className="ai-list" data-testid="action-items-done">
              {done.map((i) => <Row key={i.id} item={i} today={today} busy={busy} teams={teams} onChange={change} onBoard={board} />)}
            </ul>
          </details>
        ) : null}
      </section>
    </>
  );
}

function AddForm({ busy, onAdd }: { busy: boolean; onAdd: (what: string, owner: string, due: string) => Promise<boolean> }) {
  const [what, setWhat] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const problem = dueProblem(due);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (what.trim() === '' || problem || busy) return;
    if (await onAdd(what.trim(), owner.trim(), due.trim())) {
      setWhat('');
      setOwner('');
      setDue('');
    }
  };
  return (
    <form className="ai-add" onSubmit={(e) => void submit(e)} data-testid="action-item-add">
      <label className="dlg-label" htmlFor="ai-what">Add an action</label>
      <input id="ai-what" className="dlg-input" value={what} maxLength={500} onChange={(e) => setWhat(e.target.value)} placeholder="Send the revised quote to Acme" autoComplete="off" data-testid="action-item-what" />
      <div className="ai-add-row">
        <div className="ai-field">
          <label className="dlg-label" htmlFor="ai-owner">Who</label>
          <input id="ai-owner" className="dlg-input" value={owner} maxLength={120} onChange={(e) => setOwner(e.target.value)} placeholder="Optional" autoComplete="off" data-testid="action-item-owner" />
        </div>
        <div className="ai-field">
          <label className="dlg-label" htmlFor="ai-due">Due</label>
          <OptionalDate id="ai-due" value={due} onChange={setDue} label="Due date" testId="action-item-due" />
        </div>
        <button type="submit" className="btn primary" disabled={busy || what.trim() === '' || problem !== null} data-testid="action-item-add-button">Add</button>
      </div>
      {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
    </form>
  );
}

function Row({ item, today, busy, teams, onChange, onBoard }: {
  item: ActionItemView;
  today: string;
  busy: boolean;
  teams: readonly TeamSummary[];
  onChange: (c: ChangeActionItemRequest['change']) => Promise<boolean>;
  onBoard: (item: ActionItemView, slug: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [what, setWhat] = useState(item.what);
  const [owner, setOwner] = useState(item.owner ?? '');
  const [due, setDue] = useState(item.due ?? '');
  const [slug, setSlug] = useState(teams[0]?.slug ?? '');
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardProblem, setBoardProblem] = useState<string | null>(null);
  const dueWords = item.due ? dueLabel(item.due, today) : null;
  const problem = dueProblem(due);

  const saveEdit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (what.trim() === '' || problem) return;
    const ok = await onChange({ op: 'edit', id: item.id, what: what.trim(), owner: owner.trim() === '' ? null : owner.trim(), due: due.trim() === '' ? null : due.trim() });
    if (ok) setEditing(false);
  };

  return (
    <li className="ai-row" data-testid="action-item" data-id={item.id} data-done={item.done}>
      <label className="ai-tick">
        <input type="checkbox" checked={item.done} disabled={busy} onChange={(e) => void onChange({ op: 'tick', id: item.id, done: e.target.checked })} aria-label={item.done ? `Mark not done: ${item.what}` : `Mark done: ${item.what}`} data-testid="action-item-tick" />
      </label>
      <div className="ai-main">
        {editing ? (
          <form className="ai-edit" onSubmit={(e) => void saveEdit(e)} data-testid="action-item-edit-form">
            <input className="dlg-input" value={what} maxLength={500} onChange={(e) => setWhat(e.target.value)} aria-label="What to do" data-testid="action-item-edit-what" />
            <div className="ai-add-row">
              <input className="dlg-input" value={owner} maxLength={120} onChange={(e) => setOwner(e.target.value)} placeholder="Who" aria-label="Who" data-testid="action-item-edit-owner" />
              <OptionalDate value={due} onChange={setDue} label="Due date" testId="action-item-edit-due" />
              <button type="submit" className="btn s primary" disabled={busy || what.trim() === '' || problem !== null} data-testid="action-item-edit-save">Save</button>
              <button type="button" className="btn s" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
          </form>
        ) : (
          <>
            <div className={item.done ? 'ai-what done' : 'ai-what'} data-testid="action-item-text">{item.what}</div>
            <p className="ai-meta">
              {item.owner ? <span data-testid="action-item-owner-text">{item.owner}</span> : null}
              {dueWords ? <span className={dueWords.overdue && !item.done ? 'ai-due late' : 'ai-due'} data-testid="action-item-due-text">{dueWords.text}</span> : null}
              {item.source ? <span data-testid="action-item-source">{item.source}</span> : null}
              {item.cardTaskId ? <span data-testid="action-item-on-board">On a board</span> : null}
            </p>
            {item.why.length > 0 ? (
              <details className="ai-why">
                <summary>Why</summary>
                <ul data-testid="action-item-why">{item.why.map((w) => <li key={w}>{w}</li>)}</ul>
              </details>
            ) : null}
          </>
        )}
        {boardOpen && !item.cardTaskId ? (
          <div className="ai-board" data-testid="action-item-board-form">
            <label className="dlg-label" htmlFor={`ai-team-${item.id}`}>Team</label>
            <select id={`ai-team-${item.id}`} className="dlg-input" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="action-item-team">
              {teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
            </select>
            <button
              type="button"
              className="btn s primary"
              disabled={busy || slug === ''}
              onClick={() => void onBoard(item, slug).then((p) => { setBoardProblem(p); if (!p) setBoardOpen(false); })}
              data-testid="action-item-board-go"
            >Make a card</button>
            <button type="button" className="btn s" onClick={() => setBoardOpen(false)}>Cancel</button>
            {boardProblem ? <p className="dlg-error" role="alert" data-testid="action-item-board-error">{boardProblem}</p> : null}
          </div>
        ) : null}
      </div>
      {!editing ? (
        <div className="ai-actions">
          <button type="button" className="btn s quiet" disabled={busy} onClick={() => setEditing(true)} aria-label={`Edit: ${item.what}`} data-testid="action-item-edit">Edit</button>
          {!item.cardTaskId && teams.length > 0 ? (
            <button type="button" className="btn s quiet" disabled={busy} onClick={() => setBoardOpen((v) => !v)} aria-label={`Add to a board: ${item.what}`} data-testid="action-item-to-board">Add to board</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The routine "Keep my action items": on, it is named and linked; off, the person sees the plan and turns it on with a yes. Nothing is switched on by opening this page. */
function Keeper({ routineId, onChanged }: { routineId: string | null; onChanged: () => void }) {
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipe = personalRecipeById('action-items');
  if (routineId) {
    return (
      <div className="block-body">
        <p className="d" data-testid="keeper-on">A routine keeps this list up to date. It adds what it finds and marks an item done only with a line that says what showed it. It never deletes one.</p>
        <p className="rt-line"><Link to="/account/routines" data-testid="keeper-link">See it under Routines</Link></p>
      </div>
    );
  }
  if (!recipe) return null;
  const draft = recipeToDraft(recipe, localTimeZone());
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await createRoutine({
        name: draft.name,
        words: recipe.sentence,
        botSlug: draft.botSlug,
        schedule: draft.schedule,
        scheduleWords: draft.scheduleWords,
        timeZone: draft.timeZone,
        prompt: draft.prompt,
        sources: draft.sources,
        outputPath: draft.outputPath,
        outputMode: draft.outputMode,
        recipeId: recipe.id,
      });
      setPlanning(false);
      onChanged();
    } catch (e) {
      setError(message(e, 'The routine could not be saved. Nothing was turned on.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="block-body">
      <p className="d" data-testid="keeper-off">Nothing keeps this list up to date for you. You can have a routine do it each weekday morning.</p>
      {planning ? (
        <div className="ai-plan" data-testid="keeper-plan">
          <p className="rt-line"><strong>{draft.name}</strong>: {draft.scheduleWords} ({draft.timeZone})</p>
          <p className="rt-line">{sourcesSentence(draft.sources)}</p>
          <p className="rt-line">It writes only to <span className="mono">{draft.outputPath}</span> in your files.</p>
          {error ? <p className="rt-error" role="alert" data-testid="keeper-error">{error}</p> : null}
          <div className="rt-save">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void turnOn()} data-testid="keeper-confirm">{busy ? 'Saving…' : 'Turn it on'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPlanning(false)} data-testid="keeper-cancel">Not now</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setPlanning(true)} data-testid="keeper-start">Keep it up to date for me</button>
      )}
    </div>
  );
}
