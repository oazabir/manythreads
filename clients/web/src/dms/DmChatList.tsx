import { useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink } from 'react-router';
import { useSession } from '../app/session';
import { channelStore } from '../channels/store';
import { usePeople, useUnread } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { LiveBadge } from '../meetings/LiveBadge';
import { levelsStore } from '../notifications/levelsStore';
import { Pill } from '../shell/Pill';
import { RowMenu } from '../shell/RowMenu';
import { unreadLook } from '../shell/unreadLook';
import { dmListRow } from './listRow';
import { dmLabel, useDms } from './store';

/** A minute's tick, so "14:05" turns into "Yesterday" while the page stays open. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The Messages page's list (P34-05): one row per conversation as a chat app draws it, the face, the name and the time of the last message on the first line,
 * the last line and the unread count under them. Newest first; the last line and the count change as messages arrive (`dms/store.ts`, `listRow.ts`). Each row
 * keeps the sidebar's row menu (Mute, Mark read).
 */
export function DmChatList({ slug }: { slug: string }) {
  const session = useSession();
  const people = usePeople();
  const feed = useDms();
  const { unread } = useUnread();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  useEffect(() => {
    void levelsStore.load();
  }, []);
  const now = useMinute();
  const selfActor = people.me?.actorId ?? channelStore.selfActor;
  const nameOf = (actorId: string): string | null => people.byActor(actorId)?.name ?? null;
  if (feed.items.length === 0) return null;
  return (
    <ul className="dmc" aria-label="Conversations" data-testid="dm-chat-list">
      {feed.items.map((d) => {
        const label = dmLabel(d, session.person.id);
        const row = dmListRow(d, { label, selfPersonId: session.person.id, selfActor, unread: unread[d.channel.id], nameOf, now });
        const look = unreadLook(row.unread, levels, d.channel.id, 'dm');
        const peer = row.peerId ? people.byPerson(row.peerId) : undefined;
        return (
          <li key={d.channel.id}>
            <RowMenu conv={{ id: d.channel.id, name: null, kind: 'dm', label }} slug={slug} testId="dm-row-menu">
              <NavLink
                to={`/t/${slug}/dm/${d.channel.id}`}
                className={`dmc-row ${look.bold ? 'unread' : ''} ${look.muted ? 'muted' : ''}`}
                data-testid="dm-chat-row"
                data-unread={row.unread > 0 ? row.unread : undefined}
              >
                <span className="dmc-face"><Avatar name={label} avatar={peer?.avatar ?? null} personId={row.peerId} kind={row.kind === 'reminders' ? 'automation' : 'person'} /></span>
                <span className="dmc-main">
                  <span className="dmc-top">
                    <span className="dmc-name">{label}</span>
                    <LiveBadge channelId={d.channel.id} dm />
                    {row.time ? <time className="dmc-time" dateTime={d.lastMessage?.createdAt} title={row.timeTitle ?? undefined} data-vt-mask>{row.time}</time> : null}
                  </span>
                  <span className="dmc-bottom">
                    <span className="dmc-line" data-testid="dm-chat-line">{row.preview || 'Nothing said yet'}</span>
                    {look.badge ? <Pill n={row.unread} tone={look.badge} /> : null}
                  </span>
                </span>
              </NavLink>
            </RowMenu>
          </li>
        );
      })}
    </ul>
  );
}
