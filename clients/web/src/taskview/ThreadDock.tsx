import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Approval, RunHead, ThreadTodo } from '@manythreads/shared';
import type { People } from '../channels/hooks';
import { CaretIcon, CheckIcon, ItemBlockedIcon, ItemWaitingIcon } from '../shell/icons';
import { currentItem, progressText, todoProgress } from '../channels/todo-card/words';
import { setShownQuestions } from '../channels/run-card/shownQuestions';
import { nowLine, runEnded } from '../channels/run-card/words';
import { useRunLines } from '../runs/useThreadRuns';
import { planTaskView } from './rules';
import { EMPTY_TASK_VIEW } from './channelTasks';
import { QuestionStrip, stripLine } from './QuestionStrip';
import { RunCompact } from './RunCompact';
import { TodoCompact } from './TodoCompact';
import { readDockFolded, writeDockFolded } from './storage';

/**
 * The one line of a thread's to-do list (owner, 2026-11-19): how many tasks are done and the task being worked on, "2 of 5 tasks done · Write the e2e test", or "5 of 5 tasks
 * complete" once all are. `state` picks the mark before it: a turning ring while a task is being worked on (or a run of the thread is), a flag when the current task is blocked,
 * a circle when the next one waits, a tick when all are done.
 */
export function todoLine(todo: ThreadTodo, run: RunHead | null): { state: 'working' | 'blocked' | 'waiting' | 'done'; count: string; text: string | null } {
  const p = todoProgress(todo.items);
  const tasks = p.total === 1 ? 'task' : 'tasks';
  if (p.allDone) return { state: 'done', count: `${p.done} of ${p.total} ${tasks} complete`, text: null };
  const count = `${p.done} of ${p.total} ${tasks} done`;
  const cur = currentItem(todo.items);
  if (cur === null) return { state: run !== null ? 'working' : 'waiting', count, text: null };
  if (cur.status === 'working') return { state: 'working', count, text: cur.text };
  // nothing is being worked on, but a bot of the thread is at work: say what it does
  if (run !== null) {
    const now = nowLine(run.now, run.state);
    return { state: cur.status === 'blocked' ? 'blocked' : 'working', count, text: cur.status === 'blocked' ? `Blocked: ${cur.text}` : `${run.botName} · ${now.code !== null ? `${now.text} ${now.code}` : now.text}` };
  }
  return { state: cur.status === 'blocked' ? 'blocked' : 'waiting', count, text: cur.status === 'blocked' ? `Blocked: ${cur.text}` : `Next: ${cur.text}` };
}

/** The mark before the to-do's line. */
function LineMark({ state }: { state: ReturnType<typeof todoLine>['state'] }) {
  return (
    <span className="tvLineMark" data-state={state} data-testid="dock-line-mark" aria-hidden="true">
      {state === 'working' ? <span className="tvSpin" /> : state === 'done' ? <CheckIcon size={14} /> : state === 'blocked' ? <ItemBlockedIcon size={14} /> : <ItemWaitingIcon size={14} />}
    </span>
  );
}

/** The words of the folded line, as one string (the label of its button, and the line of a run with no list). */
export function lineWords(run: RunHead | null, todo: ThreadTodo | null): string {
  if (todo !== null && todo.items.length > 0) {
    const l = todoLine(todo, run);
    // the ring is a picture: a screen reader hears "in progress" in words
    return l.text !== null ? `${l.count} · ${l.state === 'working' ? 'in progress: ' : ''}${l.text}` : l.count;
  }
  return foldedLine(run, todo);
}

/** What the line shows: with a list, its mark, the count (never cut) and the current task (cut with an ellipsis); without one, the run's pulse and its words. */
function LineBody({ run, todo }: { run: RunHead | null; todo: ThreadTodo | null }) {
  if (todo !== null && todo.items.length > 0) {
    const l = todoLine(todo, run);
    return (
      <>
        <LineMark state={l.state} />
        <span className="tvDockText" dir="auto" data-testid="dock-line">
          <b className="tvLineCount" data-testid="dock-line-count">{l.count}</b>
          {l.text !== null ? (
            <span className="tvLineNow">
              {' · '}
              {l.state === 'working' ? <span className="sr-only">in progress: </span> : null}
              {l.text}
            </span>
          ) : null}
        </span>
      </>
    );
  }
  return (
    <>
      {run !== null ? <span className="rcPulse" aria-hidden="true" /> : null}
      <span className="tvDockText" dir="auto" data-testid="dock-line">{foldedLine(run, todo)}</span>
    </>
  );
}

/** The line the folded dock says for a run: "Engineer · Running pnpm lint · 2 of 4". */
export function foldedLine(run: RunHead | null, todo: ThreadTodo | null): string {
  const parts: string[] = [];
  if (run !== null) {
    parts.push(run.botName);
    const now = nowLine(run.now, run.state);
    parts.push(now.code !== null ? `${now.text} ${now.code}` : now.text);
  } else if (todo !== null) {
    parts.push('To do');
  }
  if (todo !== null && todo.items.length > 0) {
    const p = todoProgress(todo.items);
    parts.push(p.allDone ? `${p.done} of ${p.total} done` : progressText(p));
  }
  return parts.join(' · ');
}

