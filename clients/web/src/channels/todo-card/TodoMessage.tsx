import { useThreadTodo } from '../../todo/useThreadTodo';
import type { People } from '../hooks';
import { Markdown } from '../MessageMarkdown';
import { TodoCard } from './TodoCard';

/**
 * The message that carries a thread's to-do list (`meta.todoRef`): the list as a card, in place of its text. Until the list is read, or when this reader may not read it, the
 * message's own words are shown (the bot writes a one-line text with it), so a message is never an empty box.
 */
export function TodoMessage({ rootId, body, teamSlug, people, botName }: { rootId: string; body: string; teamSlug: string | null; people: People; botName: string }) {
  const { todo } = useThreadTodo(rootId);
  if (todo === null) return <div className="txt"><Markdown source={body} teamSlug={teamSlug} /></div>;
  return <TodoCard todo={todo} slug={teamSlug} people={people} botName={botName} />;
}
