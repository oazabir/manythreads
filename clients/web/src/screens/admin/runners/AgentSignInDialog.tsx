import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAuth, AgentAuthAttempt, BotRunner } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { Dialog } from '../../../components/Dialog';
import { agentLogout, answerAgentLogin, cancelAgentLogin, fetchAgentAuth, startAgentLogin } from './api';
import { AGENT_NAME, answerBody, answerProblem, attemptWords, isLive, methodLabel, needsAnswer, pollDelayMs, signedInDoneWords, signedOutWords, statusWords } from './agent-auth';

/*
 * Sign an agent runner in or out (PLAN P25-09, docs/plans/acp.md section 4.1). The bridge tells what the person must do: open a page and enter a code, open a page and
 * paste the code it shows, or give an API key. Every method button carries the agent's own name for it. While a sign-in is under way the dialog asks again every few
 * seconds. A code or key typed here goes up once and the field is cleared at once; it is not kept in the page, and the server answers without it. Sign out asks first.
 * The page never shows an account e-mail: the server does not send one.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

type Props = { runner: BotRunner; onClose: () => void; onChanged: (text: string) => void };

export function AgentSignInDialog({ runner, onClose, onChanged }: Props) {
  const [auth, setAuth] = useState<AgentAuth | null>(null);
  const [attempt, setAttempt] = useState<AgentAuthAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [confirmOut, setConfirmOut] = useState(false);
  const working = useRef(false);
  const alive = useRef(true);
  const told = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback(
    (next: AgentAuth) => {
      if (!alive.current) return;
      setAuth(next);
      setAttempt(next.attempt);
      // a sign-in that ends well is told once to the page's status line
      if (next.attempt?.state === 'done' && told.current !== next.attempt.id) {
        told.current = next.attempt.id;
        onChanged(signedInDoneWords(runner));
      }
    },
    [onChanged, runner],
  );

  const load = useCallback(async () => {
    try {
      apply((await fetchAgentAuth(runner.id)).auth);
      if (alive.current) setError(null);
    } catch (err) {
      if (alive.current) setError(message(err));
    }
  }, [apply, runner.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // while a sign-in is under way, ask again after a pause
  useEffect(() => {
    if (!isLive(attempt)) return undefined;
    const timer = setTimeout(() => void load(), pollDelayMs(attempt));
    return () => clearTimeout(timer);
  }, [attempt, auth, load]);

  async function run(work: () => Promise<void>): Promise<void> {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (alive.current) setError(message(err));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const start = (methodId: string) =>
    run(async () => {
      const res = await startAgentLogin(runner.id, methodId);
      if (alive.current) setAttempt(res.attempt);
      await load();
    });

  const send = () =>
    run(async () => {
      if (!attempt) return;
      const body = answerBody(attempt, text);
      // gone from the page before the answer is even confirmed
      setText('');
      const res = await answerAgentLogin(runner.id, body);
      if (alive.current) setAttempt(res.attempt);
      await load();
    });

  const cancel = () =>
    run(async () => {
      setText('');
      const res = await cancelAgentLogin(runner.id, attempt?.id);
      if (alive.current) setAttempt(res.attempt);
      await load();
    });

  const signOut = () =>
    run(async () => {
      const res = await agentLogout(runner.id);
      setConfirmOut(false);
      apply(res.auth);
      onChanged(signedOutWords(runner));
    });

  const name = runner.agent === 'claude-code' || runner.agent === 'codex' ? AGENT_NAME[runner.agent] : 'The agent';
  const live = isLive(attempt);
  const asking = needsAnswer(attempt);
  const problem = answerProblem(attempt, text);
  const isKey = attempt?.action?.type === 'give_key';

  return (
    <Dialog title={`Sign-in for ${runner.label}`} onClose={onClose} wide testId="runner-agent-signin-dialog" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="rn-form">
        {auth ? (
          <p className="dlg-text" role="status" data-testid="agent-auth-status" data-state={auth.state}>{statusWords(auth)}</p>
        ) : error ? null : (
          <p className="dlg-text faint" role="status">Asking {name}.</p>
        )}
        {auth?.note ? <p className="fld-hint" data-testid="agent-auth-note">{auth.note}</p> : null}

        {attempt && attempt.state !== 'cancelled' ? (
          <div className={`rn-auth-attempt ${attempt.state === 'failed' ? 'bad' : ''}`} data-testid="agent-auth-attempt" data-state={attempt.state}>
            <p className="dlg-text" role="status">{attemptWords(attempt)}</p>
            {attempt.action && attempt.action.type !== 'give_key' ? (
              <p className="dlg-text">
                <a href={attempt.action.url} target="_blank" rel="noopener noreferrer" data-testid="agent-auth-link">Open the sign-in page</a>
              </p>
            ) : null}
            {attempt.action?.type === 'enter_code' ? (
              <p className="rn-auth-code mono" data-testid="agent-auth-code" aria-label={`The code to enter is ${attempt.action.code}`}>{attempt.action.code}</p>
            ) : null}
            {asking ? (
              <form
                className="fld"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!problem && !busy) void send();
                }}
              >
                <label htmlFor="agent-auth-answer">{isKey ? 'API key' : 'Code from the page'}</label>
                <input
                  id="agent-auth-answer"
                  type={isKey ? 'password' : 'text'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  data-autofocus=""
                  data-testid="agent-auth-answer"
                />
                <div className="rn-actions">
                  <button type="submit" className="btn primary sm" disabled={busy || problem !== null} data-testid="agent-auth-send">Send</button>
                </div>
              </form>
            ) : null}
            {live || asking ? (
              <div className="rn-actions">
                <button type="button" className="btn sm" onClick={() => void cancel()} disabled={busy} data-testid="agent-auth-cancel">Cancel the sign-in</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {auth && !live && !asking ? (
          <>
            <h3 className="rn-sub">Sign in with</h3>
            {auth.methods.length === 0 ? (
              <p className="faint" data-testid="agent-auth-no-methods">{name} offers no way to sign in from here.</p>
            ) : (
              <ul className="rn-auth-methods">
                {auth.methods.map((m) => (
                  <li key={m.id}>
                    <button type="button" className="btn sm" onClick={() => void start(m.id)} disabled={busy} data-testid="agent-auth-method" data-method={m.id}>{methodLabel(m)}</button>
                    {m.description ? <span className="fld-hint"> {m.description}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {auth && auth.state === 'signed_in' && auth.canLogout && !live ? (
          <div className="rn-actions">
            {confirmOut ? (
              <>
                <span className="dlg-text">Sign {name} out? Bots that use this runner stop until it is signed in again.</span>
                <button type="button" className="btn sm danger" onClick={() => void signOut()} disabled={busy} data-testid="agent-auth-logout-yes">Sign out</button>
                <button type="button" className="btn sm" onClick={() => setConfirmOut(false)} disabled={busy}>Stay signed in</button>
              </>
            ) : (
              <button type="button" className="btn sm" onClick={() => setConfirmOut(true)} disabled={busy} data-testid="agent-auth-logout">Sign out</button>
            )}
          </div>
        ) : null}

        {error ? <p className="dlg-error" role="alert" data-testid="agent-auth-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
