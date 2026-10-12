import { useCallback, useEffect, useState } from 'react';
import { fetchApprovalsSummary } from './api';
import { useApprovalsChanged } from './live';

/**
 * How many approvals wait in the team: the sidebar's Approvals badge. A server without the approvals plugin answers 404 (or the call fails)
 * and the badge simply shows nothing.
 */
export function useApprovalsWaiting(slug: string | null): number {
  const [state, setState] = useState<{ slug: string | null; waiting: number }>({ slug: null, waiting: 0 });
  const load = useCallback(() => {
    if (!slug) return;
    fetchApprovalsSummary(slug).then(
      (s) => setState({ slug, waiting: s.waiting }),
      () => setState({ slug, waiting: 0 }),
    );
  }, [slug]);
  useEffect(load, [load]);
  useApprovalsChanged(load);
  return state.slug === slug ? state.waiting : 0;
}
