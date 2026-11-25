import { useEffect, useId, useRef, useState } from 'react';
import { MEETING_ASK_QUESTION_MAX } from '@manythreads/shared';
import { askHeading, assistantStore, catchUpLabel, offerCatchUp, type AssistantSnapshot } from './assistant';
import { CatchUpIcon } from './icons';

/*
 * The meeting assistant in the call bar (P17-06, docs/plans/meeting-assistant.md). The panel: Catch me up at the top, then a box to ask a question about the call (the room's
 * note-taker answers when there is one, else Brain), then this person's questions with their answers. Answers are posted in the call's thread as well, so the panel offers
 * the thread. On a phone the panel is a block in the call sheet, full width.
 */

function CatchUpBlock({ snap }: { snap: AssistantSnapshot }) {
  const s = assistantStore();
  const c = snap.catchUp;
  const status = snap.status?.catchUp;
  if (c.kind === 'writing') {
    return (
      <p className="call-asst-catchup" role="status" data-testid="assistant-catchup" data-state="writing">
        Writing a summary of what was said before you joined…
      </p>
    );
  }
  if (c.kind !== 'idle') {
    return (
      <div className="call-asst-catchup" role="status" data-testid="assistant-catchup" data-state={c.kind}>
        {c.kind === 'ready' ? <b className="call-asst-sub">What was said before you joined</b> : null}
        <p className="call-asst-text" data-testid="assistant-catchup-text">{c.text}</p>
        <button type="button" className="btn s" onClick={() => s.dismissCatchUp()} data-testid="assistant-catchup-close">Close</button>
      </div>
    );
  }
  if (!status) return null;
  return status.available ? (
    <button type="button" className="btn s call-asst-catchup-btn" onClick={() => void s.catchUp()} data-testid="assistant-catchup-btn">
      <CatchUpIcon />
      <span>{catchUpLabel(status.minutesBefore)}</span>
    </button>
  ) : (
    <p className="call-hint" data-testid="assistant-catchup-reason">{status.reason}</p>
  );
}

export function AssistantPanel({ snap, onOpenThread, canOpenThread }: { snap: AssistantSnapshot; onOpenThread: () => void; canOpenThread: boolean }) {
  const s = assistantStore();
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const ids = { box: useId(), head: useId() };
  const ask = snap.status?.ask;
  useEffect(() => {
    if (ask?.available) box.current?.focus();
  }, [ask?.available]);
  const send = async (): Promise<void> => {
    if (sending || question.trim() === '') return;
    setSending(true);
    const ok = await s.ask(question);
    setSending(false);
    if (ok) setQuestion('');
  };
  return (
    <section
      className="call-asst"
      role="dialog"
      aria-labelledby={ids.head}
      data-testid="assistant-panel"
      onKeyDown={(e) => {
        // Esc closes the panel and gives the keyboard back to the Ask button in the bar
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        s.setOpen(false);
        document.querySelector<HTMLElement>('[data-testid="call-assistant"]')?.focus();
      }}
    >
      <div className="call-asst-head">
        <b id={ids.head} className="call-asst-title">{askHeading(ask?.answerer)}</b>
        <button type="button" className="btn s" onClick={() => s.setOpen(false)} data-testid="assistant-close">Close</button>
      </div>
      <CatchUpBlock snap={snap} />
      {snap.status === null ? (
        <p className="call-hint" role="status">Loading…</p>
      ) : ask?.available ? (
        <form
          className="call-asst-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor={ids.box}>Your question about this call</label>
          <textarea
            id={ids.box}
            ref={box}
            className="call-asst-box"
            rows={2}
            maxLength={MEETING_ASK_QUESTION_MAX}
            placeholder="Ask about this call…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            data-testid="assistant-question"
          />
          <button type="submit" className="btn primary s" disabled={sending || question.trim() === ''} data-testid="assistant-ask">Ask</button>
        </form>
      ) : (
        <p className="call-hint" data-testid="assistant-ask-reason">{ask?.reason}</p>
      )}
      {snap.error ? <p className="call-asst-error" role="alert" data-testid="assistant-error">{snap.error}</p> : null}
      {snap.asks.length > 0 ? (
        <ol className="call-asst-list" aria-label="Your questions in this call" data-testid="assistant-asks">
          {snap.asks.map((a) => (
            <li key={a.key} className="call-asst-item" data-state={a.state} data-testid="assistant-ask-item">
              <span className="call-asst-q">{a.question}</span>
              {a.state === 'asking' ? (
                <span className="call-asst-wait" role="status">{`${a.answererName} is looking…`}</span>
              ) : (
                <p className={`call-asst-text ${a.state === 'failed' ? 'failed' : ''}`} data-testid="assistant-answer">{a.text}</p>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="call-hint call-asst-foot">
        <span>Answers are also posted in the call’s thread.</span>
        {canOpenThread ? (
          <button type="button" className="linkish" onClick={onOpenThread} data-testid="assistant-open-thread">Open the thread</button>
        ) : null}
      </p>
    </section>
  );
}

/** The bar's own offer to someone who came late: "You joined 12 minutes in. Catch me up". Gone once they asked or closed it. */
export function CatchUpOffer({ snap }: { snap: AssistantSnapshot }) {
  const [closed, setClosed] = useState(false);
  if (closed || !offerCatchUp(snap) || snap.open) return null;
  const minutes = snap.status?.catchUp.minutesBefore ?? 0;
  const s = assistantStore();
  return (
    <div className="call-asst-offer" role="status" data-testid="assistant-catchup-offer">
      <span className="call-asst-offer-text">{`You joined ${minutes} minutes in.`}</span>
      <button
        type="button"
        className="btn primary s"
        onClick={() => {
          s.setOpen(true);
          void s.catchUp();
        }}
        data-testid="assistant-catchup-offer-btn"
      >
        Catch me up
      </button>
      <button type="button" className="btn s" onClick={() => setClosed(true)} data-testid="assistant-catchup-offer-close">Not now</button>
    </div>
  );
}
