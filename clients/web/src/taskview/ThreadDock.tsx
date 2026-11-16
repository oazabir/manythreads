import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Approval, RunHead, ThreadTodo } from '@manythreads/shared';
import type { People } from '../channels/hooks';
import { CaretIcon } from '../shell/icons';
import { progressText, todoProgress } from '../channels/todo-card/words';
import { setShownQuestions } from '../channels/run-card/shownQuestions';
import { nowLine, runEnded } from '../channels/run-card/words';
import { useRunLines } from '../runs/useThreadRuns';
import { planTaskView } from './rules';
import { EMPTY_TASK_VIEW } from './channelTasks';
import { QuestionStrip, stripQuestion } from './QuestionStrip';
import { RunCompact } from './RunCompact';
import { TodoCompact } from './TodoCompact';
import { readDockFolded, writeDockFolded } from './storage';

/** The line the folded dock says: "Engineer · Running pnpm lint · 2 of 4". */
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
export function ThreadDock({ rootId, slug, people, runs, todo, approvals, reloadApprovals }: { rootId: string; slug: string | null; people: People; runs: readonly RunHead[]; todo: ThreadTodo | null; approvals: readonly Approval[]; reloadApprovals: () => void }) {
  const [folded, setFolded] = useState<boolean>(() => readDockFolded(rootId) ?? narrow());
  const toggle = useCallback(() => {
    setFolded((f) => {
      writeDockFolded(rootId, !f);
      return !f;
    });
  }, [rootId]);
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
    if (slug === null) return;
    setShownQuestions(rootId, 'dock', ids === '' ? [] : ids.split(','));
    return () => setShownQuestions(rootId, 'dock', []);
  }, [rootId, slug, ids]);
  // the steps are read only while the run's card is open here (the thread's run card reads them as well, from the same store)
  const lines = useRunLines(run !== null && !folded ? run.runId : null, run?.seq ?? 0);

  const cards = plan.todo || plan.run === 'live';
  if (!cards && questions.length === 0) return null;
  const line = foldedLine(plan.run === 'live' ? run : null, plan.todo ? todo : null);
  return (
    <div className="tvDock" data-testid="thread-dock" data-folded={cards && folded ? 'true' : 'false'}>
      {cards ? (
        folded ? (
          <button type="button" className="tvDockLine" aria-expanded={false} onClick={toggle} data-testid="dock-toggle" aria-label={`Show details: ${line}`}>
            {run !== null ? <span className="rcPulse" aria-hidden="true" /> : null}
            <span className="tvDockText" dir="auto" data-testid="dock-line">{line}</span>
            <span className="rcChev" aria-hidden="true"><CaretIcon open={false} /></span>
          </button>
        ) : (
          <div className="tvDockBody" data-testid="dock-body">
            <button type="button" className="tvDockFold" aria-expanded onClick={toggle} data-testid="dock-toggle" aria-label="Fold the to-do and the run to one line">
              <span>Fold</span>
              <span className="rcChev" aria-hidden="true"><CaretIcon open /></span>
            </button>
            {plan.todo && todo !== null ? <TodoCompact todo={todo} /> : null}
            {plan.run === 'live' && run !== null ? <RunCompact head={run} lines={lines.items} people={people} onOpen={() => undefined} more={plan.moreRuns} hideOpen /> : null}
          </div>
        )
      ) : null}
      {questions.length > 0 ? (
        <>
          {/* one polite line when a question arrives: the card itself is not a live region */}
          <p className="sr-only" role="status" data-testid="dock-said">{`Needs you: ${stripQuestion(questions[0]!)}`}</p>
          <QuestionStrip questions={questions} slug={slug ?? ''} rootId={rootId} onDecided={reloadApprovals} />
        </>
      ) : null}
    </div>
  );
}
