import { useState } from 'react';
import type { Approval } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { ago } from '../../channels/format';
import { decideApproval, fetchApprovalArgs } from './api';
import { announceApprovalsChanged } from './live';
import { AgePill } from './AgePill';
import { AskerAvatar } from './Asker';
import { riskClass, riskOf } from './risk';
import { approvalSentence, ASK_TOOL } from './sentence';
import { ShareApprovalPreview } from './ShareApprovalPreview';
import { isShareApproval, shareKind, shareOutcomeLine } from './shareApproval';
import { callOverdue } from './state';

/*
 * One approval, wherever it is drawn: the right-hand side of the Approvals inbox and the card under a thread's replies (SPEC §7.3). It says
 * what is waiting and why, shows the clipped preview of the call (never the raw arguments), and — for the people who may decide — offers
 * Approve and Deny. The person who asked sees a plain sentence instead of the buttons: they cannot decide their own request.
 */

/** Who decides, in words: the named role tags and people, or the team's leads. */
export function approversLabel(approvers: Approval['approvers']): string {
  const parts = [...approvers.roles, ...approvers.people.map(() => 'a named person')];
  if (approvers.leads) parts.push('the team’s leads');
  return parts.join(', ');
}

/** What became of an approved call, in one sentence. */
function outcomeLine(a: Approval): string {
  if (isShareApproval(a)) return shareOutcomeLine(a);
  // a bot's own question or command (P24): the answer goes back to the bot, which carries on from it
  if (a.source === 'agent') {
    if (a.status === 'expired') return 'Nobody answered in time, so the bot was told no.';
    return a.status === 'approved' ? 'The bot has been told yes and goes on.' : 'The bot has been told no.';
  }
  if (a.status === 'denied') return 'Denied. The call was not made.';
  if (a.status === 'expired') return 'Nobody decided it in time, so it lapsed. The call was not made.';
  if (callOverdue(a)) return 'Approved, but no result came back. It may or may not have run; check before asking again.';
  if (a.outcome === 'queued' || a.outcome === 'running') return 'Approved. Running now…';
  if (a.outcome === 'ran') return a.source === 'dlp' ? 'Approved. The message went to the model as written.' : 'Approved. The call ran once, as the bot.';
  if (a.outcome === 'failed') return `Approved, but it did not run: ${a.outcomeDetail || 'the call failed'}`;
  return '';
}

