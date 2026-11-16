import { memo, useCallback, useEffect, useState } from 'react';
import type { People } from '../channels/hooks';
import { useTaskView } from './useTaskView';
import { channelTasksStore } from './store';
import { planTaskView } from './rules';
import { readHidden, writeHidden } from './storage';
import { useIsOpenInPanel } from './openRoot';
import { TodoCompact } from './TodoCompact';
import { RunCompact, RunEndedLine } from './RunCompact';
import { QuestionStrip } from './QuestionStrip';
import { progressText, todoProgress } from '../channels/todo-card/words';

/** Redraw once in a while so a card folds when its minutes are up, with no push to say so; only while something here could still fold. */
function useWallClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * What a thread has going, under its root in the channel (P29): the to-do card, the live run card and the question strip, so a person follows and answers without opening
 * the thread. All of it comes from the channel's one store (`useTaskView`): a row costs no request of its own. When the root is open in the right panel the thread shows the
 * same, answerable, so here only a chip stays; "Hide" folds the cards to the chip for this person and this thread (the questions stay: somebody has to answer them).
 */
export const TaskView = memo(function TaskView({ rootId, channelId, teamSlug, people, openThread }: { rootId: string; channelId: string; teamSlug: string | null; people: People; openThread: (rootId: string) => void }) {
  const view = useTaskView(rootId);
  const openInPanel = useIsOpenInPanel(rootId);
  const [hidden, setHiddenState] = useState(() => readHidden(rootId));
  const timed = view.todo !== null || view.ended !== null;
  const now = useWallClock(timed);
  const hide = useCallback((on: boolean) => {
    writeHidden(rootId, on);
    setHiddenState(on);
  }, [rootId]);
  const plan = planTaskView(view, now, { hidden, openInPanel });
  const open = useCallback(() => openThread(rootId), [openThread, rootId]);
  const decided = useCallback(() => channelTasksStore.refreshQuestions(channelId), [channelId]);

  if (!plan.any && plan.folded === null) return null;
  const todoProgressText = view.todo !== null && view.todo.items.length > 0 && !todoProgress(view.todo.items).allDone ? progressText(todoProgress(view.todo.items)) : null;
  const chipWho = view.run !== null ? `${view.run.botName} is working` : null;

  // "Hide" is a small quiet button at the end of the row the person is reading: the ended-run line, the finished list's header, else under the cards
  const canHide = plan.todo || plan.run !== null;
  const hideButton = canHide ? <button type="button" className="tvHide" onClick={() => hide(true)} data-testid="tv-hide">Hide</button> : null;
  const endedShown = plan.run === 'ended' && plan.ended !== null;
  const hideInTodo = canHide && !endedShown && plan.run !== 'live' && view.todo !== null && view.todo.items.length > 0 && todoProgress(view.todo.items).allDone;
  const hideAlone = canHide && !endedShown && !hideInTodo;

  return (
    <div className="tv" data-testid="task-view" data-root={rootId}>
      {plan.folded !== null ? (
        hidden && !openInPanel ? (
          <button type="button" className="tvChip" onClick={() => hide(false)} data-testid="tv-chip" aria-label="Show what is going on in this thread">
            {chipWho !== null ? <span className="rcPulse" aria-hidden="true" /> : null}
            <span dir="auto">{chipWho ?? 'To do'}</span>
            {todoProgressText !== null ? <span className="rcChipNum"> · {todoProgressText}</span> : null}
          </button>
        ) : (
          <p className="tvChip tvChipStatic" data-testid="tv-chip">
            {chipWho !== null ? <span className="rcPulse" aria-hidden="true" /> : null}
            <span dir="auto">{chipWho ?? 'To do'}</span>
            {todoProgressText !== null ? <span className="rcChipNum"> · {todoProgressText}</span> : null}
            <span className="tvChipNote"> · open at the side</span>
          </p>
        )
      ) : null}
      {plan.todo || plan.run === 'live' ? (
        <div className="tvCards" data-testid="tv-cards">
          {plan.todo && view.todo !== null ? <TodoCompact todo={view.todo} trailing={hideInTodo ? hideButton : null} /> : null}
          {plan.run === 'live' && view.run !== null ? <RunCompact head={view.run} lines={view.lines} people={people} onOpen={open} more={plan.moreRuns} /> : null}
        </div>
      ) : null}
      {plan.run === 'ended' && plan.ended !== null ? <RunEndedLine head={plan.ended} onOpen={open} trailing={hideButton} /> : null}
      {hideAlone ? hideButton : null}
      {plan.questions.length > 0 ? <QuestionStrip questions={plan.questions} slug={teamSlug ?? ''} rootId={rootId} onDecided={decided} /> : null}
    </div>
  );
});
