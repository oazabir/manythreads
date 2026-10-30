import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { BotTestResult, BotTestStarted, ChannelMessage } from '@manythreads/shared';
import { fetchThread } from '../../api/endpoints';
import { AnswerMessage } from '../../channels/AnswerMessage';
import { Markdown } from '../../channels/MessageMarkdown';
import { fetchBotTest, startBotTest } from './api';
import { GIVE_UP_MS, POLL_MS, QUESTION_MAX, interceptLine, isFinished, knowledgeNote, questionProblem, startFailureText, statusNote, tookTooLong } from './test-run';

/*
 * The Test panel on the bot page (PLAN P7-11): a team lead or workspace admin types one question, the bot answers in their own conversation with it,
 * and every write it tried on the way is listed here as "not done — rehearsal". The panel never says a write was held back by itself: it shows the
 * list the server kept. While the answer is awaited it asks how the test stands every two seconds.
 */

type Phase =
  | { at: 'idle' }
  | { at: 'starting' }
  | { at: 'waiting'; started: BotTestStarted; since: number }
  | { at: 'done'; started: BotTestStarted; result: BotTestResult; replies: ChannelMessage[] };

function Replies({ replies, teamSlug }: { replies: ChannelMessage[]; teamSlug: string }) {
  if (replies.length === 0) return null;
  return (
    <div className="b-test-answer" data-testid="test-answer">
      {replies.map((m) => (
        <div className="b-test-reply" key={m.id}>
          {m.meta.answer ? <AnswerMessage payload={m.meta.answer} teamSlug={teamSlug} /> : <div className="txt"><Markdown source={m.body} teamSlug={teamSlug} /></div>}
        </div>
      ))}
    </div>
  );
}

function NotDone({ result }: { result: BotTestResult }) {
  if (result.intercepted.length === 0) return null;
  return (
    <section className="b-test-held" aria-label="Writes that were not done" data-testid="test-held">
      <h3 className="b-test-held-h">Not done — rehearsal</h3>
      <p className="d">The bot tried these. Nothing was changed.</p>
      <ul className="b-test-held-list">
        {result.intercepted.map((i) => {
          const line = interceptLine(i);
          return (
            <li className="b-test-held-row" key={i.seq} data-testid="test-intercepted">
              <span className="b-test-badge">not done — rehearsal</span>
              <span className="b-test-held-what">{line.label}</span>
              {line.label !== line.tool ? <code className="b-test-held-tool">{line.tool}</code> : null}
              {line.target ? <span className="b-test-held-target">{line.target}</span> : null}
              {line.wait ? <span className="d">{line.wait}</span> : null}
            </li>
          );
        })}
      </ul>
      {result.interceptedMore ? <p className="d" data-testid="test-held-more">And more writes after these. Only the first {result.intercepted.length} are listed.</p> : null}
    </section>
  );
}

export function BotTestPanel({ slug, botSlug, botName, onClose }: { slug: string; botSlug: string; botName: string; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // ask how the test stands until it has an end; then read the answer from the thread
  const waiting = phase.at === 'waiting' ? phase : null;
  useEffect(() => {
    if (!waiting) return undefined;
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const result = await fetchBotTest(slug, botSlug, waiting.started.messageId);
        if (!live) return;
        if (isFinished(result.status)) {
          let replies: ChannelMessage[] = [];
          try {
            const thread = await fetchThread(waiting.started.messageId);
            replies = [...thread.replies.items].reverse();
          } catch {
            replies = [];
          }
          if (live) setPhase({ at: 'done', started: waiting.started, result, replies });
          return;
        }
        setSlow(tookTooLong(waiting.since, Date.now()));
      } catch {
        // a missed look is not a failed test: ask again on the next tick
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [waiting, slug, botSlug]);

  const busy = phase.at === 'starting' || phase.at === 'waiting';
  const submit = async (): Promise<void> => {
    const why = questionProblem(question);
    if (why) {
      setProblem(why);
      return;
    }
    setProblem(null);
    setSlow(false);
    setPhase({ at: 'starting' });
    try {
      const started = await startBotTest(slug, botSlug, question.trim());
      setPhase({ at: 'waiting', started, since: Date.now() });
    } catch (e) {
      setPhase({ at: 'idle' });
      setProblem(startFailureText(e));
    }
  };

  const again = (): void => {
    setPhase({ at: 'idle' });
    setQuestion('');
    setProblem(null);
    setSlow(false);
    window.setTimeout(() => input.current?.focus(), 0);
  };

  const done = phase.at === 'done' ? phase : null;
  return (
    <section className="b-test" aria-label={`Test ${botName}`} data-testid="test-panel">
      <div className="b-test-head">
        <h2 className="b-test-title">Test {botName}</h2>
        <button type="button" className="btn s" onClick={onClose} data-testid="test-close">Close</button>
      </div>
      <p className="d b-test-intro">
        Ask one question as you would in a conversation. The bot answers for real, with its own words and knowledge, but nothing it tries to change is done:
        every write is held back and listed below. The question stays in your own conversation with the bot.
      </p>

      <label className="b-test-lab" htmlFor="b-test-q">Your question</label>
      <textarea
        id="b-test-q"
        ref={input}
        className="b-test-q"
        rows={3}
        maxLength={QUESTION_MAX}
        value={question}
        disabled={busy}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="test-question"
      />
      <div className="b-test-bar">
        <button type="button" className="btn primary s" disabled={busy || done !== null} onClick={() => void submit()} data-testid="test-run">
          {phase.at === 'starting' ? 'Sending…' : busy ? 'Waiting for the answer…' : 'Run test'}
        </button>
        {done ? <button type="button" className="btn s" onClick={again} data-testid="test-again">Ask another</button> : null}
        <span className="d">Ctrl+Enter to send</span>
      </div>
      {problem ? <p className="b-test-problem" role="alert" data-testid="test-problem">{problem}</p> : null}
      {waiting ? (
        <p className="d" role="status" data-testid="test-waiting">
          {slow ? `${botName} is taking longer than usual (over ${Math.round(GIVE_UP_MS / 60000)} minutes). You can leave this page; the answer will be in your conversation.` : `${botName} is working on it…`}
        </p>
      ) : null}

      {done ? (
        <div className="b-test-result" data-testid="test-result" data-status={done.result.status}>
          <Replies replies={done.replies} teamSlug={slug} />
          {done.replies.length === 0 ? <p className="d" data-testid="test-no-answer">{statusNote(done.result.status) ?? 'There is no answer in the thread.'}</p> : null}
          {knowledgeNote(done.result.knowledge) ? <p className="b-test-note" data-testid="test-knowledge">{knowledgeNote(done.result.knowledge)}</p> : null}
          <NotDone result={done.result} />
          {done.result.intercepted.length === 0 && done.result.status === 'answered' ? <p className="d" data-testid="test-nothing-held">The bot tried no writes.</p> : null}
          <p className="d">
            <Link to={`/t/${slug}/bots/${botSlug}/chat`} data-testid="test-open-conversation">Open it in the conversation</Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}
