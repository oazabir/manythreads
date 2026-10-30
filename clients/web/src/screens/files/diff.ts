import { lineDiff as sharedLineDiff } from '@manythreads/shared';
import type { FileDiff } from './model';

/*
 * A line diff for the mock store and for the History panel's own use (the server answers with hunks; this builds the same shape from two
 * texts). The algorithm lives in @manythreads/shared (a proposal's diff is made with it too); this adds the status the panel reads.
 */

export function lineDiff(before: string | null, after: string | null): FileDiff {
  const { additions, deletions, hunks } = sharedLineDiff(before, after);
  const status = before === null && after !== null ? 'added' : before !== null && after === null ? 'deleted' : additions + deletions === 0 ? 'unchanged' : 'modified';
  return { status, binary: false, additions, deletions, hunks, truncated: false };
}
