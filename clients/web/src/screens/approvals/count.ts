import { useCallback, useEffect, useState } from 'react';
import { fetchApprovalsSummary } from './api';
import { useApprovalsChanged } from './live';

/** What the sidebar's Approvals badge shows: how many wait, and how many of those have waited past a day (the badge turns amber). */
export interface ApprovalsBadge {
  waiting: number;
  overdue: number;
}

const NONE: ApprovalsBadge = { waiting: 0, overdue: 0 };

/**
 * How many approvals wait in the team: the sidebar's Approvals badge. A server without the approvals plugin answers 404 (or the call fails)
 * and the badge simply shows nothing.
 */
export function useApprovalsWaiting(slug: string | null): ApprovalsBadge {
  const [state, setState] = useState<{ slug: string | null; badge: ApprovalsBadge }>({ slug: null, badge: NONE });
  const load = useCallback(() => {
    if (!slug) return;
    fetchApprovalsSummary(slug).then(
      (s) => setState({ slug, badge: { waiting: s.waiting, overdue: s.overdue } }),
      () => setState({ slug, badge: NONE }),
    );
  }, [slug]);
  useEffect(load, [load]);
  useApprovalsChanged(load);
  return state.slug === slug ? state.badge : NONE;
}
