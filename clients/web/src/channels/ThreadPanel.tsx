import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useMatch } from 'react-router';
import { fetchChannel, fetchLinks, followThread, unfollowThread } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { channelPath } from '../shell/nav';
import { findChannel, useChannelFeed } from '../shell/channelFeed';
import { useShell } from '../shell/context';
import type { PanelEntry } from '../kernel/panel';
import { usePanelSub, usePanelTools } from '../kernel/panel/sub';
import { ThreadApprovals, useThreadApprovals } from '../screens/approvals/ThreadApprovals';
import { ThreadDock } from '../taskview/ThreadDock';
import { ThreadRail } from '../taskview/ThreadRail';
import { attachmentKey, readRailOpen, writeRailOpen } from '../taskview/railRules';
import { runEnded } from './run-card/words';
import { useThreadRunHeads } from '../runs/useThreadRuns';
import { useThreadTodo } from '../todo/useThreadTodo';
import { placeRuns } from './run-card/place';
import { RunCard, RunEnd } from './run-card/RunCard';
import { useShownQuestions } from './run-card/shownQuestions';
import { ArrowDownIcon, ArrowUpIcon, FilesIcon, ThreadsIcon } from '../shell/icons';
import { ThreadTools, threadTools } from './ThreadTools';
import type { AnswerTools } from './AnswerShare';
import { Composer, type SendOptions } from './Composer';
import { usePeople, useTimeline, useTyping } from './hooks';
import { continuesRun, pendingContinues } from './runs';
import { threadLinksAbove } from '../linkpreview/dedupe';
import { setOpenThreadRoot } from '../taskview/openRoot';
import { EDIT_EVENT, MessageRow, PendingRow, type RowActions } from './MessageRow';
import { lastEditableOwn } from './messageActions';
import { ScheduledStrip } from './ScheduledStrip';
import { channelStore, threadKey } from './store';
import { useCallCard } from '../meetings/callCards';
import { startLine } from '../meetings/roomCard';
import { atBottom, jumpAriaLabel, jumpLabel, newReplyCount } from './threadJump';

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
  const channelOnScreen = inChannel?.params.channel ? (findChannel(feed.groups, inChannel.params.channel)?.id ?? null) : null;
  const hint = channelHint ?? channelOnScreen;
  const panelTools = usePanelTools();
  const names = useMemo(() => feed.groups.flatMap((g) => g.channels.map((c) => c.name.replace(/^#/, ''))), [feed.groups]);
  const typing = useTyping(threadKey(rootId));
  const scroller = useRef<HTMLDivElement>(null);
  // Whether the reader is at the newest reply. The ref is read by the pin effect; the state draws the "Jump to latest" pill. One setter
  // keeps them together and bails out when nothing changed, so scrolling does not re-render the thread per frame.
  const stuckRef = useRef(true);
  const [stuck, setStuckState] = useState(true);
  // The newest reply the reader had in view when they left the bottom: replies after it are "new" on the pill.
  const newestRef = useRef<string | null>(null);
  const [seenUpTo, setSeenUpTo] = useState<string | null>(null);
  const setStuck = useCallback((next: boolean) => {
    if (stuckRef.current === next) return;
    stuckRef.current = next;
    if (!next) setSeenUpTo(newestRef.current);
    setStuckState(next);
  }, []);
  // Scrolled away from the top: the "Jump to top" button shows (owner, 2026-11-19). Set only when it changes, as above.
  const [awayFromTop, setAwayFromTop] = useState(false);
  const [busy, setBusy] = useState(false);
  // the side rail (P29-20): the to-do timeline and the files, kept open or closed per person in this browser; the full page only
  const railId = useId();
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailOpen() ?? false);
  const setRail = useCallback((open: boolean) => {
    writeRailOpen(open);
    setRailOpen(open);
  }, []);

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
  const canVote = info.status === 'ok' && info.data !== null && info.data.channel.archivedAt === null;
  const canManage = info.status === 'ok' && info.data !== null && info.data.canManage;
  const newestReply = tl.items.at(-1)?.id ?? null;
  // the runs answering in this thread (their cards) and the bot's to-do list for it (P25-11)
  const runState = useThreadRunHeads(rootId);
  const todoState = useThreadTodo(rootId);
  const liveRun = useMemo(() => runState.runs.filter((r) => !runEnded(r.state)).sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))[0] ?? null, [runState.runs]);
  const fileKey = useMemo(() => attachmentKey([...(tl.root ? [tl.root] : []), ...tl.items]), [tl.root, tl.items]);
  const placed = useMemo(() => placeRuns(tl.items, runState.runs), [tl.items, runState.runs]);
  // a link the root or an earlier reply already previewed gets no second card (P34-04)
  const linksAbove = useMemo(() => threadLinksAbove(tl.root, tl.items, tl.pageStarts ?? []), [tl.root, tl.items, tl.pageStarts]);
  // A question is asked in one place: the strip leaves out the ones a run card draws (only those: one the card could not load stays here), and a bot's answered questions of a
  // run in this thread, which that run's step list keeps ("Asked to run pnpm · Allowed").
  const approvals = useThreadApprovals(rootId);
  const shownQuestions = useShownQuestions(rootId);
  const runBots = useMemo(() => new Set<string>(runState.runs.map((r) => r.botId)), [runState.runs]);
  const hideAsked = useCallback(
    (a: { id: string; status: string; source: string; botId?: string | null }) => shownQuestions.has(a.id) || (a.source === 'agent' && a.status !== 'pending' && a.botId != null && runBots.has(a.botId)),
    [shownQuestions, runBots],
  );
  // the channel folds this root's cards to a chip while it is open at the side (P29): the panel shows the same, once
  useEffect(() => {
    if (variant !== 'panel') return;
    setOpenThreadRoot(rootId);
    return () => setOpenThreadRoot(null);
  }, [rootId, variant]);
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

  // Stay at the newest reply while the reader is there; the watermark follows it until they scroll away.
  useLayoutEffect(() => {
    if (stuckRef.current) newestRef.current = newestReply;
    const el = scroller.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  });

  // the dock above the composer appears and folds, which resizes the list: a reader at the newest reply stays there
  const listDrawn = root !== null;
  useEffect(() => {
    if (!listDrawn) return;
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [listDrawn]);

  const rootActions = useMemo<RowActions | null>(
    () =>
      channelId
        ? {
            react: (id, emoji) => void channelStore.toggleReaction(channelId, null, id, emoji),
            edit: (id, body, confirm) => channelStore.edit(channelId, null, id, body, confirm),
            remove: (id) => channelStore.remove(channelId, null, id),
            pin: (id, on) => channelStore.setPin(channelId, id, on),
          }
        : null,
    [channelId],
  );
  const replyActions = useMemo<RowActions | null>(
    () =>
      channelId
        ? {
            react: (id, emoji) => void channelStore.toggleReaction(channelId, rootId, id, emoji),
            edit: (id, body, confirm) => channelStore.edit(channelId, rootId, id, body, confirm),
            remove: (id) => channelStore.remove(channelId, rootId, id),
            pin: (id, on) => channelStore.setPin(channelId, id, on),
            markUnread: async (id) => void (await channelStore.markUnread(channelId, id, rootId)),
          }
        : null,
    [channelId, rootId],
  );
  const send = useCallback(
    (body: string, { attachments, confirmBroadcast }: SendOptions) => {
      if (!channelId) return;
      setStuck(true);
      void channelStore.send(channelId, rootId, body, attachments, false, confirmBroadcast === true);
    },
    [channelId, rootId, setStuck],
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
  const teamForLink = slug ?? '';
  // the thread's own controls, one row of icon buttons in its header (P34-06): in the panel before Expand and Close, on the Threads page with Overview
  const channelHref = channelName && teamForLink ? `${channelPath(teamForLink, channelName)}?message=${rootId}` : null;
  const tools = (
    <ThreadTools
      tools={threadTools({ variant, canFollow: threadState !== null, channelLink: channelHref !== null, channelInView: channelOnScreen !== null && channelOnScreen === channelId })}
      followed={threadState?.followed ?? false}
      busy={busy}
      onFollow={() => void toggleFollow()}
      channelHref={channelHref}
      channelName={channelName}
      railOpen={railOpen}
      railId={railId}
      onRail={() => setRail(!railOpen)}
    />
  );
  // Waiting for an answer: the newest message is the reader's own, it is recent, and nothing of theirs is still being sent.
  const newestMessage = tl.items.at(-1) ?? root;
  const waiting =
    awaiting !== null && self !== null && tl.pending.length === 0 && newestMessage.authorId === self && Date.now() - Date.parse(newestMessage.createdAt) < AWAIT_REPLY_MS;

  const list = (
    <div
      className="rpb"
      ref={scroller}
      tabIndex={variant === 'panel' ? -1 : undefined}
      onScroll={(e) => {
        const el = e.currentTarget;
        setStuck(atBottom(el.scrollHeight - el.scrollTop - el.clientHeight));
        setAwayFromTop(el.scrollTop > Math.min(240, el.clientHeight / 2));
      }}
    >
      <div className="root">
        <MessageRow message={root} teamSlug={slug} people={people} selfActor={self} canPost={canReply} canVote={canVote} canManage={canManage} inThread actions={rootActions} />
        {variant === 'panel' ? <Linked rootId={rootId} /> : null}
      </div>
      {tl.cursor ? (
        <button type="button" className="btn s load-earlier" disabled={tl.loadingOlder} onClick={() => void channelStore.loadOlder(threadKey(rootId), channelId, rootId)}>
          {tl.loadingOlder ? 'Loading…' : 'Earlier replies'}
        </button>
      ) : null}
      {placed.atRoot.map((r) => <RunEnd key={r.runId} head={r} noticeShown={placed.noticed.has(r.runId)} />)}
      {tl.items.length === 0 && tl.pending.length === 0 && placed.live.length === 0 ? <p className="thread-empty">No replies yet. Start the conversation.</p> : null}
      {tl.items.map((m, i) => (
        <Fragment key={m.id}>
          <MessageRow message={m} continued={continuesRun(tl.items[i - 1], m)} linksAbove={linksAbove[i] ?? ''} teamSlug={slug} people={people} selfActor={self} canPost={canReply} canVote={canVote} canManage={canManage} inThread actions={replyActions} {...(answerTools ? { answerTools } : {})} />
          {(placed.after.get(m.id) ?? []).map((r) => <RunEnd key={r.runId} head={r} noticeShown={placed.noticed.has(r.runId)} />)}
        </Fragment>
      ))}
      {placed.live.map((r, i) => (
        <RunCard
          key={r.runId}
          head={r}
          rootId={rootId}
          slug={slug ?? null}
          people={people}
          hidePlan={todoState.todo !== null && r.botActorId === todoState.todo.botActorId}
          questionsInDock={approvals.status === 'ok'}
          continued={i === 0 && tl.pending.length === 0 && r.botActorId !== null && tl.items.at(-1)?.authorId === r.botActorId}
        />
      ))}
      <ThreadApprovals items={approvals.items} reload={approvals.reload} slug={slug ?? null} hide={hideAsked} />
      {waiting && placed.live.length === 0 ? <p className="typing" aria-live="polite" data-testid="awaiting-reply">{awaiting} is working on it…</p> : null}
      {tl.pending.map((p, i) => (
        <PendingRow
          key={p.localId}
          pending={p}
          name={people.me?.name ?? 'You'}
          continued={pendingContinues(i === 0 ? tl.items.at(-1) : tl.pending[i - 1], self, p.createdAt)}
          onRetry={(confirm) => void channelStore.retry(channelId, rootId, p.localId, confirm === true)}
          onDiscard={() => channelStore.discard(channelId, rootId, p.localId)}
        />
      ))}
      {typing ? <p className="typing" aria-live="polite">{typing}</p> : null}
    </div>
  );
  // Scrolled up in the panel: a pill above the composer goes back to the newest reply and counts the replies of others since (P25-16).
  const newCount = stuck ? 0 : newReplyCount(tl.items, seenUpTo, self);
  const jumpToLatest = (): void => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    el.focus({ preventScroll: true });
  };

  const jumpToTop = (): void => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = 0;
    el.focus({ preventScroll: true });
  };

  const kind: 'panel' | 'main' = variant as 'panel' | 'main';
  // Jump to top and to bottom (owner, 2026-11-19): two small round buttons at the bottom corner, each shown only when it would move the view. The pill in the
  // middle stays: it counts the new replies.
  const ends = awayFromTop || !stuck ? (
    <div className="thread-ends" role="group" aria-label="Move in the thread">
      {awayFromTop ? (
        <button type="button" className="thread-end" data-testid="thread-jump-top" aria-label="Jump to the top of the thread" title="Jump to the top" onClick={jumpToTop}>
          <ArrowUpIcon />
        </button>
      ) : null}
      {!stuck ? (
        <button type="button" className="thread-end" data-testid="thread-jump-bottom" aria-label="Jump to the bottom of the thread" title="Jump to the bottom" onClick={jumpToLatest}>
          <ArrowDownIcon />
        </button>
      ) : null}
    </div>
  ) : null;
  const column = (
    <>
    <div className="rpb-wrap">
      {list}
      {kind === 'panel' && !stuck ? (
        <button type="button" className="jump thread-jump" data-testid="thread-jump-latest" aria-label={jumpAriaLabel(newCount)} onClick={jumpToLatest}>
          <ArrowDownIcon />
          <span>{jumpLabel(newCount)}</span>
        </button>
      ) : null}
      {ends}
    </div>
    {/* the to-do, the run and the question a bot waits on, always in sight above the composer (P29-12) */}
    <ThreadDock rootId={rootId} railOpen={kind === 'main' && railOpen} slug={slug ?? null} people={people} runs={runState.runs} todo={todoState.todo} approvals={approvals.items} reloadApprovals={approvals.reload} />
    {info.status === 'ok' && !canReply ?<p className="read-only">You can read this thread but not reply.</p> : null}
    {canReply && replyBlocked !== null ? (
      <p className="read-only" data-testid="reply-blocked">{replyBlocked}</p>
    ) : canReply ? (
      <div className="rpf">
        {!answerTools ? <ScheduledStrip channelId={channelId} threadRootId={rootId} /> : null}
        <Composer
          draftKey={`thread:${rootId}`}
          placeholder={kind === 'main' ? 'Reply in thread…' : 'Reply…'}
          label="Reply in thread"
          channelId={channelId}
          threadRootId={rootId}
          people={people}
          channelNames={names}
          onSend={send}
          onVoiceSent={() => setStuck(true)}
          slash={slug && !answerTools ? { teamSlug: slug, origin: tl.channel?.kind === 'dm' ? 'a thread in a direct message' : channelName ? `a thread in #${channelName}` : 'a thread' } : undefined}
          autoFocus={kind === 'panel'}
          // a scheduled reply is posted in the thread only (there is no "Also send to channel" tick any more, P21-28)
          sendLater={!answerTools}
          onEditLast={() => {
            const id = lastEditableOwn(tl.items, self);
            if (id) window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: id }));
          }}
        />
      </div>
    ) : null}
    </>
  );
  return (
    <div className={`thread ${variant}`} data-testid="thread-view" data-root-id={rootId}>
      {variant === 'main' ? (
        <div className="chead thread-head">
          <h3 className="thread-title">{threadState?.title ?? (root.meta.meeting ? <CallThreadTitle meetingId={root.meta.meeting.meetingId} starterName={people.byActor(root.authorId)?.name ?? root.author?.displayName ?? 'Someone'} startedAt={root.createdAt} /> : root.bodyPlain.slice(0, 80))}</h3>
          {channelName || tl.channel?.kind === 'dm' ? <span className="topic" data-testid="thread-place">{channelName ? `Thread in #${channelName}` : 'Thread in a direct message'}</span> : null}
          <div className="right chead-tools thread-tools" data-testid="thread-tools">{tools}</div>
        </div>
      ) : panelTools ? (
        createPortal(tools, panelTools)
      ) : null}
      {kind === 'main' ? (
        <div className="thread-split" data-rail={railOpen ? 'open' : 'closed'}>
          <div className="thread-col">{column}</div>
          <ThreadRail
            rootId={rootId}
            id={railId}
            open={railOpen}
            onClose={() => setRail(false)}
            todo={todoState.todo}
            run={liveRun}
            approvals={approvals.items}
            fileKey={fileKey}
            ownerName={(actorId) => people.botName?.(actorId) ?? people.byActor(actorId)?.name}
          />
        </div>
      ) : (
        column
      )}
    </div>
  );
}

/** How long after the reader's own message a thread says the bot is working on it: a run that has not answered by then has failed, and the thread says nothing. */
const AWAIT_REPLY_MS = 3 * 60_000;

const isThreadHidden = (status: number | undefined): boolean => status === 403 || status === 404 || status === 400;

/** The title of a call's thread (its root is the call's start message, P15-26): the call's title once its card is known, else "Omar started a call · 22:14", never the stored start text. */
function CallThreadTitle({ meetingId, starterName, startedAt }: { meetingId: string; starterName: string; startedAt: string }) {
  const entry = useCallCard(meetingId);
  return <>{entry?.status === 'ok' ? entry.card.title : startLine(starterName, startedAt)}</>;
}
