import { useState } from 'react';
import type { Approval } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { decideApproval, fetchApprovalArgs } from './api';
import { announceApprovalsChanged } from './live';

/*
 * Answering one approval, wherever its card is drawn (the inbox, a thread, a run card, the question strip under a thread's root in the channel). One copy of the rules:
 *  - the full call is opened before a cut-short preview is approved (Yes stays disabled until it is);
 *  - one answer at a time (`busy`);
 *  - a second answer to the same question (another person, another tab) is a 409 from the server: it is "Already answered", not an error, and every list on the page reads again.
 */

export type Decision = 'approve' | 'deny';

export interface UseDecision {
  note: string;
  setNote: (note: string) => void;
  busy: Decision | null;
  error: string | null;
  /** The full stored call once opened (null: the server had none to show), undefined until then. */
  full: Record<string, unknown> | null | undefined;
  opening: boolean;
  /** The preview is cut short and the full call has not been opened: Yes stays disabled. */
  needsFull: boolean;
  /** Somebody answered first: the buttons go and the line says so. */
  answered: boolean;
  openFull: () => Promise<void>;
  decide: (decision: Decision) => Promise<void>;
}

export function useDecision(approval: Approval, slug: string, onDecided?: (approval: Approval) => void): UseDecision {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [answered, setAnswered] = useState(false);

  // A clipped preview is not enough to approve on: the people who may decide open the whole call first (nothing is hidden from them but secrets).
  const openFull = async (): Promise<void> => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      setFull((await fetchApprovalArgs(slug, approval.id)).args);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not open the full call.');
    } finally {
      setOpening(false);
    }
  };

  const decide = async (decision: Decision): Promise<void> => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await decideApproval(slug, approval.id, decision, note);
      announceApprovalsChanged();
      onDecided?.(res.approval);
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        // the first answer won: show the settled card (every open list reads again) instead of an error
        setAnswered(true);
        announceApprovalsChanged();
      } else setError(isApiError(e) ? e.message : 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

  return { note, setNote, busy, error, full, opening, needsFull: approval.argsTruncated && full === undefined, answered, openFull, decide };
}
