import { useState } from 'react';
import type { Approval } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { ago } from '../../channels/format';
import { AgePill } from './AgePill';
import { AskerAvatar } from './Asker';
import { decideApproval } from './api';
import { announceApprovalsChanged } from './live';
import { riskClass, riskOf } from './risk';
import { approvalLine, needsOpen } from './sentence';

/*
 * One line of the Approvals list: the asker's picture, the request as one sentence, why it waits (the coloured risk tag) and how long (the age
 * pill). For a person who may decide it, Approve and Deny sit on the row — on hover or keyboard focus on a mouse screen, always on touch — so a
 * clear-cut request needs no trip into the detail. A request with more to read (a cut-short preview, or a bot's details or command) offers Open instead: nobody approves what they have not read.
 */
export function ApprovalRow({ approval: a, slug, selected, onOpen, onDecided }: { approval: Approval; slug: string; selected: boolean; onOpen: () => void; onDecided: () => void }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = a.status === 'pending';
  const risk = riskOf(a);

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await decideApproval(slug, a.id, decision, '');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not record the decision.');
      setBusy(null);
      return;
    }
    announceApprovalsChanged();
    onDecided();
    setBusy(null);
  };

  return (
    <div className="apr-row">
      <button type="button" className={`trow apr-trow ${selected ? 'on' : ''}`} onClick={onOpen} aria-current={selected ? 'true' : undefined}>
        <AskerAvatar approval={a} />
        <span className="trow-main">
          <span className="apr-sentence" data-testid="approval-row-sentence">{approvalLine(a)}</span>
          <span className="apr-tags">
            {pending ? (
              <>
                <span className={riskClass(risk)} title={risk.hint} data-testid="approval-row-risk">{risk.label}</span>
                <AgePill approval={a} />
                {a.canDecide ? <span className="sr-only">You can decide this.</span> : null}
              </>
            ) : (
              <span className="apr-done">{`${a.status} by ${a.decision?.deciderName ?? 'someone'}`}</span>
            )}
          </span>
        </span>
        {pending ? null : (
          <span className="meta">
            <span data-vt-mask>{ago(a.decision?.decidedAt ?? a.createdAt)}</span>
          </span>
        )}
      </button>
      {pending && a.canDecide ? (
        <div className="apr-row-actions" role="group" aria-label="Decide">
          {needsOpen(a) ? (
            <button type="button" className="btn s" onClick={onOpen} data-testid="approval-row-open" title="Open it to read the whole of it first.">
              Open
            </button>
          ) : (
            <>
              <button type="button" className="btn primary s" disabled={busy !== null} onClick={() => void decide('approve')} data-testid="approval-row-approve" aria-label={`Approve: ${approvalLine(a)}`}>
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button type="button" className="btn s" disabled={busy !== null} onClick={() => void decide('deny')} data-testid="approval-row-deny" aria-label={`Deny: ${approvalLine(a)}`}>
                {busy === 'deny' ? 'Denying…' : 'Deny'}
              </button>
            </>
          )}
        </div>
      ) : null}
      {error ? <p className="apr-row-error" role="alert" data-testid="approval-row-error">{error}</p> : null}
    </div>
  );
}
