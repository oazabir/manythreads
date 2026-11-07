import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { MessageId, type ChatSendRequest, type ConversationListItem } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { Composer } from '../../channels/Composer';
import { usePeople } from '../../channels/hooks';
import { channelStore, threadKey } from '../../channels/store';
import { Alert, Avatar } from '../../components/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { sayToast } from '../../kernel/toast';
import { RailIcon } from '../../shell/icons';
import { useCrumbTail } from '../../shell/topic';
import { useNarrow } from '../../shell/useNarrow';
import { fetchBots } from '../bots/api';
import { openConversation } from '../conversations/api';
import { chatShortcuts } from './shortcuts';
import { optionFor, pickedAlias } from './models';
import { deleteChat, fetchChatModels, fetchChatState, listChats, patchChat, restoreChat, sendChat, stopRun } from './api';
import { ChatColumn } from './ChatColumn';
import { EmptyChat } from './EmptyChat';
import { HistoryRail, type RailActions } from './HistoryRail';
import { exportFileName, exportMarkdown, buildRows, railGroups, railTitle, previewLive } from './model';
import { PopMenu } from './PopMenu';
import type { LocalCommand } from '../../channels/composerTools';
import { useChatState } from './useChatState';
import { useChatStream } from './useChatStream';

/** The bot Chat opens with when the address does not name one. */
export const DEFAULT_BOT = 'brain';

type Override = { title?: string; pinned?: boolean };

const isEditable = (t: EventTarget | null): boolean => {
  const el = t instanceof HTMLElement ? t : null;
  return el !== null && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
};

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Chat (PLAN P20-16), at `/t/:team/chat`: a full chat with a bot, Brain by default. On the left the history of the person's chats with that bot, in the middle
 * a column of at most 760 px with the conversation and the message box. `?bot=` names the bot and `?c=` the conversation (the first message of its thread).
 * Sending starts a conversation when none is open. The answer is shown as it is written; Stop ends it with what was written so far.
 */