const narrow = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;

/**
 * What the thread has going, docked directly above the composer (P29-12): the to-do list, the run that is working, and below them, always, the question a bot is waiting on
 * with its Yes and No. Everything comes from the thread's own stores (the run lease, the to-do list, the approvals list): the dock asks the server for nothing of its own.
 * Folding hides the to-do and the run behind one line; it never hides a question.
 */
export function ThreadDock({ rootId, slug, people, runs, todo, approvals, reloadApprovals, railOpen = false }: { rootId: string;
  /** The side rail is open and draws the to-do and the run: the dock keeps one line of them (never the question). */
  railOpen?: boolean; slug: string | null; people: People; runs: readonly RunHead[]; todo: ThreadTodo | null; approvals: readonly Approval[]; reloadApprovals: () => void }) {
  const [chosen, setChosen] = useState<boolean | null>(() => readDockFolded(rootId));
  // a to-do list is one line until the person opens it (owner, 2026-11-19); a run alone starts open on a wide screen and folded on a phone
  const hasList = todo !== null && todo.items.length > 0;
  const storedFolded = chosen ?? (hasList || narrow());
  // the rail, when open, draws the whole list and the run: the dock keeps one line (what the person chose for the dock is kept for when the rail closes)
  const folded = storedFolded || railOpen;
  const toggle = useCallback(() => {
    writeDockFolded(rootId, !storedFolded);
    setChosen(!storedFolded);
  }, [rootId, storedFolded]);
  const live = useMemo(() => runs.filter((r) => !runEnded(r.state)).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), [runs]);
  const run = live[0] ?? null;
  // the questions, newest first: what the bot just asked is what the person came to answer
  const questions = useMemo(
    () => approvals.filter((a) => a.status === 'pending').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [approvals],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (todo === null) return;
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [todo]);
  const plan = planTaskView({ ...EMPTY_TASK_VIEW, run, moreRuns: Math.max(0, live.length - 1), todo, questions: [] }, now, { hidden: false, openInPanel: false });
  // a question is asked in one place: the thread's strip and the run card leave out what the dock draws
  const ids = questions.map((q) => q.id).join(',');
  useEffect(() => {
    if (slug === null || slug === '') return;
    setShownQuestions(rootId, 'dock', ids === '' ? [] : ids.split(','));
    return () => setShownQuestions(rootId, 'dock', []);
  }, [rootId, slug, ids]);
  // the steps are read only while the run's card is open here (the thread's run card reads them as well, from the same store)
  const lines = useRunLines(run !== null && !folded ? run.runId : null, run?.seq ?? 0);

  // the thread pane keeps a finished list as its one line ("5 of 5 tasks complete", owner 2026-11-19); only the channel's task view lets it go after a few minutes
  const showTodo = hasList;
  const cards = showTodo || plan.run === 'live';
  // no team yet (the slug is not known): nobody can answer, so no question is drawn (as the thread's cards did before)
  const asked = slug === null || slug === '' ? [] : questions;
  if (!cards && asked.length === 0) return null;
  const lineRun = plan.run === 'live' ? run : null;
  const lineTodo = showTodo ? todo : null;
  const line = lineWords(lineRun, lineTodo);
  return (
    <div className="tvDock" data-testid="thread-dock" data-folded={cards && folded ? 'true' : 'false'}>
      {cards ? (
        folded && railOpen ? (
          <p className="tvDockLine tvDockLine-rail" data-testid="dock-line-rail">
            <LineBody run={lineRun} todo={lineTodo} />
          </p>
        ) : folded ? (
          <button type="button" className="tvDockLine" aria-expanded={false} onClick={toggle} data-testid="dock-toggle" aria-label={`Show details: ${line}`}>
            <LineBody run={lineRun} todo={lineTodo} />
            <span className="rcChev" aria-hidden="true"><CaretIcon open={false} /></span>
          </button>
        ) : (
          <div className="tvDockBody" data-testid="dock-body">
            <button type="button" className="tvDockFold" aria-expanded onClick={toggle} data-testid="dock-toggle" aria-label="Fold the to-do and the run to one line">
              <span>Fold</span>
              <span className="rcChev" aria-hidden="true"><CaretIcon open /></span>
            </button>
            {showTodo && todo !== null ? <TodoCompact todo={todo} /> : null}
            {plan.run === 'live' && run !== null ? <RunCompact head={run} lines={lines.items} people={people} onOpen={() => undefined} more={plan.moreRuns} hideOpen /> : null}
          </div>
        )
      ) : null}
      {asked.length > 0 ? (
        <>
          {/* one polite line when a question arrives: the card itself is not a live region */}
          <p className="sr-only" role="status" data-testid="dock-said">{`Needs you: ${stripLine(asked[0]!)}`}</p>
          <QuestionStrip questions={asked} slug={slug ?? ''} rootId={rootId} onDecided={reloadApprovals} />
        </>
      ) : null}
    </div>
  );
}
