import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ApprovalChangedPush, RunEndedPush, RunStartedPush, TodoChangedPush, WS_RUN_ENDED, WS_RUN_STARTED, WS_TODO_CHANGED, approvalChangedPushType } from '@manythreads/shared';
import { isMockMode } from '../api/setup';
import { realtimeClient } from '../realtime';
import { useApprovalsChanged } from '../screens/approvals/live';
import { fetchBatchApprovals, fetchBatchRuns, fetchBatchTodos } from './api';
import { InboxWork, SLOW_POLL_MS, type RowWork } from './work';

/** The thread root a push is about, or undefined for a push the work does not care about. */
function rootOfPush(p: { type: string; payload: unknown }): string | null | undefined {
  switch (p.type) {
    case WS_RUN_STARTED: {
      const r = RunStartedPush.safeParse(p.payload);
      return r.success ? r.data.threadRootId : undefined;
    }
    case WS_RUN_ENDED: {
      const r = RunEndedPush.safeParse(p.payload);
      return r.success ? r.data.threadRootId : undefined;
    }
    case WS_TODO_CHANGED: {
      const r = TodoChangedPush.safeParse(p.payload);
      return r.success ? r.data.rootId : undefined;
    }
    case approvalChangedPushType: {
      const r = ApprovalChangedPush.safeParse(p.payload);
      return r.success ? (r.data.threadRootId ?? null) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The work going on in the listed threads (P29): to-do lists, runs and waiting questions of every row, read in three batches for the page. Live through the pushes the page already
 * hears (a run began or ended, a list changed, a question was raised or answered) and a slow poll while the tab is visible and a run is going in a listed row. A push about a thread that is not listed is ignored. Returns the reader of one row.
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
      if (document.visibilityState === 'visible' && work.anyRunning()) work.refreshSoon();
    }, SLOW_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') work.refreshSoon();
    };
    document.addEventListener('visibilitychange', onVisible);
    const off = [
      // only a push about a thread the page lists reads again (a busy team sends many about the others)
      rt.onPush((p) => {
        if (rootOfPush(p) !== undefined && work.has(rootOfPush(p))) work.refreshSoon();
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
