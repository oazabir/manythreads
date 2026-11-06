import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useMatch, useNavigate } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { useSession } from '../app/session';
import { useUnread, usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { levelsStore } from '../notifications/levelsStore';
import { dmLabel, openConversation, useDms } from '../dms/store';
import { navHref } from './nav';
import { AddIcon } from './icons';
import { useDismiss } from './useDismiss';
import { unreadLook } from './unreadLook';
import { FoldButton } from './FoldButton';
import { RowMenu } from './RowMenu';
import { Pill } from './Pill';
import { useFold } from './sectionFold';
import { PresenceDot } from '../presence/PresenceDot';
import { LiveBadge } from '../meetings/LiveBadge';

const dmPath = (slug: string, channelId: string): string => `/t/${slug}/dm/${channelId}`;

/** The "+ New" picker: choose one or more people on the team, and open the conversation with them (one row per set of people). */
function NewConversation({ slug, onDone }: { slug: string; onDone: () => void }) {
  const session = useSession();
  const people = usePeople();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(
    () => people.list.filter((p) => p.personId !== session.person.id && p.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [people.list, session.person.id, filter],
  );
  const toggle = (id: string): void =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const start = async (): Promise<void> => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const dm = await openConversation([...picked]);
      onDone();
      navigate(dmPath(slug, dm.channel.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the conversation.');
      setBusy(false);
    }
  };
  return (
    <div className="menu menu-wide dm-picker" role="dialog" aria-label="New message">
      <input className="dm-filter" type="search" placeholder="Find a person" aria-label="Find a person" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      <ul className="dm-people" aria-label="People">
        {candidates.map((p) => (
          <li key={p.personId}>
            <label className="dm-person">
              <input type="checkbox" checked={picked.has(p.personId)} onChange={() => toggle(p.personId)} />
              <Avatar name={p.name} avatar={p.avatar} personId={p.personId} />
              <span>{p.name}</span>
              <PresenceDot personId={p.personId} />
            </label>
          </li>
        ))}
        {candidates.length === 0 ? <li className="menu-note">{people.loaded ? 'Nobody to message.' : 'Loading…'}</li> : null}
      </ul>
      {error ? <p className="menu-note dm-error" role="alert">{error}</p> : null}
      <div className="dm-actions">
        <button type="button" className="btn primary s" disabled={picked.size === 0 || busy} onClick={() => void start()}>
          {picked.size > 1 ? 'Start conversation' : 'Message'}
        </button>
      </div>
    </div>
  );
}

/** The "Direct messages" section of the sidebar contract: the heading, one row per conversation (unread count), "+ New". */
export function DirectMessages({ item, slug }: { item: NavContribution; slug: string }) {
  const session = useSession();
  const feed = useDms();
  const { unread } = useUnread();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  useEffect(() => {
    void levelsStore.load();
  }, []);
  const activeId = useMatch('/t/:team/dm/:id')?.params.id ?? null;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const [folded, toggleFolded] = useFold(session.person.id, slug, 'dm');
  const href = navHref(item, slug);
  const heading = href ? <Link className="sec sec-link" to={href}>{item.label}</Link> : <div className="sec"><span>{item.label}</span></div>;
  return (
    <>
      <div className="sec-row">
        <FoldButton folded={folded} label={item.label} onToggle={toggleFolded} />
        {heading}
      </div>
      <div className="dm-list" data-slot="direct-messages">
      {feed.items.filter((d) => !folded || (unread[d.channel.id] ?? d.unreadCount) > 0 || d.channel.id === activeId).map((d) => {
        const n = unread[d.channel.id] ?? d.unreadCount;
        const label = dmLabel(d, session.person.id);
        const look = unreadLook(n, levels, d.channel.id, 'dm');
        // a one-to-one conversation shows the other person's dot (participants are always people); a group or notes-to-self shows none
        const others = d.participants.filter((p) => p.personId !== session.person.id);
        const peer = others.length === 1 ? others[0] : undefined;
        return (
          <RowMenu key={d.channel.id} conv={{ id: d.channel.id, name: null, kind: 'dm', label }} slug={slug} testId="dm-row-menu">
            <NavLink to={dmPath(slug, d.channel.id)} className={({ isActive }) => `it ${isActive ? 'on' : ''} ${look.bold ? 'unread' : ''} ${look.muted ? 'muted' : ''}`} data-unread={n > 0 ? n : undefined}>
              <span className="h"><span className={`dot ${look.bold ? 'on' : ''}`} aria-hidden="true" /></span>
              <span className="it-label">{label}</span>
              {peer ? <PresenceDot personId={peer.personId} status /> : null}
              <LiveBadge channelId={d.channel.id} dm />
              {look.badge ? <Pill n={n} tone={look.badge} /> : null}
            </NavLink>
          </RowMenu>
        );
      })}
      </div>
      {feed.status === 'ok' && feed.items.length === 0 ? <p className="side-note dm-empty">{item.emptyState ?? 'No conversations yet'}</p> : null}
      <div className="dm-new" ref={box}>
        <button type="button" className="it dm-new-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="h" aria-hidden="true"><AddIcon size={14} /></span>
          <span className="it-label">New message</span>
        </button>
        {open ? <NewConversation slug={slug} onDone={() => setOpen(false)} /> : null}
      </div>
    </>
  );
}
