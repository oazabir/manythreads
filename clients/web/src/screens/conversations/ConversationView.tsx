import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ConversationListItem, ConversationScope, FileSummary } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { fetchChannel, postMessage } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { Composer } from '../../channels/Composer';
import { ago } from '../../channels/format';
import { usePeople, useTimeline } from '../../channels/hooks';
import { ThreadBody } from '../../channels/ThreadPanel';
import { threadKey } from '../../channels/store';
import { Alert, Avatar } from '../../components/ui';
import { useChannelFeed } from '../../shell/channelFeed';
import { useShell } from '../../shell/context';
import { BackIcon } from '../../shell/icons';
import { useHeaderTopic } from '../../shell/topic';
import { useNarrow } from '../../shell/useNarrow';
import { fetchBots } from '../bots/api';
import { fetchConversations, openConversation } from './api';

/*
 * Talking to a bot (SPEC §6.2, PLAN P5-16, `[proto §12]`): at `/t/:team/bots/:botSlug/chat`. On the left the bot's conversations with the
 * person (Mine · Shared · Channel mentions), on the right the selected one, a message box at the bottom. There is no "new conversation"
 * button: the empty state is the message box and a few prompt chips, and sending starts a thread — the message is its root — and the view
 * switches to it. A conversation is an ordinary thread of the person's own channel with the bot (kind `bot_conversation`, never in the
 * sidebar), so following, unread and the thread view are the ones the rest of the app has; the thread is drawn by `ThreadBody`.
 *
 * The URL says what is on screen: `?tab=` the list, `?thread=` the conversation (absent: the empty state with its message box).
 */

const TABS: ReadonlyArray<{ id: ConversationScope; label: string }> = [
  { id: 'mine', label: 'Mine' },
  { id: 'shared', label: 'Shared' },
  { id: 'mentions', label: 'Channel mentions' },
];

const scopeOf = (raw: string | null): ConversationScope => (TABS.some((t) => t.id === raw) ? (raw as ConversationScope) : 'mine');

const EMPTY: Record<ConversationScope, (bot: string, slug: string) => { title: string; body: string }> = {
  mine: (bot) => ({ title: 'Nothing yet', body: `Ask ${bot} something below.` }),
  shared: () => ({ title: 'Nothing shared yet', body: 'Conversations people share with the team show here.' }),
  mentions: (_bot, slug) => ({ title: 'No mentions yet', body: `Name @${slug} in a channel and the thread shows here.` }),
};

/** How long a list is allowed to be stale while a conversation is open: replies refresh it sooner (the open thread's newest message). */
const STALE_POLL_MS = 15_000;

