import type { Approval } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { ApprovalCard } from './ApprovalCard';
import { fetchThreadApprovals } from './api';
import { useApprovalsChanged, usePollWhileQueued } from './live';
import { callInFlight } from './state';

/**
 * The approvals a thread raised, as cards under its replies (SPEC §7.3: a run that stopped for a person says so where it was asked). A server
 * without the approvals plugin answers 404 and the thread shows nothing extra; so does a thread nothing was raised in.
 */
export function ThreadApprovals({ rootId, slug, hide }: { rootId: string; slug: string | null; /** Approvals a run card already shows (a bot's question while its run waits): the strip leaves them out, so a question is asked in one place. */ hide?: (a: Approval) => boolean }) {
  const q = useQuery(`thread-approvals:${rootId}`, () => fetchThreadApprovals(rootId));
  useApprovalsChanged(q.reload);
  usePollWhileQueued(q.status === 'ok' && q.data.items.some((a) => callInFlight(a)), q.reload);
  const items = q.status === 'ok' ? q.data.items.filter((a) => hide === undefined || !hide(a)) : [];
  if (q.status !== 'ok' || items.length === 0 || !slug) return null;
  return (
    <div className="apr-thread" data-testid="thread-approvals">
      {items.map((a) => (
        <ApprovalCard key={a.id} approval={a} slug={slug} variant="thread" onDecided={q.reload} />
      ))}
    </div>
  );
}
