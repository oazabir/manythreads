import { useEffect, useSyncExternalStore } from 'react';
import { isMockMode } from '../api/setup';
import { threadRunsStore } from './store';
import type { RunLines, ThreadRunsState } from './threadRuns';

const NO_STATE: ThreadRunsState = { loaded: false, runs: [], answers: {} };

/**
 * The runs of the thread a panel shows, live. Holds the "I have this thread open" lease while the panel is mounted. `null` (no thread) and mock mode (no server) hold
 * nothing and answer no runs.
 */
export function useThreadRuns(rootId: string | null): ThreadRunsState {
  useEffect(() => {
    if (rootId === null || isMockMode()) return;
    return threadRunsStore.open(rootId);
  }, [rootId]);
  return useSyncExternalStore(
    (onChange) => (rootId === null ? () => undefined : threadRunsStore.subscribe(rootId, onChange)),
    () => (rootId === null ? NO_STATE : threadRunsStore.stateOf(rootId)),
  );
}

const NO_LINES: RunLines = { items: [], plan: [], loading: false };

/** The lines of one run (its steps), read when the card is opened and again when the run has moved on. */
export function useRunLines(runId: string | null, seq: number): RunLines {
  useEffect(() => {
    if (runId === null || isMockMode()) return;
    void threadRunsStore.loadActivity(runId);
  }, [runId, seq]);
  return useSyncExternalStore(
    (onChange) => (runId === null ? () => undefined : threadRunsStore.subscribeLines(runId, onChange)),
    () => (runId === null ? NO_LINES : threadRunsStore.linesOf(runId)),
  );
}
