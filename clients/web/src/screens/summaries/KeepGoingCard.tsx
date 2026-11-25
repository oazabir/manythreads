import { useMemo } from 'react';
import { Link } from 'react-router';
import { DmIcon, DraftsIcon, HashIcon, LockIcon, ThreadsIcon } from '../../shell/icons';
import { Pill } from '../../shell/Pill';
import { DigestCard } from './DigestCard';
import { keepGoing, type Place } from './summaries';
import type { SummariesData } from './useSummaries';

const markOf = (p: Place) => (p.kind === 'dm' ? <DmIcon /> : p.isPrivate ? <LockIcon /> : <HashIcon />);

/**
 * "Keep going" (P37-06): quick access to the channels and conversations the person is in the middle of, as compact chips: the ones with something new first, then the ones
 * opened lately, then any with a message in the last few days. Unsent drafts, which live in this browser, get a chip of their own.
 */
export function KeepGoingCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const k = data.keepGoing;
  const chips = useMemo(() => keepGoing(k.places, k.recent, now, k.quiet), [k.places, k.recent, now, k.quiet]);
  const base = `/t/${encodeURIComponent(slug)}`;
  const has = chips.length > 0 || k.drafts > 0;
  return (
    <DigestCard
      id="keep-going"
      title="Keep going"
      count={chips.length}
      note={has ? 'Where you were, and where something is new' : ''}
      state={k.ready ? 'ready' : 'loading'}
      onRetry={() => undefined}
      empty={{ icon: ThreadsIcon, title: 'Nothing under way', body: 'Channels and conversations you use show up here, so you can step back in with one press.' }}
      wide
    >
      {has ? (
        <ul className="sm-chips" aria-label="Places to go back to">
          {chips.map((p) => (
            <li key={p.key}>
              <Link to={p.to} className="sm-chip" data-testid="summaries-chip" data-unread={p.unread > 0}>
                <span className="sm-chip-mark" aria-hidden="true">{markOf(p)}</span>
                <span className="sm-chip-label" data-vt-mask>{p.label}</span>
                {p.unread > 0 ? <Pill n={p.unread} tone={p.kind === 'dm' ? 'mention' : 'unread'} note="new" /> : null}
              </Link>
            </li>
          ))}
          {k.drafts > 0 ? (
            <li>
              <Link to={`${base}/drafts`} className="sm-chip" data-testid="summaries-chip-drafts">
                <span className="sm-chip-mark" aria-hidden="true"><DraftsIcon /></span>
                <span className="sm-chip-label">{k.drafts === 1 ? '1 unsent draft' : `${k.drafts} unsent drafts`}</span>
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
    </DigestCard>
  );
}
