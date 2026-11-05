import { useRef, useState } from 'react';
import { fetchChannelMembers } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Avatar } from '../components/ui';
import { useDismiss } from './useDismiss';

/** Who is in the channel, one row each. */
export function MembersList({ channelId }: { channelId: string }) {
  const q = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  if (q.status !== 'ok') return <p className="chd-note">{q.status === 'error' ? 'Could not load the members.' : 'Loading…'}</p>;
  return (
    <ul className="chd-members" data-testid="details-member-list">
      {q.data.members.map((m) => (
        <li key={m.personId}><Avatar name={m.displayName} personId={m.personId} /> <span>{m.displayName}</span></li>
      ))}
    </ul>
  );
}

/** Up to three avatars and the count in the channel header (P21-06); the button names the count ("Members (6)") and opens the list. */
export function MembersStack({ channelId }: { channelId: string }) {
  const q = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  if (q.status !== 'ok') return null;
  const list = q.data.members;
  if (list.length === 0) return null; // nobody to show: no lone "0"
  return (
    <div className="chd" ref={box}>
      <button type="button" className="chd-stack" aria-label={`Members (${list.length})`} aria-haspopup="menu" aria-expanded={open} data-testid="members-stack" data-count={list.length} onClick={() => setOpen((o) => !o)}>
        {list.slice(0, 3).map((m) => <Avatar key={m.personId} name={m.displayName} personId={m.personId} />)}
        <span className="chd-count" aria-hidden="true">{list.length}</span>
      </button>
      {open ? <div className="chd-menu chd-menu-end" role="menu" aria-label="Members"><MembersList channelId={channelId} /></div> : null}
    </div>
  );
}
