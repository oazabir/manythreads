import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '../api/client';
import { changePassword, fetchSessions, requestPasswordReset, revokeSession, signOut, signOutEverywhere, updateAccount } from '../api/endpoints';
import { useSession, useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { PlainFrame } from '../components/frames';
import { QueryView } from '../components/states';
import { Alert, Field, Notice, PasswordField, Time } from '../components/ui';
import { PASSWORD_MIN_LENGTH } from '@manythreads/shared';

export function Account() {
  const session = useSession();
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const sessions = useQuery('account-sessions', fetchSessions);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [name, setName] = useState(session.person.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
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

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameNote(null);
    setNameBusy(true);
    try {
      const { person } = await updateAccount({ displayName: name });
      setSession({ ...session, person: { ...session.person, name: person.name } });
      setName(person.name);
      setNameNote('Name saved.');
    } catch (err) {
      setNameError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setNameBusy(false);
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
    <PlainFrame title={`Account · ${session.person.name.split(' ')[0]}`}>
      {error ? <Alert>{error}</Alert> : null}

      <section className="block" aria-labelledby="acc-profile" data-landmark="profile">
        <h2 className="bh" id="acc-profile">Profile</h2>
        <div className="block-body">
          <form className="inline-form" onSubmit={saveName} noValidate>
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
            <button type="submit" className="btn primary" disabled={nameBusy || name.trim() === '' || name.trim() === session.person.name}>Save name</button>
          </form>
          {nameError ? <Alert>{nameError}</Alert> : null}
          {nameNote ? <Notice>{nameNote}</Notice> : null}
          <div className="kv"><span className="k">Email</span><span>{session.person.email}</span></div>
          <div className="kv"><span className="k">Workspace</span><span>{session.workspace.name} · {session.role}</span></div>
          {hasPassword ? (
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
          ) : null}
          {changing ? (
            <form className="sub-form" onSubmit={savePassword} noValidate aria-label="Change password">
              <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
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
                      onClick={() => run(async () => { if (s.current) await signOut(); else await revokeSession(s.id); }, () => { if (s.current) leave(); else sessions.reload(); })}
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
    </PlainFrame>
  );
}
