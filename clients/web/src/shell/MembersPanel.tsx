import { useMemo, useState, type ReactNode } from 'react';
import { addChannelMember, fetchChannel, fetchChannelMembers, fetchRoster } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { usePanel, type PanelEntry } from '../kernel/panel';
import { usePanelTitle } from '../kernel/panel/sub';
import { useShell } from './context';
import { NO_ADD_NOTE, addedLine, canAddMembers, notifyMembersChanged, splitMembers, type PanelPerson } from './membersModel';

/** Why an Add failed, in the person's words. */
const addFailure = (name: string): string => `Could not add ${name}. Try again.`;

/**
 * The right panel's "Members of #channel" (P33-02): the people in the channel, and the team's people who are not, each list filtered by one box. A reader who
 * may manage the channel (a team lead or a workspace admin) gets an Add button on every person who is not in it; the row moves to the first list at once.
 */
export function MembersPanel({ entry }: { entry: PanelEntry }) {
  const channelId = entry.id;
  const { team, guest } = useShell();
  const slug = team?.slug ?? '';
  const panel = usePanel();
  const people = usePeople();
  const info = useQuery(`channel:${channelId}`, () => fetchChannel(channelId));
  const members = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  // a guest is not on the team: the roster is not theirs to read, and the panel shows the channel's own list only
  const roster = useQuery(`members-roster:${slug}`, () => (slug && !guest ? fetchRoster(slug) : Promise.resolve({ members: [] })));
  const [filter, setFilter] = useState('');
  const [added, setAdded] = useState<PanelPerson[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const channelName = info.status === 'ok' ? info.data.channel.name.replace(/^#/, '') : '';
  usePanelTitle(channelName ? `Members of #${channelName}` : 'Members');

  const rosterList = useMemo<PanelPerson[]>(() => (roster.status === 'ok' ? roster.data.members.map((m) => ({ personId: m.personId, displayName: m.displayName, avatar: m.avatar })) : []), [roster]);
  const memberList = useMemo<PanelPerson[]>(() => (members.status === 'ok' ? members.data.members.map((m) => ({ personId: m.personId, displayName: m.displayName })) : []), [members]);
  const self = people.me?.personId ?? null;
  const { inChannel, others } = useMemo(() => splitMembers(memberList, rosterList, filter, self, added), [memberList, rosterList, filter, self, added]);
  const canAdd = info.status === 'ok' && canAddMembers({ canManage: info.data.canManage, guest, archived: info.data.channel.archivedAt !== null });
  const showOthers = !guest && roster.status === 'ok';

  const add = async (p: PanelPerson): Promise<void> => {
    setAdding(p.personId);
    setProblem(null);
    try {
      await addChannelMember(channelId, p.personId);
      setAdded((a) => [...a, p]);
      setSaid(addedLine(p.displayName, channelName));
      notifyMembersChanged(channelId);
    } catch {
      setProblem(addFailure(p.displayName));
    } finally {
      setAdding(null);
    }
  };

  if (members.status === 'error' || info.status === 'error') {
    return (
      <div className="panel-empty" role="alert">
        <p className="panel-empty-title">Could not load the members.</p>
        <p className="panel-empty-body">Close the panel and open it again to try once more.</p>
      </div>
    );
  }
  if (members.status === 'loading' || info.status === 'loading') return <div className="mpn" aria-busy="true"><p className="chd-note">Loading…</p></div>;

  const row = (p: PanelPerson, inside: boolean): ReactNode => (
    <li key={p.personId} className="mpn-row" data-testid="member-row" data-person-id={p.personId}>
      <button type="button" className="mpn-who" onClick={() => panel.push({ type: 'member', id: p.personId })}>
        <Avatar name={p.displayName} avatar={p.avatar} personId={p.personId} />
        <span className="mpn-name">{p.displayName}</span>
        {p.personId === self ? <span className="mpn-you">(you)</span> : null}
      </button>
      {!inside && canAdd ? (
        <button type="button" className="btn s mpn-add" data-testid="member-add" aria-label={`Add ${p.displayName} to #${channelName}`} disabled={adding !== null} onClick={() => void add(p)}>
          {adding === p.personId ? 'Adding…' : 'Add'}
        </button>
      ) : null}
    </li>
  );

  return (
    <div className="mpn" data-testid="members-panel">
      <input
        type="search"
        className="mpn-filter"
        placeholder="Filter by name"
        aria-label="Filter members by name"
        data-testid="members-filter"
        value={filter}
        maxLength={80}
        onChange={(e) => setFilter(e.target.value)}
      />
      <p className="sr-only" role="status" data-testid="members-said">{said}</p>
      {problem ? <p className="chn-error" role="alert">{problem}</p> : null}
      <section aria-labelledby="mpn-in">
        <h3 className="mpn-head" id="mpn-in" data-testid="members-in-head">{`In this channel (${inChannel.length})`}</h3>
        {inChannel.length > 0 ? <ul className="mpn-list" data-testid="members-in">{inChannel.map((p) => row(p, true))}</ul> : <p className="chd-note">{filter.trim() ? 'No one here matches.' : 'No one yet.'}</p>}
      </section>
      {showOthers ? (
        <section aria-labelledby="mpn-out">
          <h3 className="mpn-head" id="mpn-out" data-testid="members-out-head">{`Not in this channel (${others.length})`}</h3>
          {!canAdd && others.length > 0 ? <p className="chd-note" data-testid="members-no-add">{NO_ADD_NOTE}</p> : null}
          {others.length > 0 ? <ul className="mpn-list" data-testid="members-out">{others.map((p) => row(p, false))}</ul> : <p className="chd-note">{filter.trim() ? 'No one here matches.' : 'Everyone on the team is in this channel.'}</p>}
        </section>
      ) : null}
    </div>
  );
}
