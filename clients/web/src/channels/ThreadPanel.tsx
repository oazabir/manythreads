import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch } from 'react-router';
import type { FileSummary } from '@manythreads/shared';
import { fetchChannel, fetchLinks, followThread, unfollowThread } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { channelPath } from '../shell/nav';
import { findChannel, useChannelFeed } from '../shell/channelFeed';
import { useShell } from '../shell/context';
import type { PanelEntry } from '../kernel/panel';
import { usePanelSub } from '../kernel/panel/sub';
import { FilesIcon, ThreadsIcon } from '../shell/icons';
import { Composer } from './Composer';
import { usePeople, useTimeline, useTyping } from './hooks';
import { MessageRow, PendingRow, type RowActions } from './MessageRow';
import { channelStore, threadKey } from './store';

/** The right-panel entry `thread:<root message id>`. */
export function ThreadPanel({ entry }: { entry: PanelEntry }) {
  return <ThreadBody key={entry.id} rootId={entry.id} variant="panel" />;
}

/** "Linked": what the thread's root is linked to (files attached to it, other threads), one query against the kernel's link table. */
function Linked({ rootId }: { rootId: string }) {
  const q = useQuery(`links:${rootId}`, () => fetchLinks('message', rootId));
  if (q.status !== 'ok' || q.data.links.length === 0) return null;
  return (
    <div className="linked" data-testid="thread-linked">
      <b>Linked</b>
      {q.data.links.map(({ other }) => {
        const body = (
          <>
            {other.type === 'file' ? <FilesIcon /> : <ThreadsIcon />}
            {other.title}
          </>
        );
        return other.href ? <Link key={`${other.type}:${other.id}`} className="lk" to={other.href}>{body}</Link> : <span key={`${other.type}:${other.id}`} className="lk">{body}</span>;
      })}
    </div>
  );
}

/**
 * A thread: the root message, whether the person follows it, the replies and a composer. In the right panel (beside the channel) and
 * in the main area of the Threads inbox. Opened from a link it needs no channel in view: the threads API says where the thread lives.
 */
