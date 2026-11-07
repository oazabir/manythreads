import { useState } from 'react';
import type { ChatVote } from '@manythreads/shared';
import { CHAT_FEEDBACK_REASON_MAX } from '@manythreads/shared';
import { BackIcon, CopyTextIcon, NextIcon, RegenerateIcon, ThumbDownIcon, ThumbUpIcon } from '../../shell/icons';

/**
 * What a person can do with one answer, under it: copy it, ask again, move between the answers to the same message (‹ 2 / 3 ›), and give a thumb with a line of
 * why. Sharing, saving as a page and handing to a bot belong to an Answer card and are drawn by it. Every control is a real button with a name.
 */
export type ReplyActionsProps = {
  position: { at: number; of: number } | null;
  vote: ChatVote | null;
  reason: string;
  /** False while another answer is being written for this message. */
  canRegenerate: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onVote: (vote: ChatVote | null, reason: string) => void;
};

export function ReplyActions(p: ReplyActionsProps) {
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState(p.reason);
  const press = (vote: ChatVote): void => {
    if (p.vote === vote) {
      setAsking(false);
      p.onVote(null, '');
      return;
    }
    p.onVote(vote, vote === 'down' ? draft : '');
    setAsking(vote === 'down');
  };
  return (
    <div className="ch-actions" role="group" aria-label="Answer actions" data-testid="chat-reply-actions">
      {p.position ? (
        <span className="ch-variants" data-testid="chat-variants">
          <button type="button" className="ch-act" aria-label="Previous answer" disabled={p.onPrevious === null} onClick={() => p.onPrevious?.()} data-testid="chat-variant-prev"><BackIcon /></button>
          <span className="ch-variant-pos" aria-live="polite" data-testid="chat-variant-pos">{p.position.at} / {p.position.of}</span>
          <button type="button" className="ch-act" aria-label="Next answer" disabled={p.onNext === null} onClick={() => p.onNext?.()} data-testid="chat-variant-next"><NextIcon /></button>
        </span>
      ) : null}
      <button type="button" className="ch-act" aria-label="Copy the answer" title="Copy" onClick={p.onCopy} data-testid="chat-copy"><CopyTextIcon /></button>
      <button type="button" className="ch-act" aria-label="Ask again" title="Ask again" disabled={!p.canRegenerate} onClick={p.onRegenerate} data-testid="chat-regenerate"><RegenerateIcon /></button>
      <button type="button" className={`ch-act ${p.vote === 'up' ? 'on' : ''}`} aria-label="Good answer" aria-pressed={p.vote === 'up'} title="Good answer" onClick={() => press('up')} data-testid="chat-thumb-up"><ThumbUpIcon /></button>
      <button type="button" className={`ch-act ${p.vote === 'down' ? 'on' : ''}`} aria-label="Poor answer" aria-pressed={p.vote === 'down'} title="Poor answer" onClick={() => press('down')} data-testid="chat-thumb-down"><ThumbDownIcon /></button>
      {asking && p.vote === 'down' ? (
        <form
          className="ch-reason"
          onSubmit={(e) => {
            e.preventDefault();
            p.onVote('down', draft.trim());
            setAsking(false);
          }}
        >
          <input
            className="ch-reason-input"
            value={draft}
            maxLength={CHAT_FEEDBACK_REASON_MAX}
            placeholder="What was wrong? (optional)"
            aria-label="What was wrong with the answer"
            onChange={(e) => setDraft(e.target.value)}
            data-testid="chat-reason"
            autoFocus
          />
          <button type="submit" className="btn s" data-testid="chat-reason-save">Save</button>
        </form>
      ) : null}
    </div>
  );
}
