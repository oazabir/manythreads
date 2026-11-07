import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChannelMessage, ChatThreadState, ChatVote } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { AnswerMessage } from '../../channels/AnswerMessage';
import type { AnswerTools } from '../../channels/AnswerShare';
import { Markdown } from '../../channels/MessageMarkdown';
import { MessageImages } from '../../channels/MessageImages';
import { AttachmentCard } from '../../channels/MessageRow';
import { usePeople, useTimeline } from '../../channels/hooks';
import { splitAttachments } from '../../channels/images';
import { channelStore, threadKey } from '../../channels/store';
import { Avatar } from '../../components/ui';
import { sayToast } from '../../kernel/toast';
import { StopIcon } from '../../shell/icons';
import { chooseVariant, giveFeedback, regenerateTurn } from './api';
import { LookedAt } from './LookedAt';
import { answerStatus, awaitingAnswer, buildRows, neighbourVariant, previewLive, variantPosition, type ChatRow, type Preview } from './model';
import { ReplyActions } from './ReplyActions';

/** How long after the person's message the column says the bot is on it: a run that has not answered by then has failed, and says so in the thread. */
const AWAIT_MS = 3 * 60_000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function PersonMessage({ message, editable, onEdit }: { message: ChannelMessage; editable: boolean; onEdit: () => void }) {
  const attached = splitAttachments(message.attachments);
  return (
    <div className="ch-msg person" data-testid="chat-message" data-role="person" data-message-id={message.id}>
      <div className="ch-bubble">
        <Markdown source={message.body} />
        <MessageImages files={attached.images} />
        {attached.files.length > 0 ? <div className="atts">{attached.files.map((f) => <AttachmentCard key={f.id} file={f} />)}</div> : null}
      </div>
      {editable ? <button type="button" className="link-btn ch-edit" onClick={onEdit} data-testid="chat-edit">Edit and ask again</button> : null}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(body);
    } catch (e) {
      setBusy(false);
      setError(isApiError(e) ? e.message : 'Could not save the change. Try again.');
    }
  };
  return (
    <div className="ch-edit-box" data-testid="chat-edit-box">
      <textarea
        className="ch-edit-text"
        value={text}
        aria-label="Edit your message"
        rows={3}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="ch-edit-actions">
        <button type="button" className="btn primary s" disabled={busy || text.trim() === ''} onClick={() => void save()} data-testid="chat-edit-save">{busy ? 'Saving…' : 'Save and ask again'}</button>
        <button type="button" className="btn s" onClick={onCancel}>Cancel</button>
        {error ? <span className="ch-edit-error" role="alert">{error}</span> : null}
      </div>
    </div>
  );
}

/**
 * One conversation: the person's messages as bubbles on the right, the bot's answers as plain text with the actions under them, the answer being written
 * (from the live frames) at the end, and the message box. The column is at most 760 px wide. Only the chosen answer of a turn is drawn.
 */
