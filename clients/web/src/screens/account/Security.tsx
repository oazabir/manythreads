import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PASSWORD_MIN_LENGTH } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { changePassword, fetchSessions, requestPasswordReset, revokeSession, signOut, signOutEverywhere } from '../../api/endpoints';
import { useSession, useSessionState } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { PageHeader } from '../../components/PageHeader';
import { QueryView } from '../../components/states';
import { Alert, Field, Notice, PasswordField, PasswordToggle, Time } from '../../components/ui';
import { disablePush } from '../../notifications/push';

/** Account → Security: the password, the browsers you are signed in on, and the ways you can sign in. */
export function Security() {
  const session = useSession();
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const sessions = useQuery('account-sessions', fetchSessions);
  // an old link such as /account#acc-sessions arrives here after a redirect, which the browser does not scroll for; the three headings are drawn at once,
  // but the session list above "Sign-in methods" arrives later and pushes it down, so that one waits for the list; each hash scrolls once (a reload of the list must not pull the page back)
  const scrolledFor = useRef('');
  const listSettled = sessions.status !== 'loading';
  useEffect(() => {
    let id = '';
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return; // a malformed %-sequence in a hand-typed link: nothing to scroll to
    }
    if (id !== 'acc-password' && id !== 'acc-sessions' && id !== 'acc-methods') return;
    if (scrolledFor.current === id || (id === 'acc-methods' && !listSettled)) return;
    scrolledFor.current = id;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hash, listSettled]);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [currentShown, setCurrentShown] = useState(false);
  const [next, setNext] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNote, setPwNote] = useState<string | null>(null);

  const leave = () => {
    setSession(null);
    navigate('/sign-in', { replace: true });
  };

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwNote(null);
    setPwBusy(true);
    try {
      const { revokedSessions } = await changePassword({ currentPassword: current, newPassword: next });
      setChanging(false);
      setCurrent('');
      setNext('');
      setPwNote(
        revokedSessions === 0
          ? 'Password changed.'
          : `Password changed. ${revokedSessions} other ${revokedSessions === 1 ? 'session was' : 'sessions were'} signed out.`,
      );
      sessions.reload();
    } catch (err) {
      setPwError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setPwBusy(false);
    }
  }

  const hasPassword = session.methods.some((m) => m.kind === 'password');

  return (
    <>
      <PageHeader title="Security" description="Your password, the browsers you are signed in on, and how you can sign in." />
      {error ? <Alert>{error}</Alert> : null}

      {hasPassword ? (
        <section className="block" aria-labelledby="acc-password" data-landmark="password">
          <h2 className="bh" id="acc-password">Password</h2>
          <div className="block-body">
            <div className="kv">
              <span className="k">Password</span>
              <span>
                <button type="button" className="btn" aria-expanded={changing} onClick={() => { setChanging((v) => !v); setPwError(null); setPwNote(null); }}>
                  Change password
                </button>{' '}
                <button type="button" className="btn quiet" onClick={() => run(() => requestPasswordReset(session.person.email), () => setResetSent(true))}>
                  Email me a reset link
                </button>
              </span>
            </div>
            {changing ? (
              <form className="sub-form" onSubmit={savePassword} noValidate aria-label="Change password">
                <Field
                  label="Current password"
                  type={currentShown ? 'text' : 'password'}
                  className="has-toggle"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  suffix={<PasswordToggle shown={currentShown} onToggle={() => setCurrentShown((v) => !v)} />}
                />
                <PasswordField label="New password" value={next} onChange={setNext} />
                <p className="note-row">Your other sessions are signed out when the password changes. Use at least {PASSWORD_MIN_LENGTH} characters.</p>
                {pwError ? <Alert>{pwError}</Alert> : null}
                <div className="form-actions">
                  <button type="submit" className="btn primary" disabled={pwBusy || current === '' || next.length < PASSWORD_MIN_LENGTH}>Update password</button>
                  <button type="button" className="btn quiet" onClick={() => { setChanging(false); setCurrent(''); setNext(''); setPwError(null); }}>Cancel</button>
                </div>
              </form>
            ) : null}
            {pwNote ? <Notice>{pwNote}</Notice> : null}
            {resetSent ? <Notice>A link to choose a new password is on its way to {session.person.email}.</Notice> : null}
          </div>
        </section>
      ) : null}

      <section className="block" aria-labelledby="acc-sessions" data-landmark="sessions">
        <h2 className="bh" id="acc-sessions">Sessions</h2>
        <QueryView q={sessions}>
          {({ sessions: list }) => (
            <>
              <ul className="rows">
                {list.map((s) => (
                  <li key={s.id} className="srow" data-current={s.current || undefined}>
                    <div>
                      <div>{s.label}{s.current ? ' (this browser)' : ''}</div>
                      <div className="d">Last active <Time iso={s.lastSeenAt} /></div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Sign out ${s.label}${s.current ? ' (this browser)' : ''}`}
                      onClick={() => run(async () => { if (s.current) { await disablePush(); await signOut(); } else await revokeSession(s.id); }, () => { if (s.current) leave(); else sessions.reload(); })}
                    >
                      Sign out
                    </button>
                  </li>
                ))}
              </ul>
              <div className="block-body">
                <button type="button" className="btn" onClick={() => run(signOutEverywhere, leave)}>Sign out everywhere</button>
              </div>
            </>
          )}
        </QueryView>
      </section>

      <section className="block" aria-labelledby="acc-methods" data-landmark="methods">
        <h2 className="bh" id="acc-methods">Sign-in methods</h2>
        <div className="block-body chips">
          {session.methods.map((m) => (
            <span key={`${m.kind}-${m.label}`} className="chip ok">{m.label} ok</span>
          ))}
        </div>
      </section>
    </>
  );
}
