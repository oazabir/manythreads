import { useSyncExternalStore } from 'react';

/*
 * How much of a run a person wants to see (docs/plans/acp.md section 5.2), kept per person in the browser:
 *  - summary: the card is its header and the now line only;
 *  - progress (the default): the card of section 5.1, with the plan line, the work log and the answer so far;
 *  - trace: the progress card with its step list already open.
 * Storage may be missing (a private window): the choice then lasts until the tab closes.
 */

export type RunView = 'summary' | 'progress' | 'trace';
export const RUN_VIEWS: readonly RunView[] = ['summary', 'progress', 'trace'];
const KEY = 'mt.runView';

let current: RunView = read();
const listeners = new Set<() => void>();

function read(): RunView {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return RUN_VIEWS.find((x) => x === v) ?? 'progress';
  } catch {
    return 'progress';
  }
}

export function setRunView(next: RunView): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // kept for this tab only
  }
  for (const l of [...listeners]) l();
}

export const runViewNow = (): RunView => current;

export function useRunView(): RunView {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
    () => 'progress',
  );
}

export const RUN_VIEW_LABEL: Record<RunView, { label: string; hint: string }> = {
  summary: { label: 'Summary', hint: 'Just what it is doing now' },
  progress: { label: 'Progress', hint: 'Plan, counts and the answer so far' },
  trace: { label: 'Trace', hint: 'Every step, opened' },
};
