import type { Approval } from '@manythreads/shared';
import { ago } from '../../channels/format';
import { useDecision } from './useDecision';
import { AgePill } from './AgePill';
import { AskerAvatar } from './Asker';
import { riskClass, riskOf } from './risk';
import { approvalAction, approvalSentence, ASK_TOOL, COMMAND_TOOL } from './sentence';
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

export function Preview({ preview, testId = 'approval-preview' }: { preview: Approval['argsPreview']; testId?: string }) {
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

/** The words of the two buttons: a bot's own question is Yes or No, its command is Allow once or Deny, a platform approval is Approve or Deny. The one copy of them. */
export function answerWords(approval: Pick<Approval, 'source' | 'tool'>): { yes: string; no: string } {
  if (approval.source !== 'agent') return { yes: 'Approve', no: 'Deny' };
  return approval.tool === ASK_TOOL ? { yes: 'Yes', no: 'No' } : { yes: 'Allow once', no: 'Deny' };
}

/** What a bot's own question or command shows: the command in a code block, the bot's reason and details as text. */
export function AgentPreview({ approval, terse = false }: { approval: Approval; terse?: boolean }) {
  const p = approval.argsPreview as Record<string, unknown>;
  const text = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const command = text('command');
  // in a run card the question already says it is a command: a reason that only repeats that is left out
  const why = terse && /^(run|running) a command\.?$/i.test(text('why').trim()) ? '' : text('why');
  const details = text('details');
  if (command === '' && why === '' && details === '') return <Preview preview={approval.argsPreview} />;
  return (
    <div className="apr-agent" data-testid="approval-agent">
      {command !== '' ? (
        <pre className="apr-command" data-testid="approval-command"><code>{command}</code></pre>
      ) : null}
      {why !== '' ? <p className="apr-why" data-testid="approval-why">{why}</p> : null}
      {/* the bot's details are its own sentences: read as text, not as code (a command has its own block above) */}
      {details !== '' ? <p className="apr-details" data-testid="approval-details" dir="auto">{details}</p> : null}
    </div>
  );
}

/**
 * The question as a run card asks it (variant `run`): the card already says which bot and that it waits, so this is only what it wants to do. A command reads "May it run this
 * command?" over the command itself; a bot's own question is the question; anything else "May it <action>?".
 */
export function runQuestion(a: Pick<Approval, 'tool' | 'summary' | 'argsPreview' | 'source'>): string {
  if (a.tool === ASK_TOOL && typeof a.summary === 'string' && a.summary.trim() !== '') return a.summary.trim();
  if (a.tool === COMMAND_TOOL) return 'May it run this command?';
  return `May it ${approvalAction(a)}?`;
}

/**
 * "This preview is cut short": for the people who may decide, the button that opens the whole call (Yes stays disabled until it is open), and the call once open. Drawn by every
 * variant, the run card's and the channel's question strip included.
 */
export function FullCall({ approval, full, opening, openFull }: { approval: Approval; full: Record<string, unknown> | null | undefined; opening: boolean; openFull: () => Promise<void> }) {
  if (!approval.argsTruncated) return null;
  return (
    <div className="apr-truncated" data-testid="approval-truncated">
      <p className="apr-blocked">This preview is cut short.{approval.canDecide && approval.status === 'pending' ? ' Open the full call before you decide.' : ''}</p>
      {approval.canDecide && full === undefined ? (
        <button type="button" className="btn s" disabled={opening} onClick={() => void openFull()} data-testid="approval-open-full">
          {opening ? 'Opening…' : 'View full call'}
        </button>
      ) : null}
      {full !== undefined && full !== null ? <Preview preview={full as Approval['argsPreview']} testId="approval-full" /> : null}
    </div>
  );
}

/** A second answer to a question somebody already answered (another person, another tab): said in a sentence, not as an error. */
export function AnsweredLine() {
  return <p className="apr-blocked" data-testid="approval-answered" role="status">Already answered. The card updates in a moment.</p>;
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
  variant?: 'detail' | 'thread' | 'run';
}) {
  const { note, setNote, busy, error, full, opening, needsFull, answered, openFull, decide } = useDecision(approval, slug, onDecided);

  const pending = approval.status === 'pending';
  const share = isShareApproval(approval);
  const risk = riskOf(approval);
  const agent = approval.source === 'agent';
  // a bot's question is answered yes or no; the bot's program that stopped at a command is told to run it once, or not
  const { yes, no } = answerWords(approval);
  const buttons = answered ? null : (
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
  if (variant === 'run') {
    // inside a run card: the question, what it would do, and the answer; who and when are in the card's own header
    return (
      <article className="apr-card apr-card-run" data-testid="approval-card" data-approval={approval.id} data-status={approval.status} aria-label={`Question: ${runQuestion(approval)}`}>
        <p className="apr-run-q" data-testid="approval-sentence" dir="auto">{runQuestion(approval)}</p>
        {share ? <ShareApprovalPreview approval={approval} /> : agent ? <AgentPreview approval={approval} terse /> : <Preview preview={approval.argsPreview} />}
        <FullCall approval={approval} full={full} opening={opening} openFull={openFull} />
        {answered ? <AnsweredLine /> : null}
        {pending && approval.canDecide && !answered ? (
          <div className="apr-actions">
            {agent ? <input className="apr-note" type="text" placeholder="Tell the bot more (optional)" aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="approval-note" /> : null}
            {buttons}
          </div>
        ) : pending && !answered ? (
          <p className="apr-blocked" data-testid="approval-blocked" data-reason={approval.blockReason ?? ''}>
            {approval.blockReason === 'requester' ? 'You asked for this, so someone else has to decide it.' : `Waiting for ${approversLabel(approval.approvers)} to answer.`}
          </p>
        ) : null}
        {error ? <p className="apr-error" role="alert" data-testid="approval-error">{error}</p> : null}
      </article>
    );
  }
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
      {/* a bot's own question is already the sentence above ("Engineer asks: <the question>"): the raw summary would say it a second time */}
      {agent && approval.tool === ASK_TOOL ? null : <p className="apr-raw" data-testid="approval-summary">{approval.summary}</p>}
      {share ? <ShareApprovalPreview approval={approval} /> : agent ? <AgentPreview approval={approval} /> : <Preview preview={approval.argsPreview} />}
      <FullCall approval={approval} full={full} opening={opening} openFull={openFull} />

      {answered ? <AnsweredLine /> : null}
      {pending && !answered ? (
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
