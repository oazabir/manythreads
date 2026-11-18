import { useEffect } from 'react';
import { fetchChannelMembers } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Avatar } from '../components/ui';
import { usePanel } from '../kernel/panel';
import { MembersIcon } from './icons';
import { MEMBERS_PANEL, onMembersChanged } from './membersModel';

/** Who is in the channel, one row each (the channel details menu's Members view). */
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

/**
 * One people icon with the channel's head count in the channel header (P33-01). It opens the Members panel on the right (P33-02) and closes it again when
 * pressed a second time; the button names the count ("Members (6)").
 */
export function MembersButton({ channelId }: { channelId: string }) {
  const q = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  const panel = usePanel();
  const reload = q.reload;
  // someone was added in the panel: the count follows at once
  useEffect(() => onMembersChanged((id) => id === channelId && reload()), [channelId, reload]);
  if (q.status !== 'ok') return null;
  const count = q.data.members.length;
  const top = panel.top();
  const open = top?.type === MEMBERS_PANEL && top.id === channelId;
  return (
    <button
      type="button"
      className="icon-btn chv-tool chv-members"
      aria-label={`Members (${count})`}
      title="Members"
      aria-pressed={open}
      data-testid="members-open"
      data-count={count}
      onClick={() => (open ? panel.close() : panel.push({ type: MEMBERS_PANEL, id: channelId }))}
    >
      <MembersIcon />
      {count > 0 ? <span className="chv-count" aria-hidden="true">{count}</span> : null}
    </button>
  );
}
