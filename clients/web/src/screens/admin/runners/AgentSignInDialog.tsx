import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAuth, AgentAuthAttempt, BotRunner } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { Dialog } from '../../../components/Dialog';
import { agentLogout, answerAgentLogin, cancelAgentLogin, fetchAgentAuth, startAgentLogin } from './api';
import { AGENT_NAME, agentOf, answerBody, isPodAgent, answerProblem, attemptWords, homeWords, isLive, logoutWords, methodLabel, needsAnswer, pollDelayMs, replaceWords, signedInDoneWords, signedOutWords, statusWords } from './agent-auth';

/*
 * Sign an agent runner in or out (PLAN P25-09, docs/plans/acp.md section 4.1). The bridge tells what the person must do: open a page and enter a code, open a page and
 * paste the code it shows, or give an API key. Every method button carries the agent's own name for it. While a sign-in is under way the dialog asks again every few
 * seconds. A code or key typed here goes up once and the field is cleared at once; it is not kept in the page, and the server answers without it. Sign out asks first, and
 * names the machine and who else loses the sign-in; so does a new sign-in that would replace one that is in place. The dialog says whether the sign-in is this profile's own or the
 * machine's shared one. The body is a plain view (`AgentSignInView`) so a test can render every state.
 * The page never shows an account e-mail: the server does not send one.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

type Props = { runner: BotRunner; onClose: () => void; onChanged: (text: string) => void; onUseFile?: () => void };

export function AgentSignInDialog({ runner, onClose, onChanged, onUseFile }: Props) {
  const [auth, setAuth] = useState<AgentAuth | null>(null);
  const [attempt, setAttempt] = useState<AgentAuthAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [confirmOut, setConfirmOut] = useState(false);
  const [confirmStart, setConfirmStart] = useState<string | null>(null);
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
      setConfirmStart(null);
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

  return (
    <Dialog title={`Sign-in for ${runner.label}`} onClose={onClose} wide testId="runner-agent-signin-dialog" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <AgentSignInView
        runner={runner}
        auth={auth}
        attempt={attempt}
        error={error}
        busy={busy}
        text={text}
        confirmOut={confirmOut}
        confirmStart={confirmStart}
        onText={setText}
        onStart={(methodId) => {
          // an account is in place: say what a new sign-in replaces before it starts
          if (auth?.state === 'signed_in' && auth.kind !== 'gateway') setConfirmStart(methodId);
          else void start(methodId);
        }}
        onStartConfirmed={(methodId) => void start(methodId)}
        onStartDeclined={() => setConfirmStart(null)}
        onSend={() => void send()}
        onCancel={() => void cancel()}
        onAskSignOut={setConfirmOut}
        onSignOut={() => void signOut()}
        {...(onUseFile ? { onUseFile } : {})}
      />
    </Dialog>
  );
}

type ViewProps = {
  runner: BotRunner;
  auth: AgentAuth | null;
  attempt: AgentAuthAttempt | null;
  error: string | null;
  busy: boolean;
  text: string;
  confirmOut: boolean;
  confirmStart: string | null;
  onText: (t: string) => void;
  onStart: (methodId: string) => void;
  onStartConfirmed: (methodId: string) => void;
  onStartDeclined: () => void;
  onSend: () => void;
  onCancel: () => void;
  onAskSignOut: (ask: boolean) => void;
  onSignOut: () => void;
  /** A pod runner only: the older way, a sign-in file the admin uploads. Kept behind this one button for the runners that still use it. */
  onUseFile?: () => void;
};

/** What the dialog shows for one state of the sign-in. No state of its own, so a test renders each state with props. */
export function AgentSignInView({ runner, auth, attempt, error, busy, text, confirmOut, confirmStart, onText, onStart, onStartConfirmed, onStartDeclined, onSend, onCancel, onAskSignOut, onSignOut, onUseFile }: ViewProps) {
  const which = agentOf(runner);
  const name = which === null ? 'The agent' : AGENT_NAME[which];
  const live = isLive(attempt);
  const asking = needsAnswer(attempt);
  const problem = answerProblem(attempt, text);
  const isKey = attempt?.action?.type === 'give_key';
  const home = auth ? homeWords(auth, runner) : '';

  return (
    <div className="rn-form">
      {auth ? (
        <p className="dlg-text" role="status" data-testid="agent-auth-status" data-state={auth.state}>{statusWords(auth)}</p>
      ) : error ? null : (
        <p className="dlg-text faint" role="status">Asking {name}.</p>
      )}
      {home ? <p className="fld-hint" data-testid="agent-auth-home" data-home={auth?.home ?? ''}>{home}</p> : null}
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
                if (!problem && !busy) onSend();
              }}
            >
              <label htmlFor="agent-auth-answer">{isKey ? 'API key' : 'Code from the page'}</label>
              <input
                id="agent-auth-answer"
                type={isKey ? 'password' : 'text'}
                value={text}
                onChange={(e) => onText(e.target.value)}
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
              <button type="button" className="btn sm" onClick={onCancel} disabled={busy} data-testid="agent-auth-cancel">Cancel the sign-in</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {auth && !live && !asking ? (
        <>
          <h3 className="rn-sub">Sign in with</h3>
          {confirmStart !== null ? (
            <div className="rn-actions" data-testid="agent-auth-replace">
              <span className="dlg-text" role="alert" data-testid="agent-auth-replace-words">{replaceWords(auth, runner)}</span>
              <button type="button" className="btn sm danger" onClick={() => onStartConfirmed(confirmStart)} disabled={busy} data-testid="agent-auth-replace-yes">Replace the account</button>
              <button type="button" className="btn sm" onClick={onStartDeclined} disabled={busy} data-testid="agent-auth-replace-no">Keep the account</button>
            </div>
          ) : null}
          {auth.methods.length === 0 ? (
            <p className="faint" data-testid="agent-auth-no-methods">{name} offers no way to sign in from here.</p>
          ) : (
            <ul className="rn-auth-methods">
              {auth.methods.map((m) => (
                <li key={m.id}>
                  <button type="button" className="btn sm" onClick={() => onStart(m.id)} disabled={busy || confirmStart !== null} data-testid="agent-auth-method" data-method={m.id}>{methodLabel(m)}</button>
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
              <span className="dlg-text" role="alert" data-testid="agent-auth-logout-words">{logoutWords(auth, runner)}</span>
              <button type="button" className="btn sm danger" onClick={onSignOut} disabled={busy} data-testid="agent-auth-logout-yes">Sign out</button>
              <button type="button" className="btn sm" onClick={() => onAskSignOut(false)} disabled={busy}>Stay signed in</button>
            </>
          ) : (
            <button type="button" className="btn sm" onClick={() => onAskSignOut(true)} disabled={busy} data-testid="agent-auth-logout">Sign out</button>
          )}
        </div>
      ) : null}

      {onUseFile && isPodAgent(runner) && !live && !asking ? (
        <p className="fld-hint">
          Older way: a sign-in file made on another machine can be uploaded instead.{' '}
          <button type="button" className="btn sm" onClick={onUseFile} disabled={busy} data-testid="agent-auth-use-file">Use a sign-in file</button>
        </p>
      ) : null}

      {error ? <p className="dlg-error" role="alert" data-testid="agent-auth-error">{error}</p> : null}
    </div>
  );
}
