import { useThreadTodo } from '../../todo/useThreadTodo';
import type { People } from '../hooks';
import { Markdown } from '../MessageMarkdown';
import { TodoCard } from './TodoCard';

/**
 * The message that carries a thread's to-do list (`meta.todoRef`): the list as a card, in place of its text. Until the list is read, or when this reader may not read it, the
 * message's own words are shown (the bot writes a one-line text with it), so a message is never an empty box.
 * A list can pass to another bot, which posts its own card: only the message the list names now (`todo.messageId`) draws the live card; an earlier one is a quiet line that
 * says where the list went, so a thread never shows the same list twice.
 */
export function TodoMessage({ rootId, messageId, body, teamSlug, people }: { rootId: string; messageId: string; body: string; teamSlug: string | null; people: People }) {
  const { todo } = useThreadTodo(rootId);
  if (todo === null) return <div className="txt"><Markdown source={body} teamSlug={teamSlug} /></div>;
  if (todo.messageId !== null && todo.messageId !== messageId) {
    const owner = people.botName?.(todo.botActorId) ?? people.byActor(todo.botActorId)?.name;
    return (
      <p className="tdMoved" data-testid="todo-moved">
        Earlier to-do list · {owner !== undefined ? <>moved to <bdi>{owner}</bdi>’s list below</> : 'moved to the list below'}
      </p>
    );
  }
  return <TodoCard todo={todo} slug={teamSlug} people={people} rootId={rootId} />;
}
