import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MessageAuthor, ThreadInboxItem } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { followThread, unfollowThread } from '../api/endpoints';
import { Avatar } from '../components/ui';
import { copyText, messageLinkPath, messageLinkUrl } from '../channels/messageActions';
import { ago } from '../channels/format';
import { usePeople } from '../channels/hooks';
import { laterErrorText } from '../later/RemindMenu';
import { toggleThreadBookmark } from '../bookmarks/actions';
import { bookmarksStore, useBookmarkPending, useBookmarked, useBookmarksReady } from '../bookmarks/store';
import { useDismiss } from '../shell/useDismiss';
import { BellIcon, BellOffIcon, CopyLinkIcon, HashIcon, MarkReadIcon, MoreIcon, NewWindowIcon, BookmarkToggleIcon } from '../shell/icons';
import { channelLabel, followEntry, markerLabel, repliesLine, withHandles } from './threadCard';
import { Hl, NeedsChip, ProgressLine, ReplyBlocks } from '../inbox/RowParts';
import { NO_WORK, type RowWork } from '../inbox/work';
import { NOT_NEEDED, progressOf, type NeedsYou } from '../inbox/rules';

/*
 * One row of the Threads list: who started the thread, where it lives, when it last moved, the first message, who is in it and how many
 * replies are new. A dot says there are unread replies; a number in a disc says that many of them name the reader. The kebab (visible on hover,
 * on focus and while its menu is open) opens the Actions menu. The whole card opens the thread; the kebab is a sibling of that button, never
 * inside it.
 */

const MENU_WIDTH = 252;

type Props = {
  item: ThreadInboxItem;
  teamSlug: string;
  selected: boolean;
  onOpen: (rootId: string) => void;
  /** Mark the whole thread read (the inbox knows how to find the newest reply). */
  onMarkRead: (rootId: string) => Promise<void>;
  /** The row's follow state changed: the list is fetched again. */
  onChanged: () => void;
  /** Open the thread's channel at the thread (a link, so the router decides how). */
  onOpenInChannel: (path: string) => void;
  /** The words of the filter box, folded: marked where they match. */
  words?: readonly string[];
  /** What goes on in the thread (to-do list, run, questions): the row's one line of progress. */
  work?: RowWork;
  /** Whether the row waits on the person, and why. */
  needs?: NeedsYou;
};

const NO_WORDS: readonly string[] = [];

function Who({ author, size }: { author: Pick<MessageAuthor, 'actorId' | 'displayName' | 'kind'>; size?: 'stack' }) {
  const people = usePeople();
  const person = author.kind === 'person' ? people.byActor(author.actorId) : undefined;
  const name = person?.name ?? author.displayName;
  const avatar = person ? <Avatar name={name} avatar={person.avatar} personId={person.personId} /> : <Avatar name={name} kind={author.kind === 'person' ? 'person' : 'agent'} avatar={author.kind === 'bot' ? people.botAvatar(author.actorId) : null} />;
  return size === 'stack' ? <span className="thc-face" title={name}>{avatar}</span> : <>{avatar}</>;
}

