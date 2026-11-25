import { useMemo } from 'react';
import { ApprovalsIcon } from '../../shell/icons';
import { todayIso } from '../files/actionItems/actionItemsWords';
import { DigestCard, DigestRowView, RowList } from './DigestCard';
import { attention } from './summaries';
import type { SummariesData } from './useSummaries';

/**
 * "Needs your attention today" (P37-06): the person's open action items, the requests waiting for their answer and the action items a meeting gave them, in one list,
 * the late and the long-waiting first. It reads three sources; one that fails is said so above the rows, the others still show.
 */
export function AttentionCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const { actionItems, approvals, notifications } = data;
  const sources = [actionItems, approvals, notifications];
  const loading = sources.some((s) => s.status === 'loading');
  const failed = sources.filter((s) => s.status === 'error');
  const state = loading ? 'loading' : failed.length === sources.length ? 'error' : 'ready';
  const model = useMemo(
    () =>
      attention({
        slug,
        now,
        today: todayIso(now),
        actionItems: actionItems.status === 'ok' ? actionItems.data.items : [],
        approvals: approvals.status === 'ok' ? approvals.data.items : [],
        meetingNotes: notifications.status === 'ok' ? notifications.items.filter((n) => n.kind === 'meeting_actions' && n.readAt === null) : [],
      }),
    [slug, now, actionItems, approvals, notifications],
  );
  const retry = (): void => {
    for (const s of failed) s.reload();
  };
  return (
    <DigestCard
      id="attention"
      title="Needs your attention today"
      count={model.rows.total}
      note={model.summary}
      state={state}
      onRetry={retry}
      empty={{ icon: ApprovalsIcon, title: 'Nothing needs you today', body: 'Your action items, requests to answer and notes from meetings show up here.' }}
      more={model.rows.more}
      seeAll={[
        { label: 'See all action items', to: '/account/action-items' },
        ...(model.counts.approvals > 0 ? [{ label: 'Open approvals', to: `/t/${encodeURIComponent(slug)}/approvals` }] : []),
      ]}
      problem={failed.length > 0 && failed.length < sources.length ? { text: 'Some of this could not be loaded.', onRetry: retry } : null}
    >
      {model.rows.shown.length > 0 ? (
        <RowList label="Needs your attention">
          {model.rows.shown.map((r) => (
            <DigestRowView key={r.key} row={r} />
          ))}
        </RowList>
      ) : null}
    </DigestCard>
  );
}
