import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChannelMessage, FileSummary } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';
import { Avatar } from '../components/ui';
import { MoreIcon, ReplyIcon, SmileIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { usePopoverAbove } from '../shell/usePopoverSide';
import { AnswerMessage } from './AnswerMessage';
import { ForwardDialog } from './ForwardDialog';
import { EditedMark, ForwardCard } from './MessageExtras';
import { copyText, messageLinkUrl } from './messageActions';
import type { AnswerTools } from './AnswerShare';
import { clock, fileKind, fileSize } from './format';
import { splitAttachments } from './images';
import { Markdown } from './MessageMarkdown';
import { MessageImages } from './MessageImages';
import { TOMBSTONE, type PendingSend } from './timeline';
import type { People } from './hooks';

export const QUICK_EMOJI = ['👍', '✅', '🎉', '❤️', '👀', '🚀', '😄', '🙏'] as const;

export function AttachmentCard({ file }: { file: FileSummary }) {
  const kind = fileKind(file.name, file.mime);
  return (
    <a className="att" href={fileContentUrl(file.id)} download={file.name} data-testid="attachment" data-landmark="attachment">
      <span className={`ic ${kind.tone}`}>{kind.label}</span>
      <span className="att-text">
        {file.name}
        <small>{fileSize(file.size)}</small>
      </span>
    </a>
  );
}

/** A menu under the row's toolbar; it opens upward when it would not fit above the end of the list (the newest messages sit at the composer). */
function RowMenu({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const above = usePopoverAbove(ref);
  return (
    <div ref={ref} className={`menu ${className} ${above ? 'menu-up' : ''}`} role="menu" aria-label={label}>
      {children}
    </div>
  );
}

/** The one row that shows "Marked unread from here": a second mark, anywhere in this tab, takes it from the first. */
const MARKED_UNREAD = 'Marked unread from here';
const MARK_EVENT = 'mt:marked-unread';

export type RowActions = {
  openThread?: (rootId: string) => void;
  react: (messageId: string, emoji: string) => void;
  edit: (messageId: string, body: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  /** "Mark unread from here": the reader's position goes back to just before the message. Absent where the view has no read position of its own. */
  markUnread?: (messageId: string) => Promise<void>;
};

type Props = {
  message: ChannelMessage;
  teamSlug: string | null;
  people: People;
  /** The reader's actor id: the message is theirs when it matches. */
  selfActor: string | null;
  canPost: boolean;
  /** Inside a thread: no reply count, no "reply" action. */
  inThread?: boolean;
  highlight?: boolean;
  actions: RowActions;
  /** Set in the reader's own conversation with a bot: an Answer in it that was for them can be shared, saved as a page and handed on (P5-17). */
  answerTools?: AnswerTools;
};

/** One message: avatar, name, time, markdown, attachments, reactions, the reply count, and (on hover) the actions. */
export const MessageRow = memo(function MessageRow({ message: m, teamSlug, people, selfActor, canPost, inThread = false, highlight = false, actions, answerTools }: Props) {
  // the roster knows the team's people; the server names the author of every message the reader can read (a guest has no roster)
  const name = people.byActor(m.authorId)?.name ?? m.author?.displayName ?? 'Someone';
  const own = selfActor !== null && m.authorId === selfActor;
  const deleted = m.deletedAt !== null || m.body === TOMBSTONE;
  const [tapped, setTapped] = useState(false);
  // the toolbar exists only while the row is under the pointer or has focus: 5,000 rows do not each carry three buttons
  const [hot, setHot] = useState(false);
  const [menu, setMenu] = useState<null | 'react' | 'more'>(null);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);
  // a short line in the header of the row after an action that has no other sign ("Link copied")
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 2_500);
    return () => clearTimeout(t);
  }, [done]);
  // another row was marked unread after this one: only the latest mark says so
  useEffect(() => {
    const onMark = (e: Event): void => {
      if ((e as CustomEvent<string>).detail !== m.id) setDone((d) => (d === MARKED_UNREAD ? null : d));
    };
    window.addEventListener(MARK_EVENT, onMark);
    return () => window.removeEventListener(MARK_EVENT, onMark);
  }, [m.id]);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, () => {
    setMenu(null);
    setConfirm(false);
  }, box);
  // a message that carries an Answer is deleted and shared again, never edited (the server answers 409): its text is the payload's body
  const canEdit = own && !deleted && m.meta.answer === undefined;
  const canDelete = !deleted && (own || people.canModerate);
  // an image is drawn as a picture, not as a file card; a message may carry both kinds at once
  const attached = splitAttachments(m.attachments);
  const markUnread = async (): Promise<void> => {
    try {
      await actions.markUnread?.(m.id);
      window.dispatchEvent(new CustomEvent(MARK_EVENT, { detail: m.id }));
      setDone(MARKED_UNREAD);
    } catch {
      setDone('Could not mark it unread');
    }
  };
  const copyLink = async (): Promise<void> => {
    const ok = await copyText(messageLinkUrl(window.location.origin, { channelId: m.channelId, messageId: m.id, threadRootId: m.threadRootId }));
    setDone(ok ? 'Link copied' : 'Could not copy the link');
  };

  const save = async (): Promise<void> => {
    const body = (editing ?? '').trim();
    if (body === '' || body === m.body) return setEditing(null);
    try {
      await actions.edit(m.id, body);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  return (
    <div
      className={`msg ${highlight ? 'hl' : ''} ${tapped ? 'tapped' : ''} ${deleted ? 'gone' : ''}`}
      data-testid="message"
      data-message-id={m.id}
      tabIndex={0}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHot(false);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,textarea,.acts,.dlg-scrim,.vpop')) return;
        setTapped((t) => !t);
      }}
    >
      {deleted || !(hot || tapped || menu !== null) ? null : (
        <div className="acts" ref={box} role="toolbar" aria-label="Message actions">
          {!inThread && canPost ? (
            <button type="button" className="act" aria-label="Reply in thread" title="Reply in thread" onClick={() => actions.openThread?.(m.id)}><ReplyIcon /></button>
          ) : null}
          {canPost ? (
            <button type="button" className="act" aria-label="Add reaction" aria-expanded={menu === 'react'} aria-haspopup="menu" title="Add reaction" onClick={() => setMenu((x) => (x === 'react' ? null : 'react'))}><SmileIcon /></button>
          ) : null}
          {!deleted ? (
            <button type="button" className="act" aria-label="More actions" aria-expanded={menu === 'more'} aria-haspopup="menu" title="More" onClick={() => setMenu((x) => (x === 'more' ? null : 'more'))}><MoreIcon /></button>
          ) : null}
          {menu === 'react' ? (
            <RowMenu className="emoji-menu" label="Reactions">
              {QUICK_EMOJI.map((e) => (
                <button key={e} type="button" role="menuitem" className="emoji" aria-label={`React with ${e}`} onClick={() => { setMenu(null); actions.react(m.id, e); }}>{e}</button>
              ))}
            </RowMenu>
          ) : null}
          {menu === 'more' ? (
            <RowMenu className="more-menu" label="Message">
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); void copyLink(); }}>Copy link</button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setForwarding(true); }}>Forward…</button>
              {actions.markUnread ? (
                <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); void markUnread(); }}>Mark unread from here</button>
              ) : null}
              {canEdit ? <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setEditing(m.body); }}>Edit</button> : null}
              {canDelete ? (
                confirm ? (
                  <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setMenu(null); setConfirm(false); void actions.remove(m.id).catch(() => undefined); }}>Delete message</button>
                ) : (
                  <button type="button" role="menuitem" className="menu-item" onClick={() => setConfirm(true)}>Delete…</button>
                )
              ) : null}
            </RowMenu>
          ) : null}
        </div>
      )}
      <Avatar name={name} kind={m.author?.kind === 'bot' || m.author?.kind === 'system' ? 'agent' : 'person'} />
      <div className="msg-main">
        <div className="who">
          <b>{name}</b>
          {m.author?.kind === 'system' ? <span className="wh-mark" title="Posted by an incoming webhook, not by a person">Webhook</span> : null}
          <time dateTime={m.createdAt} data-vt-mask>{clock(m.createdAt)}</time>
          {m.editedAt && !deleted ? <EditedMark message={m} own={own} /> : null}
          {done ? <span className="row-done" role="status">{done}</span> : null}
        </div>
        {deleted ? (
          <div className="txt tomb">This message was deleted.</div>
        ) : editing !== null ? (
          <div className="edit-box">
            <textarea
              aria-label="Edit message"
              value={editing}
              rows={Math.min(8, editing.split('\n').length + 1)}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
              autoFocus
            />
            <div className="edit-actions">
              <button type="button" className="btn primary s" onClick={() => void save()}>Save</button>
              <button type="button" className="btn s" onClick={() => setEditing(null)}>Cancel</button>
              {error ? <span className="edit-error" role="alert">{error}</span> : null}
            </div>
          </div>
        ) : m.meta.answer ? (
          // a bot's Answer: the text with its numbered sources, lineage, what was reached and what was out of scope (P5-18)
          <AnswerMessage
            payload={m.meta.answer}
            teamSlug={teamSlug}
            messageId={m.id}
            tools={answerTools !== undefined && m.channelId === answerTools.channelId && m.meta.answer.answeredFor.personId === people.me?.personId ? answerTools : undefined}
          />
        ) : (
          <div className="txt"><Markdown source={m.body} teamSlug={teamSlug} /></div>
        )}
        {!deleted && m.forward ? <ForwardCard card={m.forward} /> : null}
        {!deleted && m.alsoSentFromThread ? (
          <button type="button" className="link-btn also-from" data-testid="also-from-thread" onClick={() => actions.openThread?.(m.alsoSentFromThread!)}>
            Also sent from a thread · View thread
          </button>
        ) : null}
        {deleted ? null : <MessageImages files={attached.images} />}
        {!deleted && attached.files.length > 0 ? (
          <div className="atts">{attached.files.map((f) => <AttachmentCard key={f.id} file={f} />)}</div>
        ) : null}
        {!deleted && m.reactions.length > 0 ? (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`rx ${r.mine ? 'mine' : ''}`}
                aria-pressed={r.mine}
                aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
                disabled={!canPost}
                onClick={() => actions.react(m.id, r.emoji)}
              >
                <span aria-hidden="true">{r.emoji}</span> <span className="rx-n" data-vt-mask>{r.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {!inThread && m.replyCount > 0 ? (
          <button type="button" className="replies" onClick={() => actions.openThread?.(m.id)}>
            {m.replyCount === 1 ? '1 reply' : `${m.replyCount} replies`}
            {m.lastReplyAt ? <span className="last" data-vt-mask>{` · last ${clock(m.lastReplyAt)}`}</span> : null}
          </button>
        ) : null}
      </div>
      {forwarding ? <ForwardDialog message={m} selfPersonId={people.me?.personId ?? null} onClose={() => setForwarding(false)} onDone={(label) => setDone(`Forwarded to ${label}`)} /> : null}
    </div>
  );
});

