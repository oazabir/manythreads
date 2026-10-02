import { memo, useRef, useState } from 'react';
import type { ChannelMessage, FileSummary } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';
import { Avatar } from '../components/ui';
import { MoreIcon, ReplyIcon, SmileIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { clock, fileKind, fileSize } from './format';
import { Markdown } from './Markdown';
import { TOMBSTONE, type PendingSend } from './timeline';
import type { People } from './hooks';

export const QUICK_EMOJI = ['👍', '✅', '🎉', '❤️', '👀', '🚀', '😄', '🙏'] as const;

export function AttachmentCard({ file }: { file: FileSummary }) {
  const kind = fileKind(file.name, file.mime);
  return (
    <a className="att" href={fileContentUrl(file.id)} download={file.name} data-testid="attachment">
      <span className={`ic ${kind.tone}`}>{kind.label}</span>
      <span className="att-text">
        {file.name}
        <small>{fileSize(file.size)}</small>
      </span>
    </a>
  );
}

export type RowActions = {
  openThread?: (rootId: string) => void;
  react: (messageId: string, emoji: string) => void;
  edit: (messageId: string, body: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
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
};

/** One message: avatar, name, time, markdown, attachments, reactions, the reply count, and (on hover) the actions. */
export const MessageRow = memo(function MessageRow({ message: m, teamSlug, people, selfActor, canPost, inThread = false, highlight = false, actions }: Props) {
  const author = people.byActor(m.authorId);
  const name = author?.name ?? 'Someone';
  const own = selfActor !== null && m.authorId === selfActor;
  const deleted = m.deletedAt !== null || m.body === TOMBSTONE;
  const [tapped, setTapped] = useState(false);
  const [menu, setMenu] = useState<null | 'react' | 'more'>(null);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, () => {
    setMenu(null);
    setConfirm(false);
  }, box);
  const canEdit = own && !deleted;
  const canDelete = !deleted && (own || people.canModerate);

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
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,textarea,.acts')) return;
        setTapped((t) => !t);
      }}
    >
      {deleted ? null : (
        <div className="acts" ref={box} role="toolbar" aria-label="Message actions">
          {!inThread && canPost ? (
            <button type="button" className="act" aria-label="Reply in thread" title="Reply in thread" onClick={() => actions.openThread?.(m.id)}><ReplyIcon /></button>
          ) : null}
          {canPost ? (
            <button type="button" className="act" aria-label="Add reaction" aria-expanded={menu === 'react'} aria-haspopup="menu" title="Add reaction" onClick={() => setMenu((x) => (x === 'react' ? null : 'react'))}><SmileIcon /></button>
          ) : null}
          {canEdit || canDelete ? (
            <button type="button" className="act" aria-label="More actions" aria-expanded={menu === 'more'} aria-haspopup="menu" title="More" onClick={() => setMenu((x) => (x === 'more' ? null : 'more'))}><MoreIcon /></button>
          ) : null}
          {menu === 'react' ? (
            <div className="menu emoji-menu" role="menu" aria-label="Reactions">
              {QUICK_EMOJI.map((e) => (
                <button key={e} type="button" role="menuitem" className="emoji" aria-label={`React with ${e}`} onClick={() => { setMenu(null); actions.react(m.id, e); }}>{e}</button>
              ))}
            </div>
          ) : null}
          {menu === 'more' ? (
            <div className="menu more-menu" role="menu" aria-label="Message">
              {canEdit ? <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setEditing(m.body); }}>Edit</button> : null}
              {canDelete ? (
                confirm ? (
                  <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setMenu(null); setConfirm(false); void actions.remove(m.id).catch(() => undefined); }}>Delete message</button>
                ) : (
                  <button type="button" role="menuitem" className="menu-item" onClick={() => setConfirm(true)}>Delete…</button>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <Avatar name={name} />
      <div className="msg-main">
        <div className="who">
          <b>{name}</b>
          <time dateTime={m.createdAt} data-vt-mask>{clock(m.createdAt)}</time>
          {m.editedAt && !deleted ? <span className="edited">(edited)</span> : null}
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
        ) : (
          <div className="txt"><Markdown source={m.body} teamSlug={teamSlug} /></div>
        )}
        {!deleted && m.attachments && m.attachments.length > 0 ? (
          <div className="atts">{m.attachments.map((f) => <AttachmentCard key={f.id} file={f} />)}</div>
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
    </div>
  );
});

/** A message this tab is sending, or that failed: shown in its place with "Not sent · Retry". */
export function PendingRow({ pending, name, onRetry, onDiscard }: { pending: PendingSend; name: string; onRetry: () => void; onDiscard: () => void }) {
  const failed = pending.status === 'failed';
  return (
    <div className={`msg pending ${failed ? 'failed' : ''}`} data-testid="pending-message" data-status={pending.status}>
      <Avatar name={name} />
      <div className="msg-main">
        <div className="who">
          <b>{name}</b>
          <time dateTime={pending.createdAt} data-vt-mask>{clock(pending.createdAt)}</time>
        </div>
        <div className="txt"><Markdown source={pending.body} /></div>
        {pending.attachments.length > 0 ? <div className="atts">{pending.attachments.map((f) => <AttachmentCard key={f.id} file={f} />)}</div> : null}
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
