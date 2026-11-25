import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ActorAvatar } from '../../components/ActorAvatar';
import { EmptyState, type EmptyStateIcon } from '../../components/EmptyState';
import { SkeletonRows } from '../../components/Skeleton';
import { ActionItemIcon, ApprovalsIcon, BellIcon, LiveCallIcon, MeetingNotesIcon, NextIcon, ScheduleNavIcon, ThreadsIcon } from '../../shell/icons';
import type { DigestRow, RowKind } from './summaries';

/*
 * The card every section of the Summaries page is drawn in (P37-06): a title with its count, one muted line under it, the rows (at most five), a "See all" link to
 * the screen that owns them, and the three states a source can be in: loading (grey rows), failed (a plain sentence and Try again, only in this card) and empty (a friendly
 * line that says why that is good news). Rows are whole-row links; a row may carry one button of its own (Join).
 */

const MARKS: Record<RowKind, EmptyStateIcon> = {
  action: ActionItemIcon,
  approval: ApprovalsIcon,
  meeting: MeetingNotesIcon,
  thread: ThreadsIcon,
  note: BellIcon,
  event: ScheduleNavIcon,
  live: LiveCallIcon,
};

/** One row: the mark (or the face of who it is from), the title, one muted line, a tag, and the row's own button if it has one. */
export function DigestRowView({ row, action }: { row: DigestRow; action?: ReactNode }) {
  const Mark = MARKS[row.kind];
  return (
    <li className="sm-row" data-testid="summaries-row" data-kind={row.kind}>
      <Link to={row.to} className="sm-row-link">
        <span className={`sm-mark ${row.avatar ? 'face' : `k-${row.kind}`}`} aria-hidden="true">
          {row.avatar ? <ActorAvatar actorId={row.avatar.actorId} name={row.avatar.name} /> : <Mark />}
        </span>
        <span className="sm-row-text">
          <span className="sm-row-title" data-vt-mask>{row.title}</span>
          <span className="sm-row-meta" data-vt-mask>{row.meta}</span>
        </span>
        {row.tag ? <span className={`sm-tag ${row.tag.tone}`}>{row.tag.text}</span> : null}
      </Link>
      {action}
    </li>
  );
}

export interface SeeAll {
  label: string;
  to: string;
}

export interface CardEmpty {
  icon: EmptyStateIcon;
  title: string;
  body: string;
}

export function DigestCard({
  id,
  title,
  count,
  note,
  state,
  onRetry,
  empty,
  seeAll = [],
  more = 0,
  children,
  wide = false,
  problem,
}: {
  /** Names the card for the tests and the screen reader: `attention`, `waiting`, `activity`, `next`, `keep-going`. */
  id: string;
  title: string;
  /** The big number; null while it is not known. */
  count: number | null;
  /** One muted line under the title. */
  note?: string;
  state: 'loading' | 'error' | 'ready';
  onRetry: () => void;
  /** Shown when the card is ready and has no rows (`children` is null). */
  empty: CardEmpty;
  seeAll?: readonly SeeAll[];
  /** How many rows there are beyond the ones drawn; the footer says so. */
  more?: number;
  /** The rows (a list), or null for none. */
  children: ReactNode;
  wide?: boolean;
  /** A line above the rows: one part of the card could not be read, or a Join failed. */
  problem?: { text: string; onRetry?: () => void } | null;
}) {
  const headingId = `sm-${id}-title`;
  return (
    <section className={`sm-card ${wide ? 'wide' : ''}`} aria-labelledby={headingId} data-testid="summaries-card" data-card={id}>
      <header className="sm-card-head">
        <div className="sm-card-titles">
          <h2 className="sm-card-title" id={headingId}>{title}</h2>
          {note && state === 'ready' ? <p className="sm-card-note" data-vt-mask>{note}</p> : null}
        </div>
        {count !== null && state === 'ready' ? <span className="sm-count" data-testid="summaries-count"><span aria-hidden="true">{count}</span><span className="sr-only">{`${count} in all`}</span></span> : null}
      </header>
      {state === 'loading' ? (
        <SkeletonRows rows={3} label={`Loading ${title.toLowerCase()}`} />
      ) : state === 'error' ? (
        <div className="sm-problem" role="status" data-testid="summaries-error">
          <p>This could not be loaded just now.</p>
          <button type="button" className="btn s" onClick={onRetry}>Try again</button>
        </div>
      ) : (
        <>
          {problem ? (
            <p className="sm-problem-line" role="status">
              {problem.text}
              {problem.onRetry ? <> <button type="button" className="link-btn" onClick={problem.onRetry}>Try again</button></> : null}
            </p>
          ) : null}
          {children ?? (
            <div className="sm-empty">
              <EmptyState icon={empty.icon} title={empty.title} testId={`summaries-empty-${id}`}>{empty.body}</EmptyState>
            </div>
          )}
          {seeAll.length > 0 && state === 'ready' ? (
            <footer className="sm-card-foot">
              {more > 0 ? <span className="sm-more" data-testid="summaries-more">{`${more} more not shown`}</span> : null}
              {seeAll.map((l) => (
                <Link key={l.to + l.label} to={l.to} className="sm-see-all" data-testid="summaries-see-all">
                  {l.label}
                  <NextIcon />
                </Link>
              ))}
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The rows of a card as a list. */
export function RowList({ label, children }: { label: string; children: ReactNode }) {
  return <ul className="sm-rows" aria-label={label}>{children}</ul>;
}