/** A message this tab is sending, or that failed: shown in its place with "Not sent · Retry". */
export function PendingRow({ pending, name, onRetry, onDiscard }: { pending: PendingSend; name: string; onRetry: () => void; onDiscard: () => void }) {
  const failed = pending.status === 'failed';
  const attached = splitAttachments(pending.attachments);
  return (
    <div className={`msg pending ${failed ? 'failed' : ''}`} data-testid="pending-message" data-status={pending.status}>
      <Avatar name={name} />
      <div className="msg-main">
        <div className="who">
          <b>{name}</b>
          <time dateTime={pending.createdAt} data-vt-mask>{clock(pending.createdAt)}</time>
        </div>
        <div className="txt"><Markdown source={pending.body} /></div>
        <MessageImages files={attached.images} />
        {attached.files.length > 0 ? <div className="atts">{attached.files.map((f) => <AttachmentCard key={f.id} file={f} />)}</div> : null}
        {failed ? (
          <div className="send-state" role="alert">
            <span>{'Not sent · '}</span>
            <button type="button" className="link-btn" onClick={onRetry}>Retry</button>
            <button type="button" className="link-btn quiet" onClick={onDiscard}>Discard</button>
          </div>
        ) : (
          <div className="send-state sending">Sending…</div>
        )}
      </div>
    </div>
  );
}
