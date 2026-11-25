import { useMemo } from 'react';
import { ThreadsIcon } from '../../shell/icons';
import { DigestCard, DigestRowView, RowList } from './DigestCard';
import { recentThreadRows } from './summaries';
import type { SummariesData } from './useSummaries';

/**
 * "Threads you were in lately" (P37-09): the foot of the page, the last ten threads this person opened in this browser, newest first. It is not one of the five cards (it has its
 * own test id, shows up to ten rows and has no "See all"). It reads only the list kept in this browser; the Threads list the page already read adds who wrote last and the
 * reply count where the thread is in it. A row opens the thread; one that is gone shows the normal "not available" page.
 */
export function RecentThreadsCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const inbox = data.threads.status === 'ok' ? data.threads.data.items : undefined;
  const rows = useMemo(() => recentThreadRows(data.recentThreads, slug, now, inbox), [data.recentThreads, slug, now, inbox]);
  return (
    <DigestCard
      id="recent-threads"
      testId="summaries-recent-threads"
      title="Threads you were in lately"
      count={rows.length}
      note={rows.length > 0 ? 'The last ones you opened' : ''}
      state="ready"
      onRetry={() => undefined}
      empty={{ icon: ThreadsIcon, title: 'No threads opened yet', body: 'Threads you open will show up here.' }}
      wide
    >
      {rows.length > 0 ? (
        <RowList label="Threads you opened lately">
          {rows.map((r) => (
            <DigestRowView key={r.key} row={r} />
          ))}
        </RowList>
      ) : null}
    </DigestCard>
  );
}