export function ChatColumn({ team, bot, botName, botAvatar, root, channelId, state, reloadState, patchState, preview, stopping, onStop, composer, selfActor, pendingText, onChanged, editSignal }: {
  team: string;
  bot: string;
  botName: string;
  botAvatar: string | null | undefined;
  root: string;
  channelId: string;
  state: ChatThreadState | null;
  reloadState: () => void;
  patchState: (fn: (s: ChatThreadState) => ChatThreadState) => void;
  preview: Preview;
  stopping: boolean;
  onStop: () => void;
  composer: ReactNode;
  selfActor: string | null;
  /** The message just sent, drawn at once until the thread has it. */
  pendingText: string | null;
  /** The title, pin or the answers changed: the history reads again. */
  onChanged: () => void;
  /** Counts up each time the person presses Up in an empty message box: the last message of theirs opens for editing. */
  editSignal: number;
}) {
  const people = usePeople();
  const tl = useTimeline(threadKey(root));
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busyTurn, setBusyTurn] = useState<string | null>(null);
  // Another answer was asked for and has not started yet (the run begins a moment after the request): Ask again stays off, so a second click does not start a second run.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => setAsked(false), AWAIT_MS);
    return () => clearTimeout(t);
  }, [asked]);

  useEffect(() => {
    void channelStore.loadThread(root, channelId);
  }, [root, channelId]);

  const rows = useMemo(() => buildRows(tl.root, tl.items, state, selfActor), [tl.root, tl.items, state, selfActor]);
  const newest = tl.items.at(-1)?.id ?? tl.root?.id ?? null;
  const live = previewLive(preview) || (state?.liveRunId ?? null) !== null;
  const busy = live || asked;
  const lastMine = rows.at(-1);
  const waitingOnBot =
    busy || (awaitingAnswer(rows) && lastMine !== undefined && Date.now() - Date.parse(lastMine.message.createdAt) < AWAIT_MS) || pendingText !== null;
  const showPending = pendingText !== null && lastMine?.kind !== 'person';

  // a new message in the thread (the answer, a reply to another turn): the state is read again to know which answers it holds
  const seen = useRef(newest);
  useEffect(() => {
    if (seen.current === newest) return;
    seen.current = newest;
    setAsked(false);
    reloadState();
  }, [newest, reloadState]);

  // read what is on screen
  const threadState = tl.thread;
  useEffect(() => {
    if (!threadState || !newest || document.visibilityState !== 'visible') return;
    if (threadState.lastReadId !== null && threadState.lastReadId >= newest) return;
    const t = setTimeout(() => void channelStore.markRead('thread', root, newest), 400);
    return () => clearTimeout(t);
  }, [threadState, newest, root]);
  useEffect(() => () => channelStore.releaseUnreadHold('thread', root), [root]);

  // stay at the newest words while the reader is at the end
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  });

  const votes = useMemo(() => new Map((state?.feedback ?? []).map((f) => [f.messageId as string, f])), [state?.feedback]);
  const address = { team, bot, root };
  const answerTools: AnswerTools = useMemo(() => ({ channelId, threadRootId: root, team }), [channelId, root, team]);

  const fail = (e: unknown, fallback: string): void => {
    sayToast(isApiError(e) ? e.message : fallback);
  };

  const regenerate = async (turn: string): Promise<void> => {
    if (busyTurn !== null) return;
    setBusyTurn(turn);
    stuck.current = true;
    try {
      await regenerateTurn(address, turn, state?.modelAlias ? { modelAlias: state.modelAlias } : {});
      setAsked(true);
      reloadState();
    } catch (e) {
      fail(e, 'Could not ask again. Try again.');
    } finally {
      setBusyTurn(null);
    }
  };
  const pick = async (turn: string, messageId: string | null): Promise<void> => {
    if (messageId === null) return;
    try {
      await chooseVariant(address, turn, messageId);
      reloadState();
    } catch (e) {
      fail(e, 'Could not switch the answer. Try again.');
    }
  };
  const vote = async (messageId: string, v: ChatVote | null, reason: string): Promise<void> => {
    const before = state;
    patchState((s) => ({ ...s, feedback: [...s.feedback.filter((f) => f.messageId !== messageId), ...(v ? [{ messageId: messageId as never, vote: v, reason }] : [])] }));
    try {
      await giveFeedback({ team, bot }, messageId, v, reason);
    } catch (e) {
      if (before) patchState(() => before);
      fail(e, 'Could not save your vote. Try again.');
    }
  };
  const saveEdit = async (m: ChannelMessage, body: string): Promise<void> => {
    await channelStore.edit(channelId, m.id === root ? null : root, m.id, body);
    await regenerateTurn(address, m.id, state?.modelAlias ? { modelAlias: state.modelAlias } : {});
    setAsked(true);
    setEditing(null);
    reloadState();
    onChanged();
  };

  const lastPerson = [...rows].reverse().find((r) => r.kind === 'person');
  const editableNow = lastPerson !== undefined && !busy && lastPerson.message.authorId === selfActor ? lastPerson.message.id : null;
  const lastSignal = useRef(editSignal);
  useEffect(() => {
    if (editSignal === lastSignal.current) return;
    lastSignal.current = editSignal;
    if (editableNow !== null) setEditing(editableNow);
  }, [editSignal, editableNow]);

  const renderBot = (row: Extract<ChatRow, { kind: 'bot' }>): ReactNode => {
    const m = row.message;
    const turnId = row.turn?.turnMessageId ?? null;
    const f = votes.get(m.id);
    const position = variantPosition(row);
    const own = m.meta.answer?.answeredFor.personId === people.me?.personId;
    return (
      <div className="ch-msg bot" key={m.id} data-testid="chat-message" data-role="bot" data-message-id={m.id} data-stopped={row.variant?.stopped ? 'true' : undefined}>
        <span className="ch-avatar"><Avatar name={botName} kind="agent" avatar={botAvatar ?? null} /></span>
        <div className="ch-body">
          {m.meta.answer ? (
            <AnswerMessage payload={m.meta.answer} teamSlug={team} messageId={m.id} tools={own ? answerTools : undefined} />
          ) : (
            <div className="ch-text"><Markdown source={m.body} teamSlug={team} /></div>
          )}
          {row.variant?.stopped ? <p className="ch-stopped" data-testid="chat-stopped">You stopped this answer.</p> : null}
          {turnId !== null ? (
            <ReplyActions
              position={position}
              vote={f?.vote ?? null}
              reason={f?.reason ?? ''}
              canRegenerate={!busy && busyTurn === null}
              onCopy={() => {
                void copyText(m.body).then((ok) => void sayToast(ok ? 'Copied.' : 'Could not copy. Select the text and copy it.'));
              }}
              onRegenerate={() => void regenerate(turnId)}
              onPrevious={neighbourVariant(row, -1) ? () => void pick(turnId, neighbourVariant(row, -1)) : null}
              onNext={neighbourVariant(row, 1) ? () => void pick(turnId, neighbourVariant(row, 1)) : null}
              onVote={(v, reason) => void vote(m.id, v, reason)}
            />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="ch-column" data-testid="chat-column" data-root-id={root} data-live={live ? 'true' : 'false'}>
      {/* One short line for a screen reader, said when the answer starts and when it is in; the words themselves are not read out as they arrive. */}
      <p className="sr-only" role="status" data-testid="chat-status">
        {answerStatus(waitingOnBot, preview.ended, botName)}
      </p>
      <div
        className="ch-scroll"
        ref={scroller}
        data-testid="chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="ch-thread">
          {tl.status === 'error' && !tl.root ? (
            <p className="ch-note" role="alert" data-testid="chat-unavailable">This chat is not available. It may have been deleted.</p>
          ) : null}
          {tl.status === 'loading' && !tl.root ? <p className="ch-note" aria-busy="true">Loading…</p> : null}
          {rows.map((row) =>
            row.kind === 'person' ? (
              editing === row.message.id ? (
                <EditBox key={row.message.id} initial={row.message.body} onSave={(body) => saveEdit(row.message, body)} onCancel={() => setEditing(null)} />
              ) : (
                <PersonMessage key={row.message.id} message={row.message} editable={!busy && lastPerson === row && row.message.authorId === selfActor} onEdit={() => setEditing(row.message.id)} />
              )
            ) : (
              renderBot(row)
            ),
          )}
          {showPending ? (
            <div className="ch-msg person pending" data-testid="chat-pending"><div className="ch-bubble"><Markdown source={pendingText} /></div></div>
          ) : null}
          {waitingOnBot ? (
            <div className="ch-msg bot live" data-testid="chat-live">
              <span className="ch-avatar"><Avatar name={botName} kind="agent" avatar={botAvatar ?? null} /></span>
              <div className="ch-body">
                <LookedAt labels={preview.looking} />
                {preview.text !== '' ? (
                  <div className="ch-text streaming" data-testid="chat-streaming"><Markdown source={preview.text} teamSlug={team} /></div>
                ) : (
                  <p className="ch-thinking" data-testid="chat-thinking"><span className="ch-dots" aria-hidden="true" />{botName} is working on it…</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="ch-foot">
        {waitingOnBot ? (
          <button type="button" className="btn ch-stop" disabled={stopping} onClick={onStop} data-testid="chat-stop" title="Stop (Esc)">
            <StopIcon /> <span>{stopping ? 'Stopping…' : 'Stop'}</span>
          </button>
        ) : null}
        {composer}
      </div>
    </div>
  );
}
