import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { FileSummary } from '@manythreads/shared';
import { fetchChannel } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Composer } from '../channels/Composer';
import { estimateItem, buildListItems, messageKey, UNREAD_KEY, type ListItem } from '../channels/listItems';
import { PendingRow, MessageRow, type RowActions } from '../channels/MessageRow';
import { usePeople, useTimeline, useTyping } from '../channels/hooks';
import { channelKey, channelStore } from '../channels/store';
import { firstUnreadIndex } from '../channels/timeline';
import { isApiError } from '../api/client';
import { VirtualList, type VirtualListApi } from '../channels/VirtualList';
import { usePanel } from '../kernel/panel';
import { useShell } from '../shell/context';
import { findChannel, useChannelFeed } from '../shell/channelFeed';
import { ArrowDownIcon } from '../shell/icons';
import { useRealtimeStatus } from '../realtime';

export function NoChannelAccess() {
  return (
    <div className="view-empty" role="alert" data-testid="no-access">
      <p className="view-empty-title">You cannot see this channel.</p>
      <p className="view-empty-body">It may be private, or it may not exist. Ask a team lead if you should be in it.</p>
    </div>
  );
}

/** `/t/:team/c/:channel`: the channel by the name in the URL, if the directory lists it for this person. */
export function ChannelView() {
  const { channel = '' } = useParams();
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug;
  const feed = useChannelFeed(slug);
  const entry = findChannel(feed.groups, channel);
  if (feed.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (!entry || !slug) return <NoChannelAccess />;
  return <ChannelBody key={entry.id} channelId={entry.id} name={entry.name.replace(/^#/, '')} teamSlug={slug} />;
}

const NO_NAMES: string[] = [];
function useNames(slug: string): string[] {
  const feed = useChannelFeed(slug);
  return useMemo(() => (feed.groups.length === 0 ? NO_NAMES : feed.groups.flatMap((g) => g.channels.map((c) => c.name.replace(/^#/, '')))), [feed.groups]);
}

/** A conversation shown as a channel does: `dm` replaces the `#name` copy with who is in it. */
export type DmCopy = { label: string };

export function ChannelBody({ channelId, name, teamSlug, dm }: { channelId: string; name: string; teamSlug: string; dm?: DmCopy }) {
  const { guest } = useShell();
  const people = usePeople();
  const panel = usePanel();
  const [params] = useSearchParams();
  const info = useQuery(`channel:${channelId}`, () => fetchChannel(channelId));
  const tl = useTimeline(channelKey(channelId));
  const channelNames = useNames(teamSlug);
  const status = useRealtimeStatus();
  const typing = useTyping(channelKey(channelId));
  const api = useRef<VirtualListApi>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [readAtOpen, setReadAtOpen] = useState<{ known: boolean; lastReadId: string | null }>({ known: false, lastReadId: null });
  const [highlight, setHighlight] = useState<string | null>(null);
  const [hadUnread, setHadUnread] = useState<boolean | null>(null);
  const [seenUpTo, setSeenUpTo] = useState<string | null>(null);
  const scrolledToUnread = useRef(false);
  const targetMessage = params.get('message');

  useEffect(() => {
    void channelStore.loadChannel(channelId);
    let live = true;
    void channelStore.loadReadState('channel', channelId).then((r) => live && setReadAtOpen({ known: true, lastReadId: r?.lastReadId ?? null }));
    return () => {
      live = false;
    };
  }, [channelId]);
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const self = people.me?.actorId ?? null;
  const newest = tl.items.at(-1)?.id ?? null;
  // The "New" line sits after what was read when the channel opened. Opened with nothing unread, it only marks what arrived while
  // the reader was away from the bottom: watching the bottom, nothing is new.
  const readyToDivide = readAtOpen.known && tl.status === 'ready' && hadUnread !== null;
  const lastRead = hadUnread ? readAtOpen.lastReadId : atBottom ? newest : seenUpTo;
  const items = useMemo(
    () => buildListItems(tl.items, tl.pending, { lastReadId: lastRead, selfActor: self, allLoaded: tl.cursor === null, readKnown: readyToDivide }),
    [tl.items, tl.pending, tl.cursor, lastRead, self, readyToDivide],
  );
  const unreadShown = items.some((i) => i.kind === 'unread');
  useEffect(() => {
    if (hadUnread === null && tl.status === 'ready' && readAtOpen.known) {
      setHadUnread(firstUnreadIndex(tl.items, readAtOpen.lastReadId, self, tl.cursor === null) >= 0);
      setSeenUpTo(readAtOpen.lastReadId);
    }
  }, [hadUnread, tl.status, tl.items, tl.cursor, readAtOpen, self]);
  useEffect(() => {
    if (atBottom && newest) setSeenUpTo(newest);
  }, [atBottom, newest]);

  // Open on the first unread message when there are more of them than a screen holds; otherwise on the newest.
  useEffect(() => {
    if (scrolledToUnread.current || !unreadShown || targetMessage) return;
    const idx = items.findIndex((i) => i.kind === 'unread');
    if (items.length - idx > 14) {
      scrolledToUnread.current = true;
      api.current?.scrollToKey(UNREAD_KEY);
    } else {
      scrolledToUnread.current = true;
    }
  }, [items, unreadShown, targetMessage]);

  // Mark read when the bottom is in view (and the tab is): one request per new newest message.
  useEffect(() => {
    if (!newest || !atBottom || !visible || tl.status !== 'ready') return;
    const t = setTimeout(() => void channelStore.markRead('channel', channelId, newest), 250);
    return () => clearTimeout(t);
  }, [newest, atBottom, visible, tl.status, channelId]);

  // `?message=<id>` (a link to one message): bring it into view, loading older pages until it is held.
  useEffect(() => {
    if (!targetMessage || tl.status !== 'ready') return;
    const key = messageKey(targetMessage);
    if (items.some((i) => i.key === key)) {
      const frame = requestAnimationFrame(() => api.current?.scrollToKey(key));
      setHighlight(targetMessage);
      const t = setTimeout(() => setHighlight(null), 2_500);
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(t);
      };
    }
    if (tl.cursor) void channelStore.loadOlder(channelKey(channelId), channelId, null);
  }, [targetMessage, tl.status, tl.items, tl.cursor, items, channelId]);

  const actions = useMemo<RowActions>(
    () => ({
      openThread: (id) => panel.push({ type: 'thread', id }),
      react: (id, emoji) => void channelStore.toggleReaction(channelId, null, id, emoji),
      edit: (id, body) => channelStore.edit(channelId, null, id, body),
      remove: (id) => channelStore.remove(channelId, null, id),
    }),
    [channelId, panel],
  );
  const onNearTop = useCallback(() => void channelStore.loadOlder(channelKey(channelId), channelId, null), [channelId]);
  const getKey = useCallback((i: ListItem) => i.key, []);
  const isMessage = useCallback((i: ListItem) => i.kind === 'message', []);
  const canPost = info.status === 'ok' && info.data.canPost && info.data.channel.archivedAt === null;
  const pendingName = people.me?.name ?? 'You';

  const render = useCallback(
    (item: ListItem) => {
      switch (item.kind) {
        case 'day':
          return <div className="daysep" data-vt-mask>{item.label}</div>;
        case 'unread':
          return <div className="daysep unread-sep" data-testid="unread-divider" role="separator" aria-label="New messages"><span>New</span></div>;
        case 'message':
          return (
            <MessageRow
              message={item.message}
              teamSlug={teamSlug}
              people={people}
              selfActor={self}
              canPost={canPost}
              highlight={highlight === item.message.id}
              actions={actions}
            />
          );
        case 'pending':
          return (
            <PendingRow
              pending={item.pending}
              name={pendingName}
              onRetry={() => void channelStore.retry(channelId, null, item.pending.localId)}
              onDiscard={() => channelStore.discard(channelId, null, item.pending.localId)}
            />
          );
      }
    },
    [teamSlug, people, self, canPost, highlight, actions, channelId, pendingName],
  );

  const send = useCallback(
    (body: string, attachments: FileSummary[]) => {
      void channelStore.send(channelId, null, body, attachments);
      api.current?.scrollToBottom();
    },
    [channelId],
  );

  if (info.status === 'error' && isApiError(info.error) && (info.error.status === 403 || info.error.status === 404)) return <NoChannelAccess />;
  if (tl.status === 'error' && tl.error && (tl.error.status === 403 || tl.error.status === 404)) return <NoChannelAccess />;

  const channel = info.status === 'ok' ? info.data.channel : null;
  // the header keeps one height while older pages load (the reader's place must not move), and grows only for the start of the channel
  const header = (
    <div className={`start ${tl.cursor === null ? 'top' : ''}`} data-testid="channel-start">
      {tl.cursor === null && tl.status === 'ready' ? (
        <>
          <p className="start-title">{dm ? `This is the start of your conversation with ${dm.label}.` : `This is the start of #${name}.`}</p>
          {channel?.purpose ? <p className="start-body">{channel.purpose}</p> : null}
        </>
      ) : (
        <p className="start-body" aria-live="polite">{tl.loadingOlder ? 'Loading earlier messages…' : ' '}</p>
      )}
    </div>
  );

  return (
    <div className="chview" data-testid="channel-view" data-channel-id={channelId} aria-busy={tl.status === 'loading' || undefined}>
      {status === 'waiting' ? <div className="net-banner" role="status">Reconnecting… new messages will appear when you are back online.</div> : null}
      <div className="chview-list">
        {tl.status === 'loading' ? (
          <div className="loading-rows" aria-hidden="true">
            {[0, 1, 2, 3].map((n) => <div key={n} className="skel" />)}
          </div>
        ) : tl.status === 'error' ? (
          <div className="view-empty" role="alert">
            <p className="view-empty-title">Could not load this channel.</p>
            <p className="view-empty-body">{tl.error?.message}</p>
            <button type="button" className="btn" onClick={() => void channelStore.loadChannel(channelId)}>Try again</button>
          </div>
        ) : (
          <VirtualList
            label={dm ? `Messages with ${dm.label}` : `Messages in #${name}`}
            items={items}
            getKey={getKey}
            estimate={estimateItem}
            render={render}
            anchorable={isMessage}
            onNearTop={onNearTop}
            onBottomChange={setAtBottom}
            header={header}
            footer={typing ? <p className="typing" aria-live="polite">{typing}</p> : null}
            apiRef={api}
          />
        )}
        {!atBottom && tl.status === 'ready' && tl.items.length > 0 ? (
          <button type="button" className="jump" onClick={() => api.current?.scrollToBottom()}>
            <ArrowDownIcon />
            <span>Jump to latest</span>
          </button>
        ) : null}
      </div>
      {info.status === 'ok' && canPost ? (
        <Composer
          draftKey={`channel:${channelId}`}
          placeholder={dm ? `Message ${dm.label}` : `Message #${name}`}
          label={dm ? `Message ${dm.label}` : `Message #${name}`}
          channelId={channelId}
          threadRootId={null}
          people={people}
          channelNames={channelNames}
          onSend={send}
        />
      ) : info.status === 'ok' ? (
        <p className="read-only" data-testid="read-only">
          {info.data.channel.archivedAt ? 'This channel is archived. You can read it but not post.' : guest ? 'You can read this channel.' : 'You can read this channel but not post in it.'}
        </p>
      ) : null}
    </div>
  );
}
