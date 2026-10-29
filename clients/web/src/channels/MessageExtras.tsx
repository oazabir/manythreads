import { useRef, useState } from 'react';
import type { ChannelMessage, ForwardedMessage } from '@manythreads/shared';
import { clearMessageVersions, fetchMessageVersions } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useDismiss } from '../shell/useDismiss';
import { usePopoverAbove } from '../shell/usePopoverSide';
import { useOpenMessage } from '../shell/messageLink';
import { clock } from './format';
import { versionTime } from './messageActions';

/** The card a forwarded message carries: who wrote the original and an excerpt, if this reader may see it, else only a plain line. */
export function ForwardCard({ card }: { card: ForwardedMessage }) {
  const open = useOpenMessage();
  if (card.state === 'hidden') {
    return <div className="fwd off" data-testid="forward-card" data-state="hidden">You can't see the original message.</div>;
  }
  if (card.state === 'deleted') {
    return <div className="fwd off" data-testid="forward-card" data-state="deleted">The original message was deleted.</div>;
  }
  const where = card.channelName ? `#${card.channelName}` : card.channelKind === 'dm' ? 'a direct message' : 'a conversation';
  return (
    <div className="fwd" data-testid="forward-card" data-state="visible">
      <div className="fwd-head">
        <b>{card.author?.displayName ?? 'Someone'}</b>
        <time dateTime={card.createdAt} data-vt-mask>{clock(card.createdAt)}</time>
        <span className="fwd-where">in {where}</span>
      </div>
      <div className="fwd-text">{card.excerpt}</div>
      <button
        type="button"
        className="link-btn"
        onClick={() => void open({ channelId: card.channelId, channelKind: card.channelKind, channelName: card.channelName, teamId: card.teamId, messageId: card.messageId, threadRootId: card.threadRootId })}
      >
        Open the original
      </button>
    </div>
  );
}

/**
 * "(edited)" as a button: it opens a small list of the earlier versions of the message with the time each was written, oldest first. The
 * author can also clear them (a secret that was pasted and then edited out should not stay in the list).
 */
export function EditedMark({ message, own }: { message: ChannelMessage; own: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <span className="edited-wrap" ref={box}>
      <button type="button" className="edited edited-btn" aria-haspopup="dialog" aria-expanded={open} title="Show earlier versions" onClick={() => setOpen((o) => !o)} data-testid="edited-mark">
        (edited)
      </button>
      {open ? <VersionsPopover message={message} own={own} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function VersionsPopover({ message, own, onClose }: { message: ChannelMessage; own: boolean; onClose: () => void }) {
  // `editedAt` is part of the key: an edit that arrives while the list is open loads it again
  const versions = useQuery(`versions:${message.id}:${message.editedAt ?? ''}`, () => fetchMessageVersions(message.channelId, message.id));
  const [error, setError] = useState<string | null>(null);
  const clear = async (): Promise<void> => {
    try {
      await clearMessageVersions(message.channelId, message.id);
      versions.reload();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not clear the earlier versions.');
    }
  };
  const items = versions.status === 'ok' ? versions.data.items : [];
  const ref = useRef<HTMLDivElement>(null);
  const above = usePopoverAbove(ref);
  return (
    <div ref={ref} className={`vpop ${above ? 'vpop-up' : ''}`} role="dialog" aria-label="Earlier versions" data-testid="versions-popover">
      <div className="vpop-head">
        <b>Earlier versions</b>
        <button type="button" className="link-btn quiet" onClick={onClose}>Close</button>
      </div>
      {versions.status === 'loading' ? <p className="vpop-note">Loading…</p> : null}
      {versions.status === 'error' ? <p className="vpop-note" role="alert">Could not load the earlier versions.</p> : null}
      {versions.status === 'ok' && items.length === 0 ? <p className="vpop-note">No earlier versions are kept.</p> : null}
      {items.length > 0 ? (
        <ol className="vpop-list">
          {items.map((v) => (
            <li key={v.id} className="vpop-item" data-testid="version">
              <time dateTime={v.writtenAt} data-vt-mask>{versionTime(v.writtenAt)}</time>
              <div className="vpop-body">{v.body}</div>
            </li>
          ))}
        </ol>
      ) : null}
      {own && items.length > 0 ? (
        <div className="vpop-foot">
          <button type="button" className="link-btn quiet" onClick={() => void clear()} data-testid="versions-clear">Clear earlier versions</button>
        </div>
      ) : null}
      {error ? <p className="vpop-note" role="alert">{error}</p> : null}
    </div>
  );
}
