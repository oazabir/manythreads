import { useMemo, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { useSession } from '../app/session';
import { useUnread, usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { dmLabel, openConversation, useDms } from '../dms/store';
import { navHref } from './nav';
import { useDismiss } from './useDismiss';

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
              <Avatar name={p.name} />
              <span>{p.name}</span>
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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const href = navHref(item, slug);
  const heading = href ? <Link className="sec sec-link" to={href}>{item.label}</Link> : <div className="sec"><span>{item.label}</span></div>;
  return (
    <>
      {heading}
      <div className="dm-list" data-slot="direct-messages">
      {feed.items.map((d) => {
        const n = unread[d.channel.id] ?? d.unreadCount;
        const label = dmLabel(d, session.person.id);
        return (
          <NavLink key={d.channel.id} to={dmPath(slug, d.channel.id)} className={({ isActive }) => `it ${isActive ? 'on' : ''} ${n > 0 ? 'unread' : ''}`}>
            <span className="h"><span className={`dot ${n > 0 ? 'on' : ''}`} aria-hidden="true" /></span>
            <span className="it-label">{label}</span>
            {n > 0 ? <span className="pill" data-vt-mask>{n}</span> : null}
          </NavLink>
        );
      })}
      </div>
      {feed.status === 'ok' && feed.items.length === 0 ? <p className="side-note dm-empty">{item.emptyState ?? 'No conversations yet'}</p> : null}
      <div className="dm-new" ref={box}>
        <button type="button" className="it dm-new-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="h" aria-hidden="true">+</span>
          <span className="it-label">New</span>
        </button>
        {open ? <NewConversation slug={slug} onDone={() => setOpen(false)} /> : null}
      </div>
    </>
  );
}
