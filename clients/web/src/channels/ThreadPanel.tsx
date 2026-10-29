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
import { ThreadApprovals } from '../screens/approvals/ThreadApprovals';
import { FilesIcon, ThreadsIcon } from '../shell/icons';
import type { AnswerTools } from './AnswerShare';
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
export function ThreadBody({ rootId, variant, channelId: channelHint = null, awaiting = null, replyBlocked = null, answerTools }: {
  rootId: string;
  variant: 'panel' | 'main';
  /** The channel the thread lives in, when the caller knows it and the URL does not say (a bot conversation has no `/c/:channel`). */
  channelId?: string | null;
  /** The name of whoever is expected to answer: while the newest message is the reader's own and is recent, the thread says it is on it. */
  awaiting?: string | null;
  /** Why nobody can reply here right now (a bot that is turned off): shown in place of the composer, which is not drawn. */
  replyBlocked?: string | null;
  /** The reader's own conversation with a bot (P5-17): an Answer in it that was for them can be shared, saved as a page and handed on. */
  answerTools?: AnswerTools;
}) {
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug;
  const people = usePeople();
  const tl = useTimeline(threadKey(rootId));
  const feed = useChannelFeed(slug);
  const inChannel = useMatch('/t/:team/c/:channel');
  const hint = channelHint ?? (inChannel?.params.channel ? (findChannel(feed.groups, inChannel.params.channel)?.id ?? null) : null);
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

  // leaving the thread: a "Mark unread from here" stops holding it unread
  useEffect(() => () => channelStore.releaseUnreadHold('thread', rootId), [rootId]);

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
            markUnread: async (id) => void (await channelStore.markUnread(channelId, id, rootId)),
          }
        : null,
    [channelId, rootId],
  );
  // "Also send to channel": for the next reply only, and not in a conversation with a bot (its replies are answers, not channel talk)
  const [also, setAlso] = useState(false);
  const send = useCallback(
    (body: string, attachments: FileSummary[]) => {
      if (!channelId) return;
      stuck.current = true;
      void channelStore.send(channelId, rootId, body, attachments, also);
      setAlso(false);
    },
    [channelId, rootId, also],
  );
  const channelKind = info.status === 'ok' && info.data ? info.data.channel.kind : null;
  const alsoLabel = channelKind === 'channel' ? `Also send to #${channelName}` : channelKind === 'dm' ? 'Also send to the conversation' : null;

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
  // Waiting for an answer: the newest message is the reader's own, it is recent, and nothing of theirs is still being sent.
  const newestMessage = tl.items.at(-1) ?? root;
  const waiting =
    awaiting !== null && self !== null && tl.pending.length === 0 && newestMessage.authorId === self && Date.now() - Date.parse(newestMessage.createdAt) < AWAIT_REPLY_MS;

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
          <MessageRow key={m.id} message={m} teamSlug={slug} people={people} selfActor={self} canPost={canReply} inThread actions={replyActions} {...(answerTools ? { answerTools } : {})} />
        ))}
        <ThreadApprovals rootId={rootId} slug={slug ?? null} />
        {waiting ? <p className="typing" aria-live="polite" data-testid="awaiting-reply">{awaiting} is working on it…</p> : null}
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
      {canReply && replyBlocked !== null ? (
        <p className="read-only" data-testid="reply-blocked">{replyBlocked}</p>
      ) : canReply ? (
        <div className="rpf">
          {alsoLabel && !answerTools ? (
            <label className="also-row">
              <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} data-testid="also-to-channel" />
              <span>{alsoLabel}</span>
            </label>
          ) : null}
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

/** How long after the reader's own message a thread says the bot is working on it: a run that has not answered by then has failed, and the thread says nothing. */
const AWAIT_REPLY_MS = 3 * 60_000;

const isThreadHidden = (status: number | undefined): boolean => status === 403 || status === 404 || status === 400;
