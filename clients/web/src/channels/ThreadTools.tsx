import { Link } from 'react-router';
import { FollowIcon, OpenChannelIcon, SidePanelIcon } from '../shell/icons';

/*
 * A thread's own controls (P34-06): one row of icon buttons in the thread's header, in the same style as the channel's header tools (`icon-btn`, a label
 * and a tooltip on each), never a mix of bordered text buttons. In the right panel they sit before the panel's Expand and Close; on the Threads page
 * the Overview toggle joins them.
 */

export type ThreadToolKey = 'follow' | 'open-channel' | 'overview';

/** The order of the row, left to right. The panel's Expand and Close come after it. */
export const THREAD_TOOL_ORDER: readonly ThreadToolKey[] = ['follow', 'open-channel', 'overview'];

/**
 * Which of the thread's tools are drawn. Follow needs the thread's state; Open channel needs a channel to open (a thread in a direct message has
 * none) and is left out where that channel is already on screen beside the panel; Overview is the side rail of the Threads page only.
 */
export function threadTools(o: { variant: 'panel' | 'main'; canFollow: boolean; channelLink: boolean; channelInView: boolean }): ThreadToolKey[] {
  const out: ThreadToolKey[] = [];
  if (o.canFollow) out.push('follow');
  if (o.channelLink && !(o.variant === 'panel' && o.channelInView)) out.push('open-channel');
  if (o.variant === 'main') out.push('overview');
  return out;
}

export const followTip = (followed: boolean): string =>
  followed ? 'Following: you are notified of replies. Press to stop.' : 'Follow: be notified of replies';

export function ThreadTools({ tools, followed, busy, onFollow, channelHref, channelName, railOpen, railId, onRail }: {
  tools: readonly ThreadToolKey[];
  followed: boolean;
  busy: boolean;
  onFollow: () => void;
  channelHref: string | null;
  channelName: string;
  railOpen: boolean;
  railId: string;
  onRail: () => void;
}) {
  return (
    <>
      {tools.map((t) => {
        if (t === 'follow') {
          return (
            <button key={t} type="button" className="icon-btn thread-follow" aria-pressed={followed} aria-label="Follow thread" title={followTip(followed)} disabled={busy} onClick={onFollow} data-testid="thread-follow">
              <FollowIcon />
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
