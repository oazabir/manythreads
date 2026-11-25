import { useMemo } from 'react';
import { notificationTitle } from '../../notifications/store';
import { BellIcon } from '../../shell/icons';
import { DigestCard, DigestRowView, RowList } from './DigestCard';
import { recentActivity, waitingRoots } from './summaries';
import type { SummariesData } from './useSummaries';

/** "Recent activity" (P37-06): what is new for the person and not read yet (mentions, replies, direct messages, invitations), minus what the card of waiting threads already shows. */
export function ActivityCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const bell = data.notifications;
  const threads = data.threads;
  const roots = useMemo(() => (threads.status === 'ok' ? waitingRoots(threads.data.items) : new Set<string>()), [threads]);
  const model = useMemo(
    () => (bell.status === 'ok' ? recentActivity({ slug, now, items: bell.items, shownRoots: roots, titleOf: (n) => notificationTitle(n) }) : null),
    [bell.status, bell.items, slug, now, roots],
  );
  return (
    <DigestCard
      id="activity"
      title="Recent activity"
      count={model?.total ?? null}
      note={model && model.total > 0 ? 'New and not read yet' : ''}
      state={bell.status === 'loading' || (bell.status === 'ok' && threads.status === 'loading') ? 'loading' : bell.status === 'error' ? 'error' : 'ready'}
      onRetry={bell.reload}
      empty={{ icon: BellIcon, title: 'You are all caught up', body: 'New mentions, replies and invitations show up here.' }}
      more={model?.more ?? 0}
      seeAll={[{ label: 'See all activity', to: `/t/${encodeURIComponent(slug)}/activity` }]}
    >
      {model && model.shown.length > 0 ? (
        <RowList label="Recent activity">
          {model.shown.map((r) => (
            <DigestRowView key={r.key} row={r} />
          ))}
        </RowList>
      ) : null}
    </DigestCard>
  );
}