export function ConversationView() {
  const { team = '', botSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();
  const people = usePeople();
  const feed = useChannelFeed(team);
  const scope = scopeOf(params.get('tab'));
  const thread = params.get('thread');
  const opened = useQuery(`conversation-open:${team}:${botSlug}`, () => openConversation(team, botSlug));
  const [tick, setTick] = useState(0);
  const lists = useQuery(`conversations:${team}:${botSlug}:${scope}:${String(tick)}`, () => fetchConversations(team, botSlug, scope));
  useHeaderTopic(opened.status === 'ok' ? opened.data.botRole : null);

  // The list follows the open conversation: its newest message (the bot's answer arrives) refreshes it, and so does coming back to the tab.
  const timeline = useTimeline(threadKey(thread ?? ''));
  const newest = timeline.items.at(-1)?.id ?? null;
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (newest !== null) refresh();
  }, [newest, refresh]);
  useEffect(() => {
    const on = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', on);
    const poll = window.setInterval(on, STALE_POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', on);
      window.clearInterval(poll);
    };
  }, [refresh]);

  const channelNames = useMemo(() => feed.groups.flatMap((g) => g.channels.map((c) => c.name.replace(/^#/, ''))), [feed.groups]);
  const items = lists.status === 'ok' ? lists.data.items : [];
  const selected = thread === null ? undefined : items.find((i) => i.threadRootId === thread);
  const path = `/t/${team}/bots/${botSlug}/chat`;

  const go = useCallback(
    (next: { thread?: string | null; tab?: ConversationScope }): void => {
      const q = new URLSearchParams(params);
      if (next.thread !== undefined) {
        if (next.thread === null) q.delete('thread');
        else q.set('thread', next.thread);
      }
      if (next.tab !== undefined) {
        if (next.tab === 'mine') q.delete('tab');
        else q.set('tab', next.tab);
      }
      void setParams(q, { replace: false });
    },
    [params, setParams],
  );

  const [failed, setFailed] = useState<{ body: string; attachments: FileSummary[]; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const channelId = opened.status === 'ok' ? opened.data.channelId : null;
  const start = useCallback(
    async (body: string, attachments: FileSummary[]): Promise<void> => {
      if (channelId === null || sending) return;
      setSending(true);
      setFailed(null);
      try {
        const root = await postMessage(channelId, body, null, attachments.map((f) => f.id));
        go({ thread: root.id, tab: 'mine' });
        refresh();
        // the index row follows the message by the outbox's own latency: ask again once it is surely there
        window.setTimeout(refresh, 1_200);
      } catch (err) {
        setFailed({ body, attachments, message: isApiError(err) ? err.message : 'The message was not sent.' });
      } finally {
        setSending(false);
      }
    },
    [channelId, sending, go, refresh],
  );

  if (opened.status === 'loading') return <div className="view-empty" aria-busy="true" data-testid="conversation-loading" />;
  if (opened.status === 'error') return <CannotTalk error={opened.error} slug={team} />;
  const bot = opened.data;
  const showList = !narrow || thread === null;
  const showMain = !narrow || thread !== null;
  const empty = EMPTY[scope](bot.botName, botSlug);

  return (
    <div className={`inbox cv ${narrow ? 'narrow' : ''} ${narrow && thread !== null ? 'cv-thread' : ''}`} data-testid="conversation-view" data-bot={botSlug} data-channel-id={bot.channelId}>
      {showList ? (
        <div className="inl" data-landmark="conversation-list">
          <header className="inh cv-head">
            <h2 className="inh-title cv-title">
              <Link to={{ pathname: path, search: scope === 'mine' ? '' : `?tab=${scope}` }} data-testid="conversation-home">{bot.botName}</Link>
              <span className="cv-sub"> · conversations with you</span>
            </h2>
            <div className="tabs2" role="tablist" aria-label={`${bot.botName} conversations`}>
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={scope === t.id} data-testid={`conversation-tab-${t.id}`} className={scope === t.id ? 'on' : ''} onClick={() => go({ tab: t.id })}>
                  {t.label}
                </button>
              ))}
            </div>
          </header>
          {lists.status === 'loading' ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : lists.status === 'error' ? (
            <div className="inl-empty" role="alert">
              <p className="view-empty-title">Could not load conversations.</p>
              <button type="button" className="btn s" onClick={lists.reload}>Try again</button>
            </div>
          ) : items.length === 0 ? (
            <div className="inl-empty" data-testid="conversation-list-empty">
              <p className="view-empty-title">{empty.title}</p>
              <p className="view-empty-body">{empty.body}</p>
            </div>
          ) : (
            <ul className="inlist" role="listbox" aria-label={`${TABS.find((t) => t.id === scope)?.label ?? ''} conversations`}>
              {items.map((item) => (
                <ConversationRow key={`${item.source}:${item.threadRootId}`} item={item} botName={bot.botName} on={item.threadRootId === thread} onOpen={() => go({ thread: item.threadRootId })} who={people.byPerson(item.personId)?.name ?? 'Someone'} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {showMain ? (
        <div className="inr" data-landmark="conversation-main">
          {narrow ? (
            <button type="button" className="btn s back-to-list" data-testid="conversation-back" onClick={() => go({ thread: null })}>
              <BackIcon />
              <span>Conversations</span>
            </button>
          ) : null}
          {thread !== null ? (
            <ThreadBody key={thread} rootId={thread} variant="main" channelId={selected?.channelId ?? bot.channelId} awaiting={bot.botName} />
          ) : (
            <div className="cv-start" data-testid="conversation-start">
              <div className="cv-intro">
                <Avatar name={bot.botName} kind="agent" />
                <div>
                  <h2 className="cv-name" data-testid="conversation-bot">{bot.botName}</h2>
                  <p className="cv-role">{bot.botRole || 'Ask it anything it is here for.'}</p>
                </div>
              </div>
              <div className="cv-chips" data-testid="prompt-chips" data-source={bot.promptSource}>
                {bot.prompts.map((p) => (
                  <button key={p} type="button" className="cv-chip" disabled={sending} data-testid="prompt-chip" onClick={() => void start(p, [])}>
                    {p}
                  </button>
                ))}
              </div>
              {failed ? (
                <div className="cv-failed" data-testid="conversation-send-failed">
                  <Alert>{failed.message}</Alert>
                  <button type="button" className="btn s" onClick={() => void start(failed.body, failed.attachments)}>Send again</button>
                </div>
              ) : null}
              <div className="cv-compose">
                <Composer
                  draftKey={`conversation:${bot.channelId}`}
                  placeholder={`Ask ${bot.botName} anything…`}
                  label={`Message ${bot.botName}`}
                  channelId={bot.channelId}
                  threadRootId={null}
                  people={people}
                  channelNames={channelNames}
                  onSend={(body, attachments) => void start(body, attachments)}
                  autoFocus
                />
              </div>
              <p className="cv-hint">Sending starts a thread. There is no “new conversation” button; the message is the button.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConversationRow({ item, botName, who, on, onOpen }: { item: ConversationListItem; botName: string; who: string; on: boolean; onOpen: () => void }) {
  const unread = item.unreadCount > 0;
  const label =
    item.source === 'mention'
      ? `Channel mention · # ${item.channelName ?? ''}`
      : item.visibility === 'shared'
        ? item.mine
          ? 'Shared with the team'
          : `Shared by ${who}`
        : 'Private to you';
  // somebody else's shared conversation without a copy the reader can open: listed, never opened
  const closed = !item.mine && item.source === 'conversation' && item.sharedTo === null;
  const speaker = item.lastAuthor === 'bot' ? botName : item.lastAuthor === 'person' ? (item.mine ? 'You' : who) : null;
  const last = item.preview !== '' ? (speaker ? `${speaker}: ${item.preview}` : item.preview) : item.replyCount === 0 ? 'No answer yet' : '';
  return (
    <li role="option" aria-selected={on} data-root-id={item.threadRootId} data-testid="conversation-row" data-source={item.source} data-visibility={item.visibility ?? ''}>
      <button type="button" className={`trow ${unread ? 'unread' : ''} ${on ? 'on' : ''}`} disabled={closed} onClick={onOpen}>
        <span className="trow-main">
          <span className="ch" data-testid="conversation-label">{label}</span>
          <span className="ttl">{item.title !== '' ? item.title : 'A shared conversation'}</span>
          <span className="last">{last}</span>
        </span>
        <span className="meta">
          <span data-vt-mask>{ago(item.lastActivityAt)}</span>
          {unread ? <span className="cnt" data-vt-mask>{item.unreadCount}</span> : item.replyCount > 0 ? <span className="rc">{item.replyCount === 1 ? '1 reply' : `${item.replyCount} replies`}</span> : null}
        </span>
      </button>
    </li>
  );
}

/** Why the conversation did not open, in words: the bot is not the person's to talk to, is not there, or is not running. */
function CannotTalk({ error, slug }: { error: Error; slug: string }) {
  const status = isApiError(error) ? error.status : 0;
  const title =
    status === 403 ? 'You cannot talk to this bot' : status === 404 ? 'There is no such bot' : status === 409 ? 'This bot cannot answer right now' : 'The conversation did not open';
  const body =
    status === 403
      ? 'Only people on the bot’s team can talk to it. A team lead can add you.'
      : status === 404
        ? 'It may have been removed from the team.'
        : error.message;
  return (
    <div className="view-empty" role="alert" data-testid="conversation-unavailable">
      <p className="view-empty-title">{title}</p>
      <p className="view-empty-body">{body}</p>
      <Link className="btn" to={`/t/${slug}/bots`}>Back to the bots</Link>
    </div>
  );
}

/** `/t/:team/chat/:channelId?thread=`: a link that knows only the conversation channel (a search hit, a notification) finds the bot it is with. */
export function ConversationRedirect() {
  const { team = '', channelId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { teams } = useShell();
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const channel = (await fetchChannel(channelId)).channel;
        // the channel names its team: a link from another team's page (a search hit) still lands in the right one
        const slug = teams.find((t) => t.id === channel.teamId)?.slug ?? team;
        const bots = (await fetchBots(slug)).bots;
        const bot = bots.find((b) => b.id === channel.botId);
        if (!live) return;
        if (!bot) return setLost(true);
        const thread = params.get('thread');
        void navigate({ pathname: `/t/${slug}/bots/${bot.slug}/chat`, search: thread ? `?thread=${thread}` : '' }, { replace: true });
      } catch {
        if (live) setLost(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [team, teams, channelId, params, navigate]);
  if (lost) {
    return (
      <div className="view-empty" role="alert" data-testid="no-access">
        <p className="view-empty-title">You cannot see this conversation.</p>
        <p className="view-empty-body">A conversation with a bot belongs to the person who started it.</p>
      </div>
    );
  }
  return <div className="view-empty" aria-busy="true" />;
}
