import { usePeople } from '../channels/hooks';
import { Avatar } from './ui';

/**
 * The picture of whoever wrote something (a notification, a search hit), found by their actor id in the shell's roster of people and bots.
 * A person gets their photo or initials; a bot keeps the bot shape; someone the roster does not know gets the initials of the name given.
 */
export function ActorAvatar({ actorId, name }: { actorId: string; name: string }) {
  const people = usePeople();
  const person = people.byActor(actorId);
  if (person) return <Avatar name={person.name} avatar={person.avatar} personId={person.personId} />;
  const bot = people.botAvatar(actorId);
  // the bot map answers undefined for an actor that is not a bot of this team (a null picture is still a bot)
  if (bot !== undefined) return <Avatar name={name || 'Bot'} kind="agent" avatar={bot} />;
  return <Avatar name={name || '?'} />;
}
