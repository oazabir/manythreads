import { useEffect, useState } from 'react';
import type { Approval } from '@manythreads/shared';
import { AgentPreview, AnsweredLine, FullCall, Preview, answerWords, approversLabel, runQuestion } from '../screens/approvals/ApprovalCard';
import { fetchThreadApprovals } from '../screens/approvals/api';
import { useDecision } from '../screens/approvals/useDecision';
import { ShareApprovalPreview } from '../screens/approvals/ShareApprovalPreview';
import { isShareApproval } from '../screens/approvals/shareApproval';
import { approvalSentence, ASK_TOOL } from '../screens/approvals/sentence';

/** The sentence the strip asks: a bot's own question or command in the run-card words, a platform approval in the inbox's. */
export const stripQuestion = (a: Approval): string => (a.source === 'agent' ? runQuestion(a) : approvalSentence(a));

/** "Already answered by Nadia": one read of the thread's questions, only after a second answer lost the race. Falls back to the plain line. */
function AnsweredBy({ rootId, approvalId }: { rootId: string; approvalId: string }) {
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchThreadApprovals(rootId)
      .then((r) => {
        const name = r.items.find((a) => a.id === approvalId)?.decision?.deciderName;
        if (live && name) setWho(name);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rootId, approvalId]);
  if (who === null) return <AnsweredLine />;
  return <p className="apr-blocked" data-testid="approval-answered" role="status">Already answered by {who}.</p>;
}

/**
 * One question that waits, drawn as a strip ("Needs you · Deploy commit 6456bfd to the test site?" with its two buttons). The same decide path as every other card
 * (`useDecision`: 403, 409 "Already answered", the "View full call" rule); only the look is smaller. A person who may not decide it sees who can.
 */
function Strip({ approval, slug, rootId, onDecided }: { approval: Approval; slug: string; rootId: string; onDecided: () => void }) {
  const { busy, error, full, opening, needsFull, answered, openFull, decide } = useDecision(approval, slug, () => onDecided());
  const words = answerWords(approval);
  const agent = approval.source === 'agent';
  return (
    <article className="tvStrip" data-testid="tv-question" data-approval={approval.id} aria-label={`Needs you: ${stripQuestion(approval)}`}>
      <div className="tvStripMain">
        <span className="tvNeeds">Needs you</span>
        <span className="tvAsk" dir="auto" data-testid="tv-question-text">{stripQuestion(approval)}</span>
      </div>
      {agent ? (approval.tool !== ASK_TOOL ? <AgentPreview approval={approval} terse /> : null) : isShareApproval(approval) ? <ShareApprovalPreview approval={approval} /> : <Preview preview={approval.argsPreview} />}
      <FullCall approval={approval} full={full} opening={opening} openFull={openFull} />
      {answered ? <AnsweredBy rootId={rootId} approvalId={approval.id} /> : null}
      {!answered && approval.canDecide ? (
        <div className="tvStripActs">
          <button type="button" className="btn primary" disabled={busy !== null || needsFull} title={needsFull ? 'Open the full call first' : undefined} onClick={() => void decide('approve')} data-testid="tv-question-yes">
            {busy === 'approve' ? 'Sending…' : words.yes}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide('deny')} data-testid="tv-question-no">
            {busy === 'deny' ? 'Sending…' : words.no}
          </button>
        </div>
      ) : null}
      {!answered && !approval.canDecide ? (
        <p className="apr-blocked" data-testid="tv-question-blocked" data-reason={approval.blockReason ?? ''}>
          {approval.blockReason === 'requester' ? 'You asked for this, so someone else has to decide it.' : `Waiting for ${approversLabel(approval.approvers)} to answer.`}
        </p>
      ) : null}
      {error ? <p className="apr-error" role="alert" data-testid="tv-question-error">{error}</p> : null}
    </article>
  );
}

/** The questions waiting under one root: the oldest first, with "N more" for the rest (two or three at once is rare, and each is answered in place). */
export function QuestionStrip({ questions, slug, rootId, onDecided, limit = 1 }: { questions: readonly Approval[]; slug: string; rootId: string; onDecided: () => void; limit?: number }) {
  const [all, setAll] = useState(false);
  if (questions.length === 0) return null;
  const shown = all ? questions : questions.slice(0, limit);
  const rest = questions.length - shown.length;
  return (
    <div className="tvStrips" data-testid="tv-questions">
      {shown.map((a) => <Strip key={a.id} approval={a} slug={slug} rootId={rootId} onDecided={onDecided} />)}
      {rest > 0 || (all && questions.length > limit) ? (
        <button type="button" className="tvLink" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="tv-questions-more">
          {all ? 'Show fewer questions' : `${rest} more ${rest === 1 ? 'question' : 'questions'}`}
        </button>
      ) : null}
    </div>
  );
}
