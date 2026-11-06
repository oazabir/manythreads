import type { Approval } from '@manythreads/shared';
import { usePeople } from '../../channels/hooks';
import { Avatar } from '../../components/ui';

/**
 * The picture of whoever asked: the person's own picture or initials, or — when a bot raised the request for itself — the bot's picture with the
 * bot mark. A name the roster does not know (someone who left, a guest) keeps initials only.
 */
export function AskerAvatar({ approval }: { approval: Pick<Approval, 'requesterId' | 'requesterName' | 'botSlug' | 'botName'> }) {
  const people = usePeople();
  const person = people.byActor(approval.requesterId);
  if (person) return <Avatar name={person.name} avatar={person.avatar} personId={person.personId} />;
  const botPicture = people.botAvatar(approval.requesterId) ?? (approval.botSlug ? people.botAvatarBySlug(approval.botSlug) : undefined);
  const isBot = botPicture !== undefined || approval.requesterName === approval.botName;
  if (isBot) return <Avatar name={approval.requesterName} kind="agent" avatar={botPicture ?? null} badge="bot" />;
  return <Avatar name={approval.requesterName} />;
}
