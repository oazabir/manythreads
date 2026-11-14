import type { ChannelMessage, RunHead } from '@manythreads/shared';
import { runEnded } from './words';

/*
 * Where each run's card goes in a thread (PLAN P25-11): a run that is going is one card at the bottom, where its answer will land; a run that is over leaves one quiet line
 * under its last message (the answer, or the failure notice, which the platform stamps with the run's id); with no such message, under the last message that was written
 * before the run ended.
 */

type Placeable = Pick<ChannelMessage, 'id' | 'createdAt' | 'meta'>;

export interface Placed {
  /** Runs that are going, oldest first. */
  live: RunHead[];
  /** Ended runs by the id of the message they sit under. */
  after: Map<string, RunHead[]>;
  /** Ended runs that began before any reply: under the root message. */
  atRoot: RunHead[];
  /** Runs that left a failure notice in the thread. */
  noticed: Set<string>;
}

export function placeRuns(items: readonly Placeable[], runs: readonly RunHead[]): Placed {
  const out: Placed = { live: [], after: new Map(), atRoot: [], noticed: new Set() };
  const sorted = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const run of sorted) {
    if (!runEnded(run.state)) {
      out.live.push(run);
      continue;
    }
    let anchor: Placeable | undefined;
    for (const m of items) {
      if (m.meta.runId === run.runId) {
        anchor = m;
        if (m.meta.runFailure !== undefined) out.noticed.add(run.runId);
      }
    }
    if (anchor === undefined) {
      const end = run.endedAt !== null ? Date.parse(run.endedAt) : Date.now();
      for (const m of items) if (Date.parse(m.createdAt) <= end) anchor = m;
    }
    if (anchor === undefined) out.atRoot.push(run);
    else out.after.set(anchor.id, [...(out.after.get(anchor.id) ?? []), run]);
  }
  return out;
}
