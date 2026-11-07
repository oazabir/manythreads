import { useId, useRef, useState } from 'react';
import { LockIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import type { FileRow, ReadOnlyReason } from './model';

/** What a file that cannot be changed says about why, in words. `title` is the tooltip; `body` is what the popover explains. */
export const WHY: Readonly<Record<ReadOnlyReason, { title: string; body: string }>> = {
  change_by_pull_request: {
    title: 'Changes go through a proposal',
    body: 'Files here are changed by a proposal. Open the file and choose “Propose a change”. A team lead or workspace admin applies it.',
  },
  no_write_access: {
    title: 'You can read this, not change it',
    body: 'You can read this file, but you do not have permission to change it. Ask a team lead if you need to.',
  },
  attachment: {
    title: 'Posted files do not change in place',
    body: 'A file posted in a channel cannot be edited. Download it, change it, and post the new one.',
  },
  admin_view: {
    title: 'Read-only view',
    body: 'You are looking at this person’s Personal space in read-only mode. Nothing here can be changed or downloaded for editing.',
  },
};

/** The reason a row gives for being locked, or null when a lock should not be drawn (an attachment is never edited in place, so it shows no lock). */
export function lockReason(row: Pick<FileRow, 'readOnly' | 'readOnlyReason'>): ReadOnlyReason | null {
  if (!row.readOnly || row.readOnlyReason === null || row.readOnlyReason === 'attachment') return null;
  return row.readOnlyReason;
}

/**
 * The lock beside a file that cannot be changed. As an icon it carries the reason as a tooltip and opens a short popover on a click; as a link
 * ("Why can't I edit?") it sits under a file's note. Either one closes with Esc or a click outside.
 */
export function WhyReadOnly({ reason, look = 'icon' }: { reason: ReadOnlyReason; look?: 'icon' | 'link' }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  useDismiss(open, () => setOpen(false), box);
  const why = WHY[reason];
  return (
    <span className={`fwhy ${look}`} ref={box} data-stop onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {look === 'icon' ? (
        <button type="button" className="flock" title={why.title} aria-label={`${why.title}. Why?`} aria-expanded={open} aria-controls={open ? id : undefined} data-testid="why-readonly" onClick={() => setOpen((o) => !o)}>
          <LockIcon />
        </button>
      ) : (
        <button type="button" className="flinkish" aria-expanded={open} aria-controls={open ? id : undefined} data-testid="why-readonly" onClick={() => setOpen((o) => !o)}>
          Why can’t I edit?
        </button>
      )}
      {open ? (
        <span className="fwhy-pop" id={id} role="note" data-testid="why-readonly-pop">
          <b>{why.title}</b>
          <span>{why.body}</span>
        </span>
      ) : null}
    </span>
  );
}