export function ChatScreen() {
  const { team = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();
  const session = useSession();
  const people = usePeople();
  const root = MessageId.safeParse(params.get('c')).data ?? null;

  // ---- the bot ----------------------------------------------------------------------------------------------------------------
  const bots = useQuery(`chat-bots:${team}`, () => fetchBots(team));
  const talkable = useMemo(() => (bots.status === 'ok' ? bots.data.bots.filter((b) => b.conversational && b.status === 'active') : []), [bots]);
  const named = params.get('bot');
  const botSlug = named ?? (talkable.some((b) => b.slug === DEFAULT_BOT) ? DEFAULT_BOT : (talkable[0]?.slug ?? DEFAULT_BOT));
  const known = bots.status === 'ok' ? bots.data.bots.find((b) => b.slug === botSlug) : undefined;
  const opened = useQuery(`chat-open:${team}:${botSlug}`, () => openConversation(team, botSlug));
  const blocked = opened.status === 'error' && isApiError(opened.error) && opened.error.status === 409 ? opened.error : null;
  const bot = opened.status === 'ok' ? opened.data : null;
  const botName = bot?.botName ?? known?.name ?? botSlug;
  const channelId = bot?.channelId ?? null;
  useCrumbTail(bot || known ? botName : null);

  const go = useCallback(
    (next: { bot?: string; c?: string | null }): void => {
      const q = new URLSearchParams(params);
      if (next.bot !== undefined) {
        q.set('bot', next.bot);
        q.delete('c');
      }
      if (next.c !== undefined) {
        if (next.c === null) q.delete('c');
        else q.set('c', next.c);
      }
      void setParams(q, { replace: false });
    },
    [params, setParams],
  );

  // ---- the history rail ---------------------------------------------------------------------------------------------------------
  const who = useMemo(() => ({ team, bot: botSlug }), [team, botSlug]);
  const [tick, setTick] = useState(0);
  const refreshRail = useCallback(() => setTick((n) => n + 1), []);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const pinned = useQuery(`chat-pinned:${team}:${botSlug}:${q}:${String(tick)}`, () => (q === '' ? listChats(who, { pinned: 'only' }) : Promise.resolve(null)));
  const rest = useQuery(`chat-rest:${team}:${botSlug}:${q}:${String(tick)}`, () => listChats(who, q === '' ? { pinned: 'without' } : { q }));
  const [older, setOlder] = useState<{ items: ConversationListItem[]; next: string | null; loading: boolean }>({ items: [], next: null, loading: false });
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setOlder({ items: [], next: null, loading: false });
  }, [team, botSlug, q, tick]);
  useEffect(() => {
    if (rest.status === 'ok') setOverrides({});
  }, [rest]);
  const restNext = older.items.length > 0 ? older.next : rest.status === 'ok' ? (rest.data.nextCursor ?? null) : null;
  const loadOlder = async (): Promise<void> => {
    if (restNext === null || older.loading) return;
    setOlder((o) => ({ ...o, loading: true }));
    try {
      const page = await listChats(who, { ...(q === '' ? { pinned: 'without' as const } : { q }), cursor: restNext });
      setOlder((o) => ({ items: [...o.items, ...page.items], next: page.nextCursor ?? null, loading: false }));
    } catch {
      setOlder((o) => ({ ...o, loading: false }));
      sayToast('Could not load older chats. Try again.');
    }
  };
  const items = useMemo<ConversationListItem[]>(() => {
    const all = [...(pinned.status === 'ok' && pinned.data ? pinned.data.items : []), ...(rest.status === 'ok' ? rest.data.items : []), ...older.items];
    const seen = new Set<string>();
    return all
      .filter((i) => !gone.has(i.threadRootId) && !seen.has(i.threadRootId) && (seen.add(i.threadRootId), true))
      .map((i) => {
        const o = overrides[i.threadRootId];
        return o ? { ...i, ...(o.title !== undefined ? { title: o.title } : {}), ...(o.pinned !== undefined ? { pinned: o.pinned } : {}) } : i;
      });
  }, [pinned, rest, older.items, overrides, gone]);
  const groups = useMemo(() => railGroups(items), [items]);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.threadRootId)), [groups]);
  const selectedItem = items.find((i) => i.threadRootId === root);
  const railStatus: 'loading' | 'ok' | 'error' = rest.status === 'error' || pinned.status === 'error' ? 'error' : rest.status === 'loading' || pinned.status === 'loading' ? 'loading' : 'ok';
  const [railOpen, setRailOpen] = useState(false);
  // a drawer that closes takes the focus with it (it is inert when shut): give it back to the button that opened it
  const wasOpen = useRef(false);
  useEffect(() => {
    const here = document.activeElement;
    const lost = here === null || here === document.body || document.querySelector('[data-testid="chat-rail"]')?.contains(here) === true;
    if (wasOpen.current && !railOpen && lost) document.querySelector<HTMLElement>('[data-testid="chat-rail-toggle"]')?.focus();
    wasOpen.current = railOpen;
  }, [railOpen]);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---- the open conversation ----------------------------------------------------------------------------------------------------------
  const { state, reload: reloadState, patch: patchState } = useChatState(team, botSlug, root);
  const { preview, reset: resetPreview } = useChatStream(root);
  const live = previewLive(preview) || (state?.liveRunId ?? null) !== null;
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (preview.ended !== null) setStopping(false);
  }, [preview.ended]);
  useEffect(() => {
    // the answer is a message now: read the state again (the new answer, the title)
    if (preview.ended !== null) {
      reloadState();
      refreshRail();
    }
  }, [preview.ended, reloadState, refreshRail]);
  const stop = useCallback(async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    try {
      let runId = preview.runId ?? state?.liveRunId ?? null;
      if (runId === null && root !== null) runId = (await fetchChatState({ ...who, root })).liveRunId;
      if (runId === null) {
        sayToast('There is nothing to stop yet.');
        setStopping(false);
        return;
      }
      const res = await stopRun(runId);
      if (!res.stopped) {
        sayToast('It had already finished.');
        setStopping(false);
      }
      setTimeout(() => setStopping(false), 5_000);
    } catch (e) {
      setStopping(false);
      sayToast(isApiError(e) ? e.message : 'Could not stop it. Try again.');
    }
  }, [stopping, preview.runId, state?.liveRunId, root, who]);

  // ---- the model ---------------------------------------------------------------------------------------------------------------------
  const models = useQuery(`chat-models:${team}:${botSlug}`, () => fetchChatModels(who));
  const modelList = models.status === 'ok' ? models.data.models : null;
  const options = useMemo(() => modelList ?? [], [modelList]);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [root, botSlug]);
  const effective = pickedAlias(options, picked, state?.modelAlias ?? selectedItem?.modelAlias ?? null);
  const pickAlias = useCallback(
    async (alias: string): Promise<void> => {
      setPicked(alias);
      if (root === null) return;
      try {
        await patchChat({ ...who, root }, { modelAlias: alias });
        patchState((s) => ({ ...s, modelAlias: alias }));
      } catch (e) {
        setPicked(null);
        sayToast(isApiError(e) ? e.message : 'Could not change the model. Try again.');
      }
    },
    [root, who, patchState],
  );
  const modelMenu =
    options.length > 1 ? (
      <PopMenu
        testId="chat-model"
        ariaLabel="Model"
        label={optionFor(options, effective)?.label ?? 'Model'}
        items={options.map((o) => ({ key: o.alias, label: o.label, hint: o.hint, selected: o.alias === effective, disabled: !o.available, reason: o.reason }))}
        onPick={(alias) => void pickAlias(alias)}
      />
    ) : null;

  // ---- sending -------------------------------------------------------------------------------------------------------------------------
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ request: ChatSendRequest; message: string } | null>(null);
  const sendingRef = useRef(false);
  const submit = useCallback(
    async (request: ChatSendRequest): Promise<void> => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setFailed(null);
      setPending(request.body);
      try {
        const sent = await sendChat(who, request);
        resetPreview();
        if (request.threadRootId === null) go({ c: sent.messageId });
        else await channelStore.loadThread(request.threadRootId, sent.channelId);
        refreshRail();
        // the index row follows the message by the outbox's own latency: ask again once it is surely there
        setTimeout(refreshRail, 1_200);
        if (request.threadRootId !== null) reloadState();
      } catch (e) {
        setFailed({ request, message: isApiError(e) ? e.message : 'The message was not sent.' });
      } finally {
        sendingRef.current = false;
        setPending(null);
      }
    },
    [who, go, refreshRail, reloadState, resetPreview],
  );
  const onSend = useCallback(
    (body: string, { attachments }: { attachments: ReadonlyArray<{ id: string }> }): void => {
      void submit({ body, threadRootId: root, attachments: attachments.map((a) => a.id) as ChatSendRequest['attachments'], ...(picked !== null ? { modelAlias: picked } : {}) });
    },
    [submit, root, picked],
  );
  // ---- the rail's actions ------------------------------------------------------------------------------------------------------------------
  const exportOne = useCallback(
    async (rootId: string): Promise<void> => {
      try {
        if (channelId === null) return;
        await channelStore.loadThread(rootId, channelId);
        const t = channelStore.get(threadKey(rootId));
        const s = await fetchChatState({ ...who, root: rootId });
        const rows = buildRows(t.root, t.items, s, people.me?.actorId ?? null);
        const title = s.title.trim() !== '' ? s.title : (items.find((i) => i.threadRootId === rootId)?.title ?? '');
        download(exportFileName(title), exportMarkdown(title, rows, { you: session.person.name, bot: botName }));
      } catch (e) {
        sayToast(isApiError(e) ? e.message : 'Could not export the chat. Try again.');
      }
    },
    [channelId, who, people.me?.actorId, items, session.person.name, botName],
  );
  const actions: RailActions = {
    onOpen: (r) => {
      go({ c: r });
      setRailOpen(false);
    },
    onRename: (r, title) => {
      setOverrides((o) => ({ ...o, [r]: { ...o[r], title } }));
      patchChat({ ...who, root: r }, { title }).then(
        () => {
          refreshRail();
          if (r === root) reloadState();
        },
        (e: unknown) => {
          setOverrides((o) => ({ ...o, [r]: { ...o[r], ...(o[r]?.title === title ? { title: undefined } : {}) } }));
          sayToast(isApiError(e) ? e.message : 'Could not rename the chat. Try again.');
          refreshRail();
        },
      );
    },
    onPin: (r, pin) => {
      setOverrides((o) => ({ ...o, [r]: { ...o[r], pinned: pin } }));
      patchChat({ ...who, root: r }, { pinned: pin }).then(refreshRail, (e: unknown) => {
        sayToast(isApiError(e) ? e.message : 'Could not pin the chat. Try again.');
        refreshRail();
      });
    },
    onExport: (r) => void exportOne(r),
    onDelete: (r) => {
      setGone((g) => new Set([...g, r]));
      if (r === root) go({ c: null });
      deleteChat({ ...who, root: r }).then(
        () =>
          sayToast('Chat deleted.', {
            ms: 30_000,
            testId: 'chat-deleted',
            undo: async () => {
              try {
                await restoreChat({ ...who, root: r });
                setGone((g) => new Set([...g].filter((x) => x !== r)));
                refreshRail();
              } catch (e) {
                sayToast(isApiError(e) && e.status === 410 ? 'It is too late to bring that chat back.' : 'Could not bring the chat back. Try again.');
              }
            },
          }),
        (e: unknown) => {
          setGone((g) => new Set([...g].filter((x) => x !== r)));
          sayToast(isApiError(e) ? e.message : 'Could not delete the chat. Try again.');
        },
      );
    },
  };

  // ---- keyboard ---------------------------------------------------------------------------------------------------------------------------
  const [help, setHelp] = useState(false);
  const newChat = useCallback((): void => {
    go({ c: null });
    setRailOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-main"] textarea')?.focus());
  }, [go]);

  // ---- the message box: its own commands, and the Up arrow to edit the last message -------------------------------------------------------------
  const [editTick, setEditTick] = useState(0);
  const commands = useMemo<LocalCommand[]>(
    () => [
      { name: 'new', summary: 'Start a new chat', run: () => newChat() },
      { name: 'clear', summary: 'Start a new chat; this one stays in your history', run: () => newChat() },
      {
        name: 'model',
        usage: '/model name',
        summary: 'Choose the model for this chat',
        run: (arg) => {
          const names = options.map((o) => o.label).join(', ');
          if (options.length < 2) return 'This bot has one model only.';
          if (arg === '') return `Now using ${optionFor(options, effective)?.label ?? 'the default'}. You can choose: ${names}.`;
          const hit = options.find((o) => o.alias.toLowerCase() === arg.toLowerCase() || o.label.toLowerCase() === arg.toLowerCase());
          if (!hit) return `There is no model called "${arg}". You can choose: ${names}.`;
          if (!hit.available) return hit.reason ?? `${hit.label} is not available yet.`;
          void pickAlias(hit.alias);
          return `Now using ${hit.label}.`;
        },
      },
      { name: 'export', summary: 'Download this chat as a Markdown file', run: () => (root === null ? 'There is nothing to download yet.' : void exportOne(root)) },
    ],
    [newChat, options, effective, pickAlias, root, exportOne],
  );

  const composer =
    bot && blocked === null ? (
      <Composer
        draftKey={`chat:${botSlug}:${root ?? 'new'}`}
        placeholder={`Message ${botName}`}
        label={`Message ${botName}`}
        channelId={bot.channelId}
        threadRootId={root}
        people={people}
        channelNames={[]}
        voice={false}
        autoFocus={!narrow}
        onSend={(body, o) => onSend(body, o)}
        commands={commands}
        {...(root !== null ? { onEditLast: () => setEditTick((t) => t + 1) } : {})}
      />
    ) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && e.shiftKey && !e.altKey && k === 'o') {
        e.preventDefault();
        newChat();
      } else if (mod && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        setRailOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === 'Escape' && !e.shiftKey && !mod && (live || stopping) && !document.querySelector('[role="dialog"], [role="menu"]')) {
        e.preventDefault();
        void stop();
      } else if (!mod && !e.altKey && !isEditable(e.target) && (k === 'j' || k === 'k') && flat.length > 0) {
        e.preventDefault();
        const at = root === null ? -1 : flat.indexOf(root);
        const next = k === 'j' ? Math.min(flat.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1);
        const target = flat[next];
        if (target) go({ c: target });
      } else if (e.key === '?' && !mod && !isEditable(e.target)) {
        e.preventDefault();
        setHelp(true);
      }
    };
    // Ctrl/Cmd+K and ? are also the app's quick switcher and shortcut sheet, which listen on the document: on this screen they mean the chats' own search and the chats' own
    // shortcuts, so those two are taken first (capture) and the app's listener finds them already handled. Every other key keeps its place in the order.
    const early = (e: KeyboardEvent): void => {
      if (e.key === '?' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k')) onKey(e);
    };
    window.addEventListener('keydown', early, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', early, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [newChat, live, stopping, stop, flat, root, go]);

  // ---- drawing ----------------------------------------------------------------------------------------------------------------------------
  if (bots.status === 'ok' && talkable.length === 0 && known === undefined) {
    return (
      <div className="view-empty" data-testid="chat-no-bot" role="status">
        <p className="view-empty-title">There is no bot to chat with yet.</p>
        <p className="view-empty-body">Ask a team lead to turn one on.</p>
        <Link className="btn" to={`/t/${team}/bots`}>See the bots</Link>
      </div>
    );
  }
  if (opened.status === 'error' && blocked === null) {
    const status = isApiError(opened.error) ? opened.error.status : 0;
    return (
      <div className="view-empty" role="alert" data-testid="chat-unavailable-bot">
        <p className="view-empty-title">{status === 403 ? 'You cannot chat with this bot.' : status === 404 ? 'There is no such bot.' : 'The chat did not open.'}</p>
        <p className="view-empty-body">{status === 403 ? 'Only people on the bot’s team can talk to it.' : opened.error.message}</p>
        <Link className="btn" to={`/t/${team}/bots`}>See the bots</Link>
      </div>
    );
  }

  const title = root === null ? 'New chat' : railTitle({ title: state?.title ?? selectedItem?.title ?? '' });
  const botPicker =
    talkable.length > 1 || (talkable.length === 1 && talkable[0]?.slug !== botSlug) ? (
      <PopMenu
        testId="chat-bot"
        ariaLabel="Bot"
        label={<><Avatar name={botName} kind="agent" avatar={known?.avatar ?? people.botAvatarBySlug(botSlug) ?? null} /> <span>{botName}</span></>}
        items={talkable.map((b) => ({ key: b.slug, label: b.name, hint: b.role, selected: b.slug === botSlug }))}
        onPick={(slug) => go({ bot: slug })}
      />
    ) : (
      <span className="ch-botname" data-testid="chat-bot-name"><Avatar name={botName} kind="agent" avatar={known?.avatar ?? people.botAvatarBySlug(botSlug) ?? null} /> <span>{botName}</span></span>
    );

  const sendingFresh = root === null && pending !== null;
  return (
    <div className={`ch ${narrow ? 'narrow' : ''}`} data-testid="chat-screen" data-bot={botSlug} data-landmark="chat">
      <HistoryRail
        groups={groups}
        selected={root}
        query={typed}
        onQuery={setTyped}
        status={railStatus}
        onRetry={refreshRail}
        more={restNext !== null}
        loadingMore={older.loading}
        onMore={() => void loadOlder()}
        onNew={newChat}
        drawer={narrow ? railOpen : null}
        onClose={() => setRailOpen(false)}
        searchRef={searchRef}
        actions={actions}
      />
      {narrow && railOpen ? <button type="button" className="ch-scrim" aria-label="Close the history" onClick={() => setRailOpen(false)} /> : null}
      <section className="ch-main" data-testid="chat-main" data-landmark="chat-main" aria-label={`Chat with ${botName}`}>
        <PageHeader
          compact
          title={title}
          testIds={{ title: 'chat-title' }}
          actions={
            <div className="ch-head-tools">
              {narrow ? <button type="button" className="icon-btn ch-rail-toggle" aria-label="Show your chats" aria-expanded={railOpen} onClick={() => setRailOpen(true)} data-testid="chat-rail-toggle"><RailIcon /></button> : null}
              {botPicker}
              {modelMenu}
              <button type="button" className="link-btn ch-help" onClick={() => setHelp(true)} data-testid="chat-shortcuts">Shortcuts</button>
            </div>
          }
        />
        {root !== null && channelId !== null ? (
          <ChatColumn
            key={root}
            team={team}
            bot={botSlug}
            botName={botName}
            botAvatar={known?.avatar ?? people.botAvatarBySlug(botSlug)}
            root={root}
            channelId={channelId}
            state={state}
            reloadState={reloadState}
            patchState={patchState}
            preview={preview}
            stopping={stopping}
            onStop={() => void stop()}
            selfActor={people.me?.actorId ?? null}
            pendingText={pending}
            onChanged={refreshRail}
            editSignal={editTick}
            composer={
              <>
                {failed ? (
                  <div className="ch-failed" role="alert" data-testid="chat-send-failed">
                    <Alert>{failed.message}</Alert>
                    <button type="button" className="btn s" onClick={() => void submit(failed.request)}>Send again</button>
                  </div>
                ) : null}
                {blocked ? <p className="ch-blocked" role="status" data-testid="chat-blocked">{blocked.message}</p> : composer}
              </>
            }
          />
        ) : sendingFresh ? (
          <div className="ch-column" data-testid="chat-column">
            <div className="ch-scroll">
              <div className="ch-thread">
                <div className="ch-msg person pending" data-testid="chat-pending"><div className="ch-bubble"><p>{pending}</p></div></div>
                <p className="ch-thinking" data-testid="chat-thinking"><span className="ch-dots" aria-hidden="true" />{botName} is working on it…</p>
              </div>
            </div>
          </div>
        ) : (
          <EmptyChat
            name={session.person.name}
            botName={botName}
            prompts={bot?.prompts ?? []}
            disabled={bot === null || blocked !== null || pending !== null}
            blocked={blocked ? blocked.message : null}
            onPick={(p) => void submit({ body: p, threadRootId: null, ...(picked !== null ? { modelAlias: picked } : {}) })}
          >
            {failed ? (
              <div className="ch-failed" role="alert" data-testid="chat-send-failed">
                <Alert>{failed.message}</Alert>
                <button type="button" className="btn s" onClick={() => void submit(failed.request)}>Send again</button>
              </div>
            ) : null}
            {composer}
          </EmptyChat>
        )}
      </section>
      {help ? (
        <Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)} testId="chat-shortcuts-dialog">
          <dl className="ch-keys">
            {chatShortcuts().map((s) => (
              <div key={s.keys} className="ch-key-row">
                <dt><kbd>{s.keys}</kbd></dt>
                <dd>{s.does}</dd>
              </div>
            ))}
          </dl>
        </Dialog>
      ) : null}
    </div>
  );
}
