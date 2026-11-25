import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BookmarkToggleIcon, FollowIcon, OpenChannelIcon, SidePanelIcon, SummariseIcon } from '../shell/icons';

/*
 * A thread's own controls (P34-06): one row of icon buttons in the thread's header, in the same style as the channel's header tools (`icon-btn`, a label
 * and a tooltip on each), never a mix of bordered text buttons. In the right panel they sit before the panel's Expand and Close; on the Threads page
 * the Overview toggle joins them.
 */

export type ThreadToolKey = 'follow' | 'open-channel' | 'overview' | 'summarise' | 'bookmark';

/** The order of the row, left to right; the bookmark is last, at the top right (P36-08). The panel's Expand and Close come after it. */
export const THREAD_TOOL_ORDER: readonly ThreadToolKey[] = ['follow', 'open-channel', 'overview', 'summarise', 'bookmark'];

/**
 * Which of the thread's tools are drawn. Follow needs the thread's state; Open channel needs a channel to open (a thread in a direct message has
 * none) and is left out where that channel is already on screen beside the panel; Overview is the side rail of the Threads page only; Summarise is for a member
 * in a channel or a direct message (P18-05); Bookmark needs a server with bookmarks (P36-08).
 */
export function threadTools(o: { variant: 'panel' | 'main'; canFollow: boolean; channelLink: boolean; channelInView: boolean; canBookmark?: boolean; canSummarise?: boolean }): ThreadToolKey[] {
  const out: ThreadToolKey[] = [];
  if (o.canFollow) out.push('follow');
  if (o.channelLink && !(o.variant === 'panel' && o.channelInView)) out.push('open-channel');
  if (o.variant === 'main') out.push('overview');
  if (o.canSummarise) out.push('summarise');
  if (o.canBookmark) out.push('bookmark');
  return out;
}

export const followTip = (followed: boolean): string =>
  followed ? 'Following: you are notified of replies. Press to stop.' : 'Follow: be notified of replies';

export function ThreadTools({ tools, followed, busy, onFollow, channelHref, channelName, railOpen, railId, onRail, extra, bookmarked = false, bookmarkBusy = false, onBookmark, onSummarise }: {
  tools: readonly ThreadToolKey[];
  followed: boolean;
  busy: boolean;
  onFollow: () => void;
  channelHref: string | null;
  channelName: string;
  railOpen: boolean;
  railId: string;
  onRail: () => void;
  /** Drawn before the icon buttons (the voice autoplay switch). */
  extra?: ReactNode;
  /** The thread is in the person's bookmarks (P36-08): the icon is filled. */
  bookmarked?: boolean;
  /** A write of the bookmark is still on its way: the button waits. */
  bookmarkBusy?: boolean;
  onBookmark?: () => void;
  /** Opens Brain's private summary of the thread (P18-05). */
  onSummarise?: () => void;
}) {
  return (
    <>
      {extra}
      {tools.map((t) => {
        if (t === 'follow') {
          return (
            <button key={t} type="button" className="icon-btn thread-follow" aria-pressed={followed} aria-label="Follow thread" title={followTip(followed)} disabled={busy} onClick={onFollow} data-testid="thread-follow">
              <FollowIcon />
            </button>
          );
        }
        if (t === 'bookmark') {
          return (
            <button key={t} type="button" className="icon-btn thread-bookmark" aria-pressed={bookmarked} aria-label="Bookmark thread" title={bookmarked ? 'Bookmarked: find it under Bookmarks. Press to remove.' : 'Bookmark thread'} disabled={bookmarkBusy} onClick={onBookmark} data-testid="thread-bookmark">
              <BookmarkToggleIcon filled={bookmarked} />
            </button>
          );
        }
        if (t === 'summarise') {
          return (
            <button key={t} type="button" className="icon-btn thread-summarise" aria-label="Summarise thread" title="Summarise this thread: only you see it" onClick={onSummarise} data-testid="thread-summarise">
              <SummariseIcon />
            </button>
          );
        }
        if (t === 'open-channel') {
          return channelHref ? (
            <Link key={t} className="icon-btn" to={channelHref} aria-label="Open channel" title={`Open in #${channelName}`} data-testid="thread-open-channel">
              <OpenChannelIcon />
            </Link>
          ) : null;
        }
        return (
          <button key={t} type="button" className="icon-btn" aria-expanded={railOpen} aria-controls={railId} aria-label={railOpen ? 'Hide overview' : 'Show overview'} title={railOpen ? 'Hide overview' : 'Overview'} data-testid="rail-toggle" onClick={onRail}>
            <SidePanelIcon />
          </button>
        );
      })}
    </>
  );
}