export const ThreadCard = memo(function ThreadCard({ item, teamSlug, selected, onOpen, onMarkRead, onChanged, onOpenInChannel, words = NO_WORDS, work = NO_WORK, needs = NOT_NEEDED }: Props) {
  const people = usePeople();
  const bookmarksReady = useBookmarksReady();
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const kebab = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, () => setMenu(null), wrap);

  const unread = item.unreadCount > 0;
  const label = markerLabel(item);
  const rootName = (item.rootAuthor && people.byActor(item.rootAuthor.actorId)?.name) ?? item.rootAuthor?.displayName ?? 'Someone';
  // the thread's bookmark (P36-08; this item used to save the first message to Later)
  const bookmarked = useBookmarked('thread', item.rootMessageId);
  const bookmarkBusy = useBookmarkPending('thread', item.rootMessageId);
  const follow = followEntry(item.followed);
  const progress = progressOf(work.todo, work.run ? { botName: work.run.botName, head: work.run.head } : null);
  const extra = item.participantCount - item.participants.length;

  useEffect(() => {
    if (note === null) return;
    const t = setTimeout(() => setNote(null), 2_500);
    return () => clearTimeout(t);
  }, [note]);

  // the menu is placed from the kebab's position on the screen (the list scrolls, so a menu inside it would be cut off at the list's end)
  const openMenu = (): void => {
    const r = kebab.current?.getBoundingClientRect();
    if (!r) return;
    void bookmarksStore.load();
    setMenu({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };
  useLayoutEffect(() => {
    if (menu === null) return;
    const el = box.current;
    const r = kebab.current?.getBoundingClientRect();
    if (!el || !r) return;
    // opens upward when it would reach past the bottom of the window and there is more room above
    if (menu.top + el.offsetHeight > window.innerHeight - 8 && r.top > window.innerHeight - r.bottom) setMenu({ top: Math.max(8, r.top - el.offsetHeight - 4), right: menu.right });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured once per opening
  }, [menu === null]);
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    window.addEventListener('resize', close);
    // a scroll of the list moves the card away from the menu
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const run = async (done: string, fn: () => Promise<unknown>): Promise<void> => {
    setMenu(null);
    kebab.current?.focus();
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setNote(isApiError(e) ? laterErrorText(e) : e instanceof Error ? e.message : 'Could not do that. Try again.');
    }
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const ref = { channelId: item.channel.id, messageId: item.rootMessageId, threadRootId: null };
  const style: CSSProperties | undefined = menu ? { top: menu.top, right: menu.right, width: MENU_WIDTH } : undefined;

  return (
    <li role="option" aria-selected={selected} data-root-id={item.rootMessageId} data-testid="thread-row" className={`thc ${unread ? 'unread' : ''} ${selected ? 'on' : ''} ${menu ? 'menu-open' : ''}`}>
      <button type="button" className="thc-open" onClick={() => onOpen(item.rootMessageId)}>
        <span className="thc-gutter">
          {item.mentionCount > 0 ? (
            <span className="thc-tag" data-testid="thread-tags" data-vt-mask>{item.mentionCount}</span>
          ) : unread ? (
            <span className="thc-dot" data-testid="thread-dot" />
          ) : null}
          {label ? <span className="sr-only">{label}</span> : null}
        </span>
        <span className="thc-main">
          <span className="thc-head">
            <b className="thc-who" data-vt-mask>{rootName}</b>
            <span className="thc-place" title={channelLabel(item.channel)}><Hl text={channelLabel(item.channel)} words={words} /></span>
            <NeedsChip needs={needs} />
            <time className="thc-time" dateTime={item.lastReplyAt} data-vt-mask>{ago(item.lastReplyAt)}</time>
          </span>
          <span className="thc-text" data-vt-mask>{withHandles(item.title).map((p, i) => (p.handle ? <span key={i} className="thc-handle">{p.text}</span> : <Hl key={i} text={p.text} words={words} />))}</span>
          {progress ? <ProgressLine progress={progress} /> : null}
          <span className="thc-foot">
            {item.participants.length > 0 ? (
              <span className="thc-faces">
                {item.participants.map((a) => <Who key={a.actorId} author={a} size="stack" />)}
                {extra > 0 ? <span className="thc-more" data-vt-mask>{`+${extra}`}</span> : null}
              </span>
            ) : null}
            <span className={`thc-replies ${unread ? 'new' : ''}`} data-testid="thread-replies" data-vt-mask>{repliesLine(item)}</span>
            {note ? <span className="thc-note" role="status">{note}</span> : null}
          </span>
          <ReplyBlocks item={item} words={words} />
        </span>
      </button>
      <div className="thc-actions" ref={wrap}>
        <button ref={kebab} type="button" className="thc-kebab" aria-label="Actions" title="Actions" aria-haspopup="menu" aria-expanded={menu !== null} data-testid="thread-actions" onClick={() => (menu ? setMenu(null) : openMenu())}>
          <MoreIcon />
        </button>
        {menu ? (
          <div ref={box} className="thc-menu" role="menu" aria-label="Thread actions" style={style} onKeyDown={onMenuKey}>
            <button type="button" role="menuitem" className="thc-item" data-testid="thread-action-window" onClick={() => { setMenu(null); window.open(`/t/${teamSlug}/threads?thread=${item.rootMessageId}`, '_blank', 'noopener'); }}>
              <NewWindowIcon /><span>Open in new window</span>
            </button>
            <button type="button" role="menuitem" className="thc-item" data-testid="thread-action-follow" onClick={() => void run(item.followed ? 'Unfollowed' : 'Following', async () => { await (item.followed ? unfollowThread(item.rootMessageId) : followThread(item.rootMessageId)); onChanged(); })}>
              {item.followed ? <BellOffIcon size={14} /> : <BellIcon size={14} />}
              <span>{follow.label}<small>{follow.hint}</small></span>
            </button>
            <button type="button" role="menuitem" className="thc-item" data-testid="thread-action-channel" onClick={() => { setMenu(null); onOpenInChannel(messageLinkPath(ref)); }}>
              <HashIcon /><span>Open in channel</span>
            </button>
            {unread ? (
              <button type="button" role="menuitem" className="thc-item" data-testid="thread-action-read" onClick={() => void run('Marked as read', () => onMarkRead(item.rootMessageId))}>
                <MarkReadIcon /><span>Mark as read</span>
              </button>
            ) : null}
            {bookmarksReady ? (
              <button
                type="button"
                role="menuitem"
                className="thc-item"
                data-testid="thread-action-bookmark"
                disabled={bookmarkBusy}
                onClick={() => {
                  setMenu(null);
                  kebab.current?.focus();
                  void toggleThreadBookmark(item.rootMessageId);
                }}
              >
                <BookmarkToggleIcon filled={bookmarked} size={14} /><span>{bookmarked ? 'Remove bookmark' : 'Bookmark thread'}</span>
              </button>
            ) : null}
            <button type="button" role="menuitem" className="thc-item" data-testid="thread-action-link" onClick={() => void run('Link copied', async () => { if (!(await copyText(messageLinkUrl(window.location.origin, ref)))) throw new Error('Could not copy the link'); })}>
              <CopyLinkIcon /><span>Copy link</span>
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
});
