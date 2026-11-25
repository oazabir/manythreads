import { useMemo } from 'react';
import { ThreadsIcon } from '../../shell/icons';
import { DigestCard, DigestRowView, RowList } from './DigestCard';
import { waitingThreads } from './summaries';
import type { SummariesData } from './useSummaries';

/** "Waiting on your reply" (P37-06): the threads where somebody asked for the person's answer, then the threads with new replies. A row opens the thread. */
export function WaitingCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const q = data.threads;
  const items = q.status === 'ok' ? q.data.items : null;
  const model = useMemo(() => (items ? waitingThreads(items, slug, now) : null), [items, slug, now]);
  const asked = items ? items.filter((i) => i.mention).length : 0;
  return (
    <DigestCard
      id="waiting"
      title="Waiting on your reply"
      count={model?.total ?? null}
      note={asked > 0 ? `${asked} asked for you by name` : model && model.total > 0 ? 'New replies since you last looked' : ''}
      state={q.status === 'loading' ? 'loading' : q.status === 'error' ? 'error' : 'ready'}
      onRetry={q.reload}
      empty={{ icon: ThreadsIcon, title: 'No one is waiting on you', body: 'Threads where someone asks for your answer show up here.' }}
      more={model?.more ?? 0}
      seeAll={[{ label: 'See all threads', to: `/t/${encodeURIComponent(slug)}/threads` }]}
    >
      {model && model.shown.length > 0 ? (
        <RowList label="Threads waiting on your reply">
          {model.shown.map((r) => (
            <DigestRowView key={r.key} row={r} />
          ))}
        </RowList>
      ) : null}
    </DigestCard>
  );
}
