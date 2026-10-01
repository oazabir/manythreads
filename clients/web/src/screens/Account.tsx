import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '../api/client';
import { changePassword, fetchAccountSessions, fetchLinkedMethods, renameAccount, revokeAccountSession, signOut, signOutEverywhere } from '../api/endpoints';
import { useSession, useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { PlainFrame } from '../components/frames';
import { QueryView } from '../components/states';
import { Alert, Field, Notice, PasswordField, Time } from '../components/ui';

export function Account() {
  const session = useSession();
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const sessions = useQuery('account-sessions', fetchAccountSessions);
  const methods = useQuery('account-methods', fetchLinkedMethods);
  const [name, setName] = useState(session.person.name);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState(false);

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

  async function onRename(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    await run(async () => setSession(await renameAccount(name)), () => setSaved(true));
  }

  return (
    <PlainFrame title={`Account · ${session.person.name.split(' ')[0]}`}>
      {error ? <Alert>{error}</Alert> : null}

      <section className="block" aria-labelledby="acc-profile" data-landmark="profile">
        <h2 className="bh" id="acc-profile">Profile</h2>
        <div className="block-body">
          <form className="inline-form" onSubmit={onRename}>
            <Field label="Name" name="name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} autoComplete="name" />
            <button type="submit" className="btn" disabled={name.trim() === '' || name === session.person.name}>Save name</button>
            {saved ? <span className="saved" role="status">Saved</span> : null}
          </form>
          <div className="kv"><span className="k">Email</span><span>{session.person.email}</span></div>
          <div className="kv">
            <span className="k">Password</span>
            <span><button type="button" className="btn" aria-expanded={pw} onClick={() => setPw(!pw)}>Change password</button></span>
          </div>
          {pw ? <ChangePassword onDone={() => setPw(false)} /> : null}
        </div>
      </section>

      <section className="block" aria-labelledby="acc-sessions" data-landmark="sessions">
        <h2 className="bh" id="acc-sessions">Sessions</h2>
        <QueryView q={sessions}>
          {(list) => (
            <>
              <ul className="rows">
                {list.map((s) => (
                  <li key={s.id} className="srow">
                    <div>
                      <div>{s.label}{s.current ? ' (now)' : ''}</div>
                      <div className="d">Last active <Time iso={s.lastSeenAt} /></div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Sign out ${s.label}`}
                      onClick={() => run(async () => { if (s.current) await signOut(); else await revokeAccountSession(s.id); }, () => { if (s.current) leave(); else sessions.reload(); })}
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
        <h2 className="bh" id="acc-methods">Sign-in methods linked</h2>
        <QueryView q={methods}>
          {(list) => (
            <div className="block-body chips">
              {list.map((m) => (
                <span key={m.kind} className={`chip ${m.linked ? 'ok' : ''}`}>{m.label}{m.linked ? ' ok' : ' not linked'}</span>
              ))}
            </div>
          )}
        </QueryView>
      </section>
    </PlainFrame>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await changePassword({ current, next });
      setDone(true);
      setTimeout(onDone, 1200);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <form className="sub-form" onSubmit={submit} noValidate>
      <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <PasswordField label="New password" value={next} onChange={setNext} />
      {error ? <Alert>{error}</Alert> : null}
      {done ? <Notice>Password changed.</Notice> : null}
      <div className="form-actions"><button type="submit" className="btn primary">Update password</button></div>
    </form>
  );
}
