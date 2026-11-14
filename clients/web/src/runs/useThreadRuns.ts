import { useCallback, useEffect, useSyncExternalStore } from 'react';
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
  const subscribe = useCallback((onChange: () => void) => (rootId === null ? () => undefined : threadRunsStore.subscribe(rootId, onChange)), [rootId]);
  return useSyncExternalStore(subscribe, () => (rootId === null ? NO_STATE : threadRunsStore.stateOf(rootId)));
}

/**
 * The runs of a thread without their answers: the same list object while only the words of an answer grow, so a thread panel does not draw itself again for every
 * piece of an answer (a run card reads its own answer with `useRunAnswer`). Holds the thread open, as `useThreadRuns` does.
 */
export function useThreadRunHeads(rootId: string | null): Pick<ThreadRunsState, 'loaded' | 'runs'> {
  useEffect(() => {
    if (rootId === null || isMockMode()) return;
    return threadRunsStore.open(rootId);
  }, [rootId]);
  const subscribe = useCallback((onChange: () => void) => (rootId === null ? () => undefined : threadRunsStore.subscribe(rootId, onChange)), [rootId]);
  const runs = useSyncExternalStore(subscribe, () => (rootId === null ? NO_STATE : threadRunsStore.stateOf(rootId)).runs);
  const loaded = useSyncExternalStore(subscribe, () => (rootId === null ? NO_STATE : threadRunsStore.stateOf(rootId)).loaded);
  return { loaded, runs };
}

/** The answer a run has written so far (for the faded preview of its card). Only the card that shows it draws again as it grows. */
export function useRunAnswer(rootId: string | null, runId: string): string | undefined {
  const subscribe = useCallback((onChange: () => void) => (rootId === null ? () => undefined : threadRunsStore.subscribe(rootId, onChange)), [rootId]);
  return useSyncExternalStore(subscribe, () => (rootId === null ? undefined : threadRunsStore.stateOf(rootId).answers[runId]));
}

const NO_LINES: RunLines = { items: [], plan: [], loading: false };

/** The lines of one run (its steps), read when the card is opened and again when the run has moved on. */
export function useRunLines(runId: string | null, seq: number): RunLines {
  useEffect(() => {
    if (runId === null || isMockMode()) return;
    void threadRunsStore.loadActivity(runId);
  }, [runId, seq]);
  const subscribe = useCallback((onChange: () => void) => (runId === null ? () => undefined : threadRunsStore.subscribeLines(runId, onChange)), [runId]);
  return useSyncExternalStore(subscribe, () => (runId === null ? NO_LINES : threadRunsStore.linesOf(runId)));
}

/** Reads the active runs of a channel while a page shows its "working" chips, and again after a reconnect. `null` (no channel) and mock mode hold nothing. */
export function useChannelRuns(channelId: string | null): void {
  useEffect(() => {
    if (channelId === null || isMockMode()) return;
    return threadRunsStore.trackChannel(channelId);
  }, [channelId]);
}
