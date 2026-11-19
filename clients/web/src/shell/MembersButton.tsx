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
 * pressed a second time; the button names the count ("Members (6)"). While the count is loading the icon stands without it, and when the count could not be loaded
 * the icon still opens the panel (which says what went wrong). With one person's page open from the panel, pressing it goes back to the list instead of stacking another.
 */
export function MembersButton({ channelId }: { channelId: string }) {
  const q = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  const panel = usePanel();
  const reload = q.reload;
  // someone was added in the panel: the count follows at once
  useEffect(() => onMembersChanged((id) => id === channelId && reload()), [channelId, reload]);
  const count = q.status === 'ok' ? q.data.members.length : null;
  const entries = panel.entries;
  const top = entries.at(-1);
  const open = top?.type === MEMBERS_PANEL && top.id === channelId;
  const below = entries.at(-2);
  const onPerson = top?.type === 'member' && below?.type === MEMBERS_PANEL && below.id === channelId;
  const press = (): void => {
    if (open) panel.close();
    else if (onPerson) panel.back();
    else panel.push({ type: MEMBERS_PANEL, id: channelId });
  };
  return (
    <button
      type="button"
      className="icon-btn chv-tool chv-members"
      aria-label={count === null ? 'Members' : `Members (${count})`}
      title="Members"
      aria-pressed={open}
      data-testid="members-open"
      {...(count !== null ? { 'data-count': count } : {})}
      onClick={press}
    >
      <MembersIcon />
      {count !== null && count > 0 ? <span className="chv-count" aria-hidden="true">{count}</span> : null}
    </button>
  );
}
