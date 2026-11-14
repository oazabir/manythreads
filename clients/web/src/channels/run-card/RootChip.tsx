import { useThreadTodo } from '../../todo/useThreadTodo';
import { useWorkingOn } from './hooks';
import { progressText, todoProgress } from '../todo-card/words';

/**
 * "Coder is working · 3 of 5" under a thread root in the channel (PLAN P25-11): who is on it, and how far, without opening the thread. It shows only while a run is going
 * (the live pushes tell every reader of the channel); the "3 of 5" is the thread's to-do list, when it has one.
 */
function Chip({ rootId }: { rootId: string }) {
  const working = useWorkingOn(rootId);
  const { todo } = useThreadTodo(working.length > 0 ? rootId : null);
  if (working.length === 0) return null;
  const names = [...new Set(working.map((w) => w.botName))];
  const who = names.length === 1 ? names[0]! : `${names[0]} and ${names.length - 1} more`;
  const progress = todo !== null && todo.items.length > 0 ? progressText(todoProgress(todo.items)) : null;
  return (
    <p className="rcChip" data-testid="run-chip" role="status">
      <span className="rcPulse" aria-hidden="true" />
      <span>{who} {names.length === 1 ? 'is' : 'are'} working</span>
      {progress !== null ? <span className="rcChipNum"> · {progress}</span> : null}
    </p>
  );
}

/** Drawn for a root that has replies (a run answers in a thread); a root with none cannot have a run yet. */
export function RootChip({ rootId }: { rootId: string }) {
  return <Chip rootId={rootId} />;
}