function Preview({ preview, testId = 'approval-preview' }: { preview: Approval['argsPreview']; testId?: string }) {
  const entries = Object.entries(preview);
  if (entries.length === 0) return null;
  return (
    <dl className="apr-preview" data-testid={testId}>
      {entries.map(([key, value]) => (
        <div key={key} className="apr-kv">
          <dt>{key}</dt>
          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a bot's own question or command shows: the command in a code block, the bot's reason and details as text. */
function AgentPreview({ approval }: { approval: Approval }) {
  const p = approval.argsPreview as Record<string, unknown>;
  const text = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const command = text('command');
  const why = text('why');
  const details = text('details');
  if (command === '' && why === '' && details === '') return <Preview preview={approval.argsPreview} />;
  return (
    <div className="apr-agent" data-testid="approval-agent">
      {command !== '' ? (
        <pre className="apr-command" data-testid="approval-command"><code>{command}</code></pre>
      ) : null}
      {why !== '' ? <p className="apr-why" data-testid="approval-why">{why}</p> : null}
      {details !== '' ? <pre className="apr-details" data-testid="approval-details">{details}</pre> : null}
    </div>
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
  const [full, setFull] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [opening, setOpening] = useState(false);

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
  const share = isShareApproval(approval);
  const risk = riskOf(approval);
  const needsFull = approval.argsTruncated && full === undefined;
  const agent = approval.source === 'agent';
  // a bot's question is answered yes or no; the bot's program that stopped at a command is told to run it once, or not
  const yes = !agent ? 'Approve' : approval.tool === ASK_TOOL ? 'Yes' : 'Allow once';
  const no = !agent ? 'Deny' : approval.tool === ASK_TOOL ? 'No' : 'Deny';
  const buttons = (
    <>
      <button type="button" className="btn primary" disabled={busy !== null || needsFull} title={needsFull ? 'Open the full call first' : undefined} onClick={() => void decide('approve')} data-testid="approval-approve">
        {busy === 'approve' ? 'Sending…' : yes}
      </button>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide('deny')} data-testid="approval-deny">
        {busy === 'deny' ? 'Sending…' : no}
      </button>
    </>
  );
  // In the inbox the two buttons sit in the header of the detail, where the eye lands; under a thread's replies they stay at the foot of the card.
  const inHeader = variant === 'detail' && pending && approval.canDecide;
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
        {pending ? (
          <span className={riskClass(risk)} title={risk.hint} data-testid="approval-source">{risk.label}</span>
        ) : (
          <span className={`chip ${approval.status === 'denied' || approval.status === 'expired' ? 'alert' : approval.status === 'approved' ? 'ok' : 'warn'}`} data-testid="approval-source">
            {approval.status}
          </span>
        )}
        {pending ? <AgePill approval={approval} /> : <span className="apr-when" data-vt-mask>{ago(approval.createdAt)}</span>}
        {inHeader ? <div className="apr-head-actions" data-testid="approval-header-actions">{buttons}</div> : null}
      </header>
      <div className="apr-askline">
        <AskerAvatar approval={approval} />
        <h3 className="apr-sentence" data-testid="approval-sentence">{approvalSentence(approval)}</h3>
      </div>
      <p className="apr-meta">
        Asked by <b data-testid="approval-requester">{approval.requesterName}</b>
        {share ? ` · ${shareKind(approval.tool)}` : null}
      </p>
      <p className="apr-raw" data-testid="approval-summary">{approval.summary}</p>
      {share ? <ShareApprovalPreview approval={approval} /> : agent ? <AgentPreview approval={approval} /> : <Preview preview={approval.argsPreview} />}
      {approval.argsTruncated ? (
        <div className="apr-truncated" data-testid="approval-truncated">
          <p className="apr-blocked">This preview is cut short.{approval.canDecide ? ' Open the full call before you decide.' : ''}</p>
          {approval.canDecide && full === undefined ? (
            <button type="button" className="btn s" disabled={opening} onClick={() => void openFull()} data-testid="approval-open-full">
              {opening ? 'Opening…' : 'View full call'}
            </button>
          ) : null}
          {full !== undefined && full !== null ? <Preview preview={full as Approval['argsPreview']} testId="approval-full" /> : null}
        </div>
      ) : null}

      {pending ? (
        approval.canDecide ? (
          <div className="apr-actions">
            {variant === 'detail' ? (
              <input className="apr-note" type="text" placeholder={agent ? 'Tell the bot more (optional)' : 'Add a note (optional)'} aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="approval-note" />
            ) : (
              <>
                {/* what is written here goes back to the bot with the answer, so a question card keeps the box in the thread too */}
                {agent ? <input className="apr-note" type="text" placeholder="Tell the bot more (optional)" aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="approval-note" /> : null}
                {buttons}
              </>
            )}
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
          {approval.status === 'expired' ? (
            <b>Expired</b>
          ) : (
            <b>{approval.status === 'approved' ? 'Approved' : 'Denied'} by {approval.decision?.deciderName ?? 'someone'}</b>
          )}
          {approval.decision?.note ? <span className="apr-note-text"> — “{approval.decision.note}”</span> : null}
          <span className="apr-outcome" data-testid="approval-outcome"> {outcomeLine(approval)}</span>
        </p>
      )}
      {error ? <p className="apr-error" role="alert" data-testid="approval-error">{error}</p> : null}
    </article>
  );
}
