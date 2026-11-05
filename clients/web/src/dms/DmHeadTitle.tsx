import { usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { usePresenceCard, useCanShowPresence, useNow } from '../presence/hooks';
import { statusNow, statusText } from '../presence/format';
import { localTimeThere } from '../presence/profileModel';

/** The other person's face in a direct message header, with the presence dot on its corner. */
export function DmLead({ personId, name }: { personId: string; name: string }) {
  const known = usePeople().byPerson(personId);
  return <Avatar name={name} avatar={known?.avatar} personId={personId} presencePersonId={personId} />;
}

/** Beside the name: the person's status in words and the time where they are ("7:32 pm there"); nothing for what they did not share. */
export function DmTrail({ personId }: { personId: string }) {
  const show = useCanShowPresence(personId);
  const card = usePresenceCard(personId);
  const now = useNow(30_000);
  if (!show || !card) return null;
  const status = statusNow(card, now);
  const time = localTimeThere(now, card.timeZone);
  if (!status && !time) return null;
  return (
    <span className="dmh-trail" data-testid="dm-header-meta">
      {status ? <span className="dmh-status" data-testid="dm-header-status" title={statusText(status)}>{statusText(status)}</span> : null}
      {time ? <span className="dmh-time" data-testid="dm-header-time" data-vt-mask>{time}</span> : null}
    </span>
  );
}
