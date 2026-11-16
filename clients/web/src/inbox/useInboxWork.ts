import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { WS_RUN_ENDED, WS_RUN_STARTED, WS_TODO_CHANGED, approvalChangedPushType } from '@manythreads/shared';
import { isMockMode } from '../api/setup';
import { realtimeClient } from '../realtime';
import { useApprovalsChanged } from '../screens/approvals/live';
import { fetchBatchApprovals, fetchBatchRuns, fetchBatchTodos } from './api';
import { InboxWork, SLOW_POLL_MS, type RowWork } from './work';

/**
 * The work going on in the listed threads (P29): to-do lists, runs and waiting questions of every row, read in three batches for the page. Live through the pushes the page already
 * hears (a run began or ended, a list changed, a question was raised or answered) and a slow poll while the tab is visible. Returns the reader of one row.
 */
export function useInboxWork(roots: readonly string[]): (root: string) => RowWork {
  const work = useMemo(() => new InboxWork({ runs: fetchBatchRuns, todos: fetchBatchTodos, approvals: fetchBatchApprovals }), []);
  const key = roots.join(',');
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  useEffect(() => {
    if (!isMockMode()) work.setRoots(rootsRef.current);
  }, [work, key]);
  useEffect(() => {
    if (isMockMode()) return;
    const rt = realtimeClient();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') work.refreshSoon();
    }, SLOW_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') work.refreshSoon();
    };
    document.addEventListener('visibilitychange', onVisible);
    const off = [
      rt.onPush((p) => {
        if (p.type === WS_RUN_STARTED || p.type === WS_RUN_ENDED || p.type === WS_TODO_CHANGED || p.type === approvalChangedPushType) work.refreshSoon();
      }),
      rt.onReconnected(() => work.refreshSoon()),
    ];
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      off.forEach((o) => o());
      work.stop();
    };
  }, [work]);
  // a decision made in this tab (and the push that follows it) re-reads at once
  useApprovalsChanged(() => work.refreshSoon());
  useSyncExternalStore(work.subscribe, work.getVersion, work.getVersion);
  return work.of;
}