export function ThreadBody({ rootId, variant }: { rootId: string; variant: 'panel' | 'main' }) {
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug;
  const people = usePeople();
  const tl = useTimeline(threadKey(rootId));
  const feed = useChannelFeed(slug);
  const inChannel = useMatch('/t/:team/c/:channel');
  const hint = inChannel?.params.channel ? (findChannel(feed.groups, inChannel.params.channel)?.id ?? null) : null;
  const names = useMemo(() => feed.groups.flatMap((g) => g.channels.map((c) => c.name.replace(/^#/, ''))), [feed.groups]);
  const typing = useTyping(threadKey(rootId));
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void channelStore.loadThread(rootId, hint);
  }, [rootId, hint]);

  const root = tl.root;
  const channelId = root?.channelId ?? tl.channel?.id ?? hint;
  const channelRow = channelId ? feed.groups.flatMap((g) => g.channels).find((c) => c.id === channelId) : undefined;
  const channelName = (tl.channel?.name ?? channelRow?.name ?? '').replace(/^#/, '');
  const self = people.me?.actorId ?? null;
  const info = useQuery(`thread-channel:${channelId ?? ''}`, () => (channelId ? fetchChannel(channelId) : Promise.resolve(null)));
  const canReply = info.status === 'ok' && info.data !== null && info.data.canPost && info.data.channel.archivedAt === null;
  const newestReply = tl.items.at(-1)?.id ?? null;
  usePanelSub(variant === 'panel' && channelName ? `# ${channelName}` : null);

  // Mark the replies read while the thread is open and on screen.
  const threadState = tl.thread;
  useEffect(() => {
    if (!threadState || !newestReply || document.visibilityState !== 'visible') return;
    if (threadState.lastReadId !== null && threadState.lastReadId >= newestReply) return;
    const t = setTimeout(() => void channelStore.markRead('thread', rootId, newestReply), 400);
    return () => clearTimeout(t);
  }, [threadState, newestReply, rootId]);

  // Stay at the newest reply while the reader is there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  });

  const rootActions = useMemo<RowActions | null>(
    () =>
      channelId
        ? {
            react: (id, emoji) => void channelStore.toggleReaction(channelId, null, id, emoji),
            edit: (id, body) => channelStore.edit(channelId, null, id, body),
            remove: (id) => channelStore.remove(channelId, null, id),
          }
        : null,
    [channelId],
  );
  const replyActions = useMemo<RowActions | null>(
    () =>
      channelId
        ? {
            react: (id, emoji) => void channelStore.toggleReaction(channelId, rootId, id, emoji),
            edit: (id, body) => channelStore.edit(channelId, rootId, id, body),
            remove: (id) => channelStore.remove(channelId, rootId, id),
          }
        : null,
    [channelId, rootId],
  );
  const send = useCallback(
    (body: string, attachments: FileSummary[]) => {
      if (!channelId) return;
      stuck.current = true;
      void channelStore.send(channelId, rootId, body, attachments);
    },
    [channelId, rootId],
  );

  if (tl.status === 'error' && !root) {
    return (
      <div className="panel-empty" role="alert" data-testid="thread-unavailable">
        <p className="panel-empty-title">This thread is not available.</p>
        <p className="panel-empty-body">{isThreadHidden(tl.error?.status) ? 'It may be in a channel you cannot see, or it was removed.' : (tl.error?.message ?? 'Try again in a moment.')}</p>
        {isThreadHidden(tl.error?.status) ? null : <button type="button" className="btn s" onClick={() => void channelStore.loadThread(rootId, hint)}>Try again</button>}
      </div>
    );
  }
  if (!root || !channelId || !rootActions || !replyActions) return <div className="loading" aria-busy="true">Loading…</div>;

  const toggleFollow = async (): Promise<void> => {
    if (!threadState || busy) return;
    setBusy(true);
    const next = !threadState.followed;
    channelStore.setFollowed(rootId, next);
    try {
      await (next ? followThread(rootId) : unfollowThread(rootId));
    } catch {
      channelStore.setFollowed(rootId, !next);
    } finally {
      setBusy(false);
    }
  };
  const followRow = threadState ? (
    <div className="follow">
      <button type="button" role="switch" aria-checked={threadState.followed} aria-label="Follow thread" className={`tog ${threadState.followed ? 'on' : ''}`} disabled={busy} onClick={() => void toggleFollow()} />
      <span data-testid="follow-state">{threadState.followed ? 'Following · you will be notified of replies' : 'Not following · follow to be notified of replies'}</span>
    </div>
  ) : null;
  const teamForLink = slug ?? '';

  return (
    <div className={`thread ${variant}`} data-testid="thread-view" data-root-id={rootId}>
      {variant === 'main' ? (
        <div className="chead thread-head">
          <h3 className="thread-title">{threadState?.title ?? root.bodyPlain.slice(0, 80)}</h3>
          {channelName ? <span className="topic"># {channelName}</span> : null}
          <div className="right">
            {threadState ? (
              <button type="button" className="btn s" aria-pressed={threadState.followed} disabled={busy} onClick={() => void toggleFollow()}>
                {threadState.followed ? 'Following ✓' : 'Follow'}
              </button>
            ) : null}
            {channelName && teamForLink ? <Link className="btn s" to={`${channelPath(teamForLink, channelName)}?message=${rootId}`}>Open channel</Link> : null}
          </div>
        </div>
      ) : null}
      <div
        className="rpb"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="root">
          <MessageRow message={root} teamSlug={slug} people={people} selfActor={self} canPost={canReply} inThread actions={rootActions} />
          {variant === 'panel' ? followRow : null}
          {variant === 'panel' ? <Linked rootId={rootId} /> : null}
        </div>
        {tl.cursor ? (
          <button type="button" className="btn s load-earlier" disabled={tl.loadingOlder} onClick={() => void channelStore.loadOlder(threadKey(rootId), channelId, rootId)}>
            {tl.loadingOlder ? 'Loading…' : 'Earlier replies'}
          </button>
        ) : null}
        {tl.items.length === 0 && tl.pending.length === 0 ? <p className="thread-empty">No replies yet. Start the conversation.</p> : null}
        {tl.items.map((m) => (
          <MessageRow key={m.id} message={m} teamSlug={slug} people={people} selfActor={self} canPost={canReply} inThread actions={replyActions} />
        ))}
        {tl.pending.map((p) => (
          <PendingRow
            key={p.localId}
            pending={p}
            name={people.me?.name ?? 'You'}
            onRetry={() => void channelStore.retry(channelId, rootId, p.localId)}
            onDiscard={() => channelStore.discard(channelId, rootId, p.localId)}
          />
        ))}
        {typing ? <p className="typing" aria-live="polite">{typing}</p> : null}
      </div>
      {info.status === 'ok' && !canReply ? <p className="read-only">You can read this thread but not reply.</p> : null}
      {canReply ? (
        <div className="rpf">
          <Composer
            draftKey={`thread:${rootId}`}
            placeholder={variant === 'main' ? 'Reply in thread…' : 'Reply…'}
            label="Reply in thread"
            channelId={channelId}
            threadRootId={rootId}
            people={people}
            channelNames={names}
            onSend={send}
            autoFocus={variant === 'panel'}
          />
        </div>
      ) : null}
    </div>
  );
}

const isThreadHidden = (status: number | undefined): boolean => status === 403 || status === 404 || status === 400;
