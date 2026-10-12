import { useState } from 'react';
import type { Approval, ApprovalSource } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { ago } from '../../channels/format';
import { decideApproval } from './api';
import { announceApprovalsChanged } from './live';

/*
 * One approval, wherever it is drawn: the right-hand side of the Approvals inbox and the card under a thread's replies (SPEC §7.3). It says
 * what is waiting and why, shows the clipped preview of the call (never the raw arguments), and — for the people who may decide — offers
 * Approve and Deny. The person who asked sees a plain sentence instead of the buttons: they cannot decide their own request.
 */

const SOURCE_LABEL: Record<ApprovalSource, string> = {
  grant: 'needs approval',
  dlp: 'held by the guard',
  environment: 'protected environment',
  dispatch: 'strict dispatch',
};

/** Who decides, in words: the named role tags and people, or the team's leads. */
export function approversLabel(approvers: Approval['approvers']): string {
  const parts = [...approvers.roles, ...approvers.people.map(() => 'a named person')];
  if (approvers.leads) parts.push('the team’s leads');
  return parts.join(', ');
}

/** What became of an approved call, in one sentence. */
function outcomeLine(a: Approval): string {
  if (a.status === 'denied') return 'Denied. The call was not made.';
  if (a.outcome === 'queued') return 'Approved. Running now…';
  if (a.outcome === 'ran') return a.source === 'dlp' ? 'Approved. The message went to the model as written.' : 'Approved. The call ran once, as the bot.';
  if (a.outcome === 'failed') return `Approved, but it did not run: ${a.outcomeDetail || 'the call failed'}`;
  return '';
}

function Preview({ preview }: { preview: Approval['argsPreview'] }) {
  const entries = Object.entries(preview);
  if (entries.length === 0) return null;
  return (
    <dl className="apr-preview" data-testid="approval-preview">
      {entries.map(([key, value]) => (
        <div key={key} className="apr-kv">
          <dt>{key}</dt>
          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalCard({
  approval,
  slug,
  onDecided,
  variant = 'detail',
}: {
  approval: Approval;
  slug: string;
  onDecided?: (approval: Approval) => void;
  variant?: 'detail' | 'thread';
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await decideApproval(slug, approval.id, decision, note);
      announceApprovalsChanged();
      onDecided?.(res.approval);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

  const pending = approval.status === 'pending';
  const who = approval.botName ?? 'A bot';
  return (
    <article
      className={`apr-card ${variant === 'thread' ? 'apr-card-thread' : ''}`}
      data-testid="approval-card"
      data-approval={approval.id}
      data-status={approval.status}
      data-outcome={approval.outcome}
      aria-label={`Approval: ${approval.summary}`}
    >
      <header className="apr-head">
        <span className={`chip ${approval.status === 'denied' ? 'alert' : approval.status === 'approved' ? 'ok' : 'warn'}`} data-testid="approval-source">
          {pending ? SOURCE_LABEL[approval.source] : approval.status}
        </span>
        <b className="apr-who">{who}</b>
        <span className="apr-when" data-vt-mask>{ago(approval.createdAt)}</span>
      </header>
      <h3 className="apr-summary" data-testid="approval-summary">{approval.summary}</h3>
      <p className="apr-meta">
        Asked by <b data-testid="approval-requester">{approval.requesterName}</b> · <span className="apr-mono">{approval.tool}</span>
      </p>
      <Preview preview={approval.argsPreview} />

      {pending ? (
        approval.canDecide ? (
          <div className="apr-actions">
            {variant === 'detail' ? (
              <input className="apr-note" type="text" placeholder="Add a note (optional)" aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="approval-note" />
            ) : null}
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void decide('approve')} data-testid="approval-approve">
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide('deny')} data-testid="approval-deny">
              {busy === 'deny' ? 'Denying…' : 'Deny'}
            </button>
          </div>
        ) : (
          <p className="apr-blocked" data-testid="approval-blocked" data-reason={approval.blockReason ?? ''}>
            {approval.blockReason === 'requester'
              ? 'You asked for this, so someone else has to decide it.'
              : `Waiting for ${approversLabel(approval.approvers)}.`}
          </p>
        )
      ) : (
        <p className="apr-state" data-testid="approval-state" data-status={approval.status}>
          <b>{approval.status === 'approved' ? 'Approved' : 'Denied'} by {approval.decision?.deciderName ?? 'someone'}</b>
          {approval.decision?.note ? <span className="apr-note-text"> — “{approval.decision.note}”</span> : null}
          <span className="apr-outcome" data-testid="approval-outcome"> {outcomeLine(approval)}</span>
        </p>
      )}
      {error ? <p className="apr-error" role="alert" data-testid="approval-error">{error}</p> : null}
    </article>
  );
}
