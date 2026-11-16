import type { Approval } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { ApprovalCard } from './ApprovalCard';
import { fetchThreadApprovals } from './api';
import { useApprovalsChanged, usePollWhileQueued } from './live';
import { callInFlight } from './state';

/**
 * The approvals a thread raised (SPEC §7.3), read once per open thread: the dock above the composer draws the pending ones, the strip under the replies draws what
 * is settled. A server without the approvals plugin answers 404 and the thread shows nothing extra; so does a thread nothing was raised in. The list is read again
 * when the server says approvals changed (a push), never on a timer, except while an approved call is still queued.
 */
export function useThreadApprovals(rootId: string): { status: 'loading' | 'ok' | 'error'; items: readonly Approval[]; reload: () => void } {
  const q = useQuery(`thread-approvals:${rootId}`, () => fetchThreadApprovals(rootId));
  useApprovalsChanged(q.reload);
  usePollWhileQueued(q.status === 'ok' && q.data.items.some((a) => callInFlight(a)), q.reload);
  return { status: q.status, items: q.status === 'ok' ? q.data.items : NONE, reload: q.reload };
}

const NONE: readonly Approval[] = [];

/** The approvals as cards under the thread's replies, leaving out the ones drawn elsewhere (`hide`: the dock's pending questions, a run card's question). */
export function ThreadApprovals({ items, reload, slug, hide }: { items: readonly Approval[]; reload: () => void; slug: string | null; /** Approvals drawn somewhere else: left out here. */ hide?: (a: Approval) => boolean }) {
  const shown = items.filter((a) => hide === undefined || !hide(a));
  if (shown.length === 0 || !slug) return null;
  return (
    <div className="apr-thread" data-testid="thread-approvals">
      {shown.map((a) => (
        <ApprovalCard key={a.id} approval={a} slug={slug} variant="thread" onDecided={reload} />
      ))}
    </div>
  );
}
